/** Serialize notebook writes without blocking incoming runtime events. */
export class OutputQueue {
    private pending = new Set<string>();
    private timer?: NodeJS.Timeout;
    private running?: Promise<void>;
    private disposed = false;
    private paused = 0;

    constructor(
        private update: (id: string) => Promise<void>,
        private report: (error: unknown) => void,
    ) {}

    schedule(id: string, immediate = false): void {
        if (this.disposed) {
            return;
        }
        this.pending.add(id);
        if (immediate) {
            clearTimeout(this.timer);
            this.timer = undefined;
            void this.start();
        } else if (!this.paused && !this.running && !this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.start();
            }, 40);
        }
    }

    has(id: string): boolean {
        return this.pending.has(id);
    }

    async flush(): Promise<void> {
        clearTimeout(this.timer);
        this.timer = undefined;
        while (this.running || (!this.paused && this.pending.size)) {
            await this.start();
        }
    }

    async pause(): Promise<void> {
        this.paused++;
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.running;
    }

    resume(): void {
        if (this.paused) {
            this.paused--;
        }
        void this.start();
    }

    dispose(): void {
        this.disposed = true;
        this.pending.clear();
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private start(): Promise<void> {
        if (this.running) {
            return this.running;
        }
        if (this.disposed || this.paused || !this.pending.size) {
            return Promise.resolve();
        }
        this.running = Promise.resolve()
            .then(async () => {
                while (!this.disposed && !this.paused && this.pending.size) {
                    const id = this.pending.values().next().value as string;
                    this.pending.delete(id);
                    try {
                        await this.update(id);
                    } catch (error) {
                        this.report(error);
                    }
                }
            })
            .finally(() => {
                this.running = undefined;
                if (!this.paused && this.pending.size) {
                    void this.start();
                }
            });
        return this.running;
    }
}
