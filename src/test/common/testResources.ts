interface Release {
    name: string;
    release: () => unknown;
}

/** Own test resources in dependency order, including partially acquired fixtures. */
export class TestResources<Phase extends string> {
    private readonly releases = new Map<Phase, Release[]>();
    private disposal?: Promise<void>;

    constructor(
        private readonly phases: readonly Phase[],
        private readonly timeoutMs = 15000,
        private readonly budgetMs = 50000,
    ) {}

    add(phase: Phase, name: string, release: () => unknown): void {
        const entries = this.releases.get(phase) ?? [];
        entries.push({ name, release });
        this.releases.set(phase, entries);
    }

    /** Runs once, retaining original errors alongside resource-release failures. */
    dispose(originalErrors: readonly unknown[] = []): Promise<void> {
        return (this.disposal ??= this.releaseAll(originalErrors));
    }

    private async releaseAll(originalErrors: readonly unknown[]): Promise<void> {
        const errors = [...originalErrors];
        const deadline = Date.now() + this.budgetMs;
        for (const phase of this.phases) {
            const entries = this.releases.get(phase);
            // Discovery tasks may register individual resources in this phase.
            while (entries?.length) {
                const batch = entries.splice(0);
                const results = await Promise.allSettled(
                    batch.map(({ release }) => {
                        let timer: ReturnType<typeof setTimeout>;
                        // Invoke through a promise so synchronous throws cannot skip siblings.
                        const operation = Promise.resolve().then(release);
                        const timeout = new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(
                                () =>
                                    reject(
                                        new Error(
                                            'Cleanup timed out; operation may still be running',
                                        ),
                                    ),
                                Math.max(0, Math.min(this.timeoutMs, deadline - Date.now())),
                            );
                        });
                        // The race observes late rejections too; timing out does not cancel work.
                        return Promise.race([operation, timeout]).finally(() =>
                            clearTimeout(timer),
                        );
                    }),
                );
                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        errors.push(
                            new Error(`Cleanup [${phase}] ${batch[index].name}`, {
                                cause: result.reason as unknown,
                            }),
                        );
                    }
                });
            }
        }
        if (errors.length) {
            // Mocha's reporter need not expand AggregateError.errors or Error.cause.
            // Include resource names and reasons in the visible message as well.
            const describe = (error: unknown): string => {
                if (error instanceof AggregateError) {
                    return `${error.message}: ${(error.errors as unknown[]).map(describe).join('; ')}`;
                }
                if (error instanceof Error) {
                    return error.cause === undefined
                        ? error.message
                        : `${error.message}: ${describe(error.cause)}`;
                }
                return String(error);
            };
            throw new AggregateError(
                errors,
                `Test resource cleanup failed:\n${errors.map(describe).join('\n')}`,
            );
        }
    }
}
