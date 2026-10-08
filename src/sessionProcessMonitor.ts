interface ProcessSession {
    readonly sessionId: string;
    readonly pid: string;
    readonly host: string;
    readonly processExited: boolean;
}

interface WatchedProcess {
    readonly key: string;
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
        return owner.processExited || Boolean((this.sources.get(owner) ?? this.identities.get(this.key(owner)))?.exited);
    }

    observe(owner: Session, listener: () => void): { readonly exited: boolean; dispose(): void } {
        let source = this.sources.get(owner);
        if (!source) {
            // Capture the original PID; a restart must not redirect old viewers.
            const key = this.key(owner);
            // Native reconnects replace the transport object but keep their session ID.
            source = this.identities.get(key) ?? {
                key, pid: Number(owner.pid), exited: owner.processExited, listeners: new Set(),
            };
            this.sources.set(owner, source);
        }
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
        const source = this.sources.get(owner) ?? this.identities.get(this.key(owner));
        if (source) { this.finish(source); }
    }

    private key(owner: Session): string {
        // Session IDs identify a process lifetime even after exit clears its PID.
        return JSON.stringify([owner.host.toLowerCase(), owner.sessionId]);
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
