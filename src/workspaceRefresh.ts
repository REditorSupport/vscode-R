export interface WorkspaceRefreshOptions {
    /**
     * Delays before retrying a failed read, one per retry. An owner whose
     * readers never request a refresh uses these to recover by itself; by
     * default a failed read waits for the next demand.
     */
    retryDelaysMs?: readonly number[];
    /**
     * Whether a failure may be retried after a delay, such as not for an
     * error from the inspected code itself. Without a failure, a read that
     * returned nothing is asked about.
     */
    shouldRetry?: (error?: unknown) => boolean;
}

/** One inspection in flight, with one pending invalidation for the owning session. */
export class WorkspaceRefreshScheduler<T> {
    private dirty = true;
    private revision = 0;
    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private disposed = false;
    private retries = 0;
    /** An invalidation's scheduled read came due while another read ran. */
    private dueDuringRead = false;
    private readonly retryDelaysMs: readonly number[];
    private readonly shouldRetry: (error?: unknown) => boolean;

    constructor(
        private readonly read: () => Promise<T | undefined>,
        private readonly publish: (value: T) => void,
        private readonly canRefresh: () => boolean,
        private readonly report: (error: unknown) => void = () => {},
        options: WorkspaceRefreshOptions = {},
    ) {
        this.retryDelaysMs = options.retryDelaysMs ?? [];
        this.shouldRetry = options.shouldRetry ?? (() => true);
    }

    invalidate(delayMs?: number): void {
        if (this.disposed) {
            return;
        }
        this.dirty = true;
        this.revision++;
        this.retries = 0;
        this.defer();
        if (delayMs !== undefined && this.canRefresh()) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                if (this.running) {
                    this.dueDuringRead = true;
                }
                void this.ensure();
            }, delayMs);
        }
    }

    /** Cancel a scheduled read or retry, retaining its invalidation until there is demand. */
    defer(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.dueDuringRead = false;
    }

    ensure(): Promise<void> {
        if (this.running) {
            return this.running;
        }
        if (this.disposed || !this.dirty || !this.canRefresh()) {
            return Promise.resolve();
        }
        this.defer();
        let retryOnDemand = false;
        let failure: unknown;
        this.running = Promise.resolve()
            .then(async () => {
                while (!this.disposed && this.dirty && this.canRefresh()) {
                    const revision = this.revision;
                    this.dirty = false;
                    // This read serves any notification so far, including one
                    // whose read is scheduled but not yet due.
                    this.defer();
                    try {
                        const value = await this.read();
                        if (this.disposed) {
                            return;
                        }
                        if (value === undefined) {
                            this.dirty = true;
                            retryOnDemand = true;
                            return;
                        }
                        if (!this.canRefresh()) {
                            this.dirty = true;
                            return;
                        }
                        if (revision === this.revision) {
                            this.publish(value);
                        }
                        // After publishing, so a publisher that keeps failing
                        // uses up the retries.
                        this.retries = 0;
                    } catch (error) {
                        this.dirty = true;
                        retryOnDemand = true;
                        failure = error;
                        this.report(error);
                        return;
                    }
                }
            })
            .finally(() => {
                this.running = undefined;
                const due = this.dueDuringRead;
                this.dueDuringRead = false;
                if (this.disposed || !this.dirty) {
                    return;
                }
                // A notification that came due during a failed read is served
                // now, with the retries its invalidation restored.
                if (retryOnDemand && due) {
                    if (this.canRefresh()) {
                        void this.ensure();
                    }
                    return;
                }
                if (!retryOnDemand) {
                    if (this.canRefresh()) {
                        void this.ensure();
                    }
                    return;
                }
                // Failed reads retain the invalidation. Retry only as often as
                // configured instead of spinning here; after that, a later
                // caller or notification must request the retry.
                const delayMs = this.shouldRetry(failure)
                    ? this.retryDelaysMs[this.retries]
                    : undefined;
                // A read scheduled by an invalidation during the failed one
                // comes sooner and does not use up a retry.
                if (delayMs !== undefined && this.timer === undefined) {
                    this.timer = setTimeout(() => {
                        this.timer = undefined;
                        // A retry counts only when it can read; otherwise the
                        // next demand, such as the end of an execution, reads.
                        if (!this.disposed && this.dirty && this.canRefresh()) {
                            this.retries++;
                            void this.ensure();
                        }
                    }, delayMs);
                }
            });
        return this.running;
    }

    dispose(): void {
        this.disposed = true;
        this.defer();
    }
}
