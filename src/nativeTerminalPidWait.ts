export type NativeTerminalPidWaitResult<Value> =
    | { readonly kind: 'resolved'; readonly value: Value; readonly isCurrent: () => boolean }
    | { readonly kind: 'invalidated'; readonly reason: 'terminal' | 'lifecycle' | 'operation' };

export interface NativeTerminalPidWaitOptions {
    readonly signal?: AbortSignal;
    readonly isEligible?: () => boolean;
}

interface NativeTerminalPidWaiter<T extends object> {
    readonly terminal: T;
    invalidate(reason: 'terminal' | 'lifecycle'): void;
}

/** Interruptible reads of VS Code's otherwise uncancellable terminal processId promise. */
export class NativeTerminalPidWaitRegistry<T extends object> {
    private lifecycleRevision = 0;
    private readonly terminalRevisions = new WeakMap<T, number>();
    private readonly waiters = new Set<NativeTerminalPidWaiter<T>>();

    public invalidate(terminal: T): void {
        this.terminalRevisions.set(terminal, this.revisionOf(terminal) + 1);
        for (const waiter of this.waiters) {
            if (waiter.terminal === terminal) { waiter.invalidate('terminal'); }
        }
    }

    public invalidateAll(): void {
        this.lifecycleRevision++;
        for (const waiter of this.waiters) { waiter.invalidate('lifecycle'); }
    }

    public waitFor<Value>(
        terminal: T,
        read: () => PromiseLike<Value> | Value,
        options: NativeTerminalPidWaitOptions = {},
    ): Promise<NativeTerminalPidWaitResult<Value>> {
        const terminalRevision = this.revisionOf(terminal);
        const lifecycleRevision = this.lifecycleRevision;

        return new Promise((resolve, reject) => {
            let settled = false;
            const isCurrent = (): boolean => !options.signal?.aborted
                && lifecycleRevision === this.lifecycleRevision
                && terminalRevision === this.revisionOf(terminal)
                && (options.isEligible?.() ?? true);
            const checkCurrent = (): boolean => {
                try { return isCurrent(); }
                catch (error) { finishError(error); return false; }
            };
            const finish = (result: NativeTerminalPidWaitResult<Value>): void => {
                if (settled) { return; }
                settled = true;
                cleanup();
                resolve(result);
            };
            const finishError = (error: unknown): void => {
                if (settled) { return; }
                settled = true;
                cleanup();
                reject(error);
            };
            const waiter: NativeTerminalPidWaiter<T> = {
                terminal,
                invalidate: reason => finish({ kind: 'invalidated', reason }),
            };
            const onAbort = () => finish({ kind: 'invalidated', reason: 'operation' });
            const cleanup = (): void => {
                this.waiters.delete(waiter);
                options.signal?.removeEventListener('abort', onAbort);
            };

            // Install invalidation listeners before reading processId: its getter may
            // synchronously trigger registration, close, or shutdown callbacks.
            this.waiters.add(waiter);
            options.signal?.addEventListener('abort', onAbort, { once: true });
            if (options.signal?.aborted) {
                onAbort();
                return;
            }
            if (lifecycleRevision !== this.lifecycleRevision) {
                finish({ kind: 'invalidated', reason: 'lifecycle' });
                return;
            }
            let eligible: boolean;
            try { eligible = options.isEligible?.() ?? true; }
            catch (error) { finishError(error); return; }
            if (terminalRevision !== this.revisionOf(terminal) || !eligible) {
                finish({ kind: 'invalidated', reason: 'terminal' });
                return;
            }

            let pending: Promise<Value>;
            try { pending = Promise.resolve(read()); }
            catch (error) { finishError(error); return; }
            // Keep a rejection observer after invalidation so the underlying VS Code
            // promise cannot become an unhandled rejection if it settles late.
            void pending.then(value => {
                if (settled) { return; }
                if (!checkCurrent()) {
                    if (settled) { return; }
                    const reason = options.signal?.aborted ? 'operation'
                        : lifecycleRevision !== this.lifecycleRevision ? 'lifecycle' : 'terminal';
                    finish({ kind: 'invalidated', reason });
                    return;
                }
                finish({ kind: 'resolved', value, isCurrent });
            }, error => {
                if (settled) { return; }
                if (!checkCurrent()) {
                    if (settled) { return; }
                    const reason = options.signal?.aborted ? 'operation'
                        : lifecycleRevision !== this.lifecycleRevision ? 'lifecycle' : 'terminal';
                    finish({ kind: 'invalidated', reason });
                    return;
                }
                finishError(error);
            });
        });
    }

    private revisionOf(terminal: T): number { return this.terminalRevisions.get(terminal) ?? 0; }
}
