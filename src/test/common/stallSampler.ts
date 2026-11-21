import { performance, type EventLoopUtilization } from 'perf_hooks';

/** One sampling interval; times are monotonic milliseconds since `start()`. */
interface Sample {
    atMs: number;
    /** How late this timer callback ran compared with its schedule. */
    timerLagMs: number;
    /** CPU time this process used during the interval. */
    userCpuMs: number;
    systemCpuMs: number;
    /** Share of the interval the event loop spent running callbacks. */
    eventLoopUtilization: number;
}

interface ProbeRecord {
    startMs: number;
    endMs?: number;
    result?: 'fulfilled' | 'rejected';
    /** Ticks skipped because this probe was still pending. */
    skippedBefore: number;
}

export interface StallSamplerOptions {
    intervalMs?: number;
    /** Retain at most this many samples and probes, dropping the oldest. */
    maxEntries?: number;
    /**
     * A cheap round trip to another process, such as a VS Code command that
     * the renderer handles. At most one probe is pending at a time; a tick
     * that finds one pending is counted instead of sending another.
     */
    probe?: () => PromiseLike<unknown>;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * Sample this process's timer lag, CPU time, and event loop utilization, and
 * optionally a round trip, so that a slow test can be attributed to this
 * process stalling or to the other side of a round trip. Nothing is printed;
 * callers include `snapshot()` in their failure report.
 */
export class StallSampler {
    private readonly intervalMs: number;
    private readonly maxEntries: number;
    private readonly probe?: () => PromiseLike<unknown>;
    private readonly samples: Sample[] = [];
    private readonly probes: ProbeRecord[] = [];
    private startedMono = 0;
    private startedAtUtc?: string;
    private timer?: NodeJS.Timeout;
    private expectedMs = 0;
    private lastCpu = process.cpuUsage();
    private lastElu?: EventLoopUtilization;
    private pendingProbe?: ProbeRecord;
    private skipped = 0;
    private droppedSamples = 0;
    private droppedProbes = 0;

    constructor(options: StallSamplerOptions = {}) {
        this.intervalMs = options.intervalMs ?? 1000;
        this.maxEntries = options.maxEntries ?? 900;
        this.probe = options.probe;
    }

    private now(): number {
        return performance.now() - this.startedMono;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        this.startedMono = performance.now();
        this.startedAtUtc = new Date().toISOString();
        this.lastCpu = process.cpuUsage();
        this.lastElu = performance.eventLoopUtilization();
        this.expectedMs = this.intervalMs;
        this.schedule();
    }

    stop(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(): void {
        // A one-shot timer per tick, so that a late tick shows its own lag
        // instead of an interval timer coalescing missed ticks.
        this.timer = setTimeout(() => this.tick(), Math.max(0, this.expectedMs - this.now()));
        this.timer.unref?.();
    }

    private tick(): void {
        const atMs = this.now();
        const cpu = process.cpuUsage(this.lastCpu);
        this.lastCpu = process.cpuUsage();
        const elu = performance.eventLoopUtilization(this.lastElu);
        this.lastElu = performance.eventLoopUtilization();
        this.push(this.samples, {
            atMs: round(atMs),
            timerLagMs: round(atMs - this.expectedMs),
            userCpuMs: round(cpu.user / 1000),
            systemCpuMs: round(cpu.system / 1000),
            eventLoopUtilization: round(elu.utilization * 1000) / 1000,
        });
        this.sendProbe(atMs);
        // Do not send catch-up ticks after a stall; the lag above records it.
        this.expectedMs = atMs + this.intervalMs;
        this.schedule();
    }

    private sendProbe(atMs: number): void {
        if (!this.probe) {
            return;
        }
        if (this.pendingProbe) {
            this.skipped++;
            return;
        }
        const record: ProbeRecord = { startMs: round(atMs), skippedBefore: this.skipped };
        this.skipped = 0;
        this.pendingProbe = record;
        const finish = (result: 'fulfilled' | 'rejected') => {
            record.endMs = round(this.now());
            record.result = result;
            this.pendingProbe = undefined;
            this.push(this.probes, record);
        };
        try {
            void this.probe().then(
                () => finish('fulfilled'),
                () => finish('rejected'),
            );
        } catch {
            finish('rejected');
        }
    }

    private push<T>(entries: T[], entry: T): void {
        entries.push(entry);
        if (entries.length > this.maxEntries) {
            entries.shift();
            if (entries === (this.samples as unknown[])) {
                this.droppedSamples++;
            } else {
                this.droppedProbes++;
            }
        }
    }

    snapshot(): unknown {
        return {
            pid: process.pid,
            startedAtUtc: this.startedAtUtc,
            capturedAtMs: round(this.now()),
            intervalMs: this.intervalMs,
            samples: this.samples,
            droppedSamples: this.droppedSamples,
            probes: this.probe
                ? {
                      completed: this.probes,
                      droppedProbes: this.droppedProbes,
                      pending: this.pendingProbe && {
                          ...this.pendingProbe,
                          pendingMs: round(this.now() - this.pendingProbe.startMs),
                      },
                      skippedWhilePending: this.skipped,
                  }
                : undefined,
        };
    }
}
