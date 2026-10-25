/** One inspection in flight, with one pending invalidation for the owning session. */
export class WorkspaceRefreshScheduler<T> {
    private dirty = true;
    private revision = 0;
    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private disposed = false;

    constructor(
        private readonly read: () => Promise<T | undefined>,
        private readonly publish: (value: T) => void,
        private readonly canRefresh: () => boolean,
        private readonly report: (error: unknown) => void = () => {},
    ) {}

    invalidate(delayMs?: number): void {
        if (this.disposed) {
            return;
        }
        this.dirty = true;
        this.revision++;
        this.defer();
        if (delayMs !== undefined && this.canRefresh()) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.ensure();
            }, delayMs);
        }
    }

    /** Cancel a scheduled read, retaining its invalidation until there is demand. */
    defer(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    ensure(): Promise<void> {
        if (this.running) {
            return this.running;
        }
        if (this.disposed || !this.dirty || !this.canRefresh()) {
            return Promise.resolve();
        }
        this.defer();
        this.running = Promise.resolve()
            .then(async () => {
                while (!this.disposed && this.dirty && this.canRefresh()) {
                    const revision = this.revision;
                    this.dirty = false;
                    try {
                        const value = await this.read();
                        if (this.disposed) {
                            return;
                        }
                        if (!this.canRefresh()) {
                            this.dirty = true;
                            return;
                        }
                        if (revision === this.revision && value !== undefined) {
                            this.publish(value);
                        }
                    } catch (error) {
                        this.report(error);
                    }
                }
            })
            .finally(() => {
                this.running = undefined;
                if (!this.disposed && this.dirty && this.canRefresh()) {
                    void this.ensure();
                }
            });
        return this.running;
    }

    dispose(): void {
        this.disposed = true;
        this.defer();
    }
}
