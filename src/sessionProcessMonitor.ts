import { sessionProcessIdentity } from './sessionIdentity';

interface ProcessSession {
    readonly sessionId: string;
    readonly pid: string;
    readonly host: string;
    readonly processExited: boolean;
}

interface WatchedProcess {
    readonly key: string;
    readonly sessionId: string;
    readonly host: string;
    readonly pid: number;
    exited: boolean;
    readonly listeners: Set<() => void>;
}

/** Process lifetime survives transport detachment and is shared by all its viewers. */
export class SessionProcessMonitor<Session extends ProcessSession> {
    private readonly sources = new WeakMap<Session, WatchedProcess>();
    private readonly identities = new Map<string, WatchedProcess>();
    private readonly polling = new Set<WatchedProcess>();
    private timer?: NodeJS.Timeout;

    constructor(private readonly isLocalHost: (host: string) => boolean) {}

    hasExited(owner: Session): boolean {
        return owner.processExited || Boolean(this.find(owner)?.exited);
    }

    observe(owner: Session, listener: () => void): { readonly exited: boolean; dispose(): void } {
        let source = this.find(owner);
        if (!source) {
            // Capture the original PID; a restart must not redirect old viewers.
            const key = sessionProcessIdentity(owner);
            // Native reconnects replace the transport object but keep their session ID.
            source = {
                key, sessionId: owner.sessionId, host: owner.host.toLowerCase(),
                pid: Number(owner.pid), exited: owner.processExited, listeners: new Set(),
            };
        }
        this.sources.set(owner, source);
        const watched = source;
        if (owner.processExited) { this.finish(watched); }
        this.identities.set(watched.key, watched);
        watched.listeners.add(listener);
        if (!watched.exited && this.isLocalHost(owner.host) &&
            Number.isSafeInteger(watched.pid) && watched.pid > 0) {
            this.polling.add(watched);
            if (!this.timer) {
                this.timer = setInterval(() => this.poll(), 1000);
                this.timer.unref();
            }
        }
        return {
            get exited() { return watched.exited; },
            dispose: () => {
                watched.listeners.delete(listener);
                if (!watched.listeners.size) {
                    if (this.identities.get(watched.key) === watched) { this.identities.delete(watched.key); }
                    this.polling.delete(watched);
                    this.stopIdleTimer();
                }
            },
        };
    }

    /** A confirmed exit is authoritative, including for remote sessions. */
    markExited(owner: Session): void {
        const source = this.find(owner);
        if (source) { this.finish(source); }
    }

    private find(owner: Session): WatchedProcess | undefined {
        const captured = this.sources.get(owner);
        const known = this.identities.get(captured?.key ?? sessionProcessIdentity(owner)) ?? captured;
        if (known || owner.pid) { return known; }
        // An exit/reconnect may arrive after PID metadata was cleared. Resolve
        // only an unambiguous original process; never select a replacement.
        const matches = [...this.identities.values()].filter(source =>
            source.sessionId === owner.sessionId && source.host === owner.host.toLowerCase());
        return matches.length === 1 ? matches[0] : undefined;
    }

    private poll(): void {
        for (const source of this.polling) {
            try { process.kill(source.pid, 0); }
            catch (error) {
                // Permission failures and unknown errors do not prove exit.
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') { this.finish(source); }
            }
        }
    }

    private finish(source: WatchedProcess): void {
        if (source.exited) { return; }
        source.exited = true;
        this.polling.delete(source);
        this.stopIdleTimer();
        for (const listener of source.listeners) { listener(); }
    }

    private stopIdleTimer(): void {
        if (!this.polling.size) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}
