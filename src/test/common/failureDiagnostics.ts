interface Stage {
    calls: number;
    pending: number;
    totalMs: number;
    lastMs?: number;
    /** The slowest call and when it started, relative to the start of the test. */
    maxMs?: number;
    maxStartedAtMs?: number;
    pendingSince?: number;
    lastResult?: 'fulfilled' | 'rejected';
}

/** Observe existing promises without replacing them, adding waits, or logging on success. */
export class FailureDiagnostics {
    private readonly started = Date.now();
    private readonly stages = new Map<string, Stage>();
    private reported = false;

    constructor(
        private readonly name: string,
        private readonly snapshot: () => unknown,
    ) {}

    /**
     * `reportOnReject: false` is for operations the test does not await, whose
     * rejection may be handled by their caller and is not a test failure.
     */
    trace<T>(
        name: string,
        operation: () => PromiseLike<T>,
        { reportOnReject = true }: { reportOnReject?: boolean } = {},
    ): PromiseLike<T> {
        const started = Date.now();
        const stage = this.stages.get(name) ?? { calls: 0, pending: 0, totalMs: 0 };
        this.stages.set(name, stage);
        stage.calls++;
        stage.pending++;
        stage.pendingSince ??= started;
        const finish = (result: 'fulfilled' | 'rejected') => {
            stage.lastMs = Date.now() - started;
            stage.totalMs += stage.lastMs;
            if (stage.maxMs === undefined || stage.lastMs > stage.maxMs) {
                stage.maxMs = stage.lastMs;
                stage.maxStartedAtMs = started - this.started;
            }
            stage.lastResult = result;
            if (--stage.pending === 0) {
                stage.pendingSince = undefined;
            }
            if (result === 'rejected' && reportOnReject) {
                this.report();
            }
        };
        try {
            const pending = operation();
            void pending.then(
                () => finish('fulfilled'),
                () => finish('rejected'),
            );
            return pending;
        } catch (error) {
            finish('rejected');
            throw error;
        }
    }

    /** Also called from teardown: a Mocha timeout does not reject the pending operation. */
    report(): void {
        if (this.reported) {
            return;
        }
        this.reported = true;
        let state: unknown;
        try {
            state = this.snapshot();
        } catch (error) {
            state = { snapshotError: String(error) };
        }
        console.error(
            `[test diagnostics] ${JSON.stringify({
                test: this.name,
                elapsedMs: Date.now() - this.started,
                stages: [...this.stages].map(([name, stage]) => ({
                    name,
                    ...stage,
                    pendingMs:
                        stage.pendingSince === undefined
                            ? undefined
                            : Date.now() - stage.pendingSince,
                })),
                state,
            })}`,
        );
    }
}
