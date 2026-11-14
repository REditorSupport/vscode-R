/**
 * Tracks timeouts scheduled from specific modules while fake timers are installed.
 *
 * Fake timers installed in the extension host also capture timers from VS Code
 * and other extension code, so `clock.countTimers()` is not a stable leak check.
 * Install this after `useFakeTimers()` and before spying on `setTimeout`, and
 * call `restore()` before restoring the fake clock.
 */
export interface ModuleTimerTracker {
    /** Number of tracked timeouts that have neither fired nor been cleared. */
    pending(): number;
    restore(): void;
}

export function trackModuleTimers(moduleFiles: readonly string[]): ModuleTimerTracker {
    const pending = new Set<number>();
    const fakeSetTimeout = globalThis.setTimeout;
    const fakeClearTimeout = globalThis.clearTimeout;
    const tracked = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
    ) => {
        const stack = new Error().stack ?? '';
        if (!moduleFiles.some((file) => stack.includes(file))) {
            return fakeSetTimeout(callback, delay, ...args);
        }
        let id: number | undefined;
        const handle = fakeSetTimeout(
            (...callbackArgs: unknown[]) => {
                if (id !== undefined) {
                    pending.delete(id);
                }
                callback(...callbackArgs);
            },
            delay,
            ...args,
        );
        id = Number(handle);
        pending.add(id);
        return handle;
    }) as unknown as typeof setTimeout;
    const clear = ((handle?: Parameters<typeof clearTimeout>[0]) => {
        if (handle !== undefined && handle !== null) {
            pending.delete(Number(handle));
        }
        fakeClearTimeout(handle);
    }) as typeof clearTimeout;
    globalThis.setTimeout = tracked;
    globalThis.clearTimeout = clear;
    return {
        pending: () => pending.size,
        restore: () => {
            if (globalThis.setTimeout === tracked) {
                globalThis.setTimeout = fakeSetTimeout;
            }
            if (globalThis.clearTimeout === clear) {
                globalThis.clearTimeout = fakeClearTimeout;
            }
        },
    };
}
