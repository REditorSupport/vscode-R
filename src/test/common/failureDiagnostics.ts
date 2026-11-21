import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

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

/** One traced call; times are monotonic milliseconds since the diagnostics were created. */
interface CallRecord {
    id: number;
    name: string;
    startMs: number;
    endMs?: number;
    result?: 'fulfilled' | 'rejected';
}

export interface FailureDiagnosticsOptions {
    /**
     * Also write the report here with Node's file system, so that it survives
     * when console output is delivered late or the job log is truncated.
     */
    reportFile?: string;
    /** Retain at most this many completed calls; pending calls are always retained. */
    maxCalls?: number;
    /** Append at most this many calls that complete after `close()` to the report file. */
    maxLateCalls?: number;
}

/** Observe existing promises without replacing them, adding waits, or logging on success. */
export class FailureDiagnostics {
    private readonly started = Date.now();
    private readonly startedMono = performance.now();
    private readonly stages = new Map<string, Stage>();
    private readonly pendingCalls = new Map<number, CallRecord>();
    private readonly completedCalls: CallRecord[] = [];
    private readonly attachments = new Map<string, () => unknown>();
    private readonly reportFile?: string;
    private readonly maxCalls: number;
    private readonly maxLateCalls: number;
    private nextCallId = 1;
    private droppedCalls = 0;
    private lateCalls = 0;
    private closedAtMs?: number;
    private reported = false;

    constructor(
        private readonly name: string,
        private readonly snapshot: () => unknown,
        options: FailureDiagnosticsOptions = {},
    ) {
        this.reportFile = options.reportFile;
        this.maxCalls = options.maxCalls ?? 1000;
        this.maxLateCalls = options.maxLateCalls ?? 200;
    }

    private now(): number {
        return Math.round((performance.now() - this.startedMono) * 10) / 10;
    }

    /** Include another source's state in the file report, such as periodic samples. */
    attach(name: string, snapshot: () => unknown): void {
        this.attachments.set(name, snapshot);
    }

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
        const record: CallRecord = { id: this.nextCallId++, name, startMs: this.now() };
        this.pendingCalls.set(record.id, record);
        const stage = this.stages.get(name) ?? { calls: 0, pending: 0, totalMs: 0 };
        this.stages.set(name, stage);
        stage.calls++;
        stage.pending++;
        stage.pendingSince ??= started;
        const finish = (result: 'fulfilled' | 'rejected') => {
            record.endMs = this.now();
            record.result = result;
            this.pendingCalls.delete(record.id);
            this.completedCalls.push(record);
            if (this.completedCalls.length > this.maxCalls) {
                this.completedCalls.shift();
                this.droppedCalls++;
            }
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
            if (this.closedAtMs !== undefined) {
                this.recordLateCall(record);
            } else if (result === 'rejected' && reportOnReject) {
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
        const capturedAtUtc = new Date().toISOString();
        console.error(
            `[test diagnostics] ${JSON.stringify({
                test: this.name,
                elapsedMs: Date.now() - this.started,
                reportFile: this.reportFile,
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
        if (!this.reportFile) {
            return;
        }
        const attachments: Record<string, unknown> = {};
        for (const [name, snapshot] of this.attachments) {
            try {
                attachments[name] = snapshot();
            } catch (error) {
                attachments[name] = { snapshotError: String(error) };
            }
        }
        this.writeLine({
            kind: 'report',
            test: this.name,
            pid: process.pid,
            startedAtUtc: new Date(this.started).toISOString(),
            capturedAtUtc,
            capturedAtMs: this.now(),
            closedAtMs: this.closedAtMs,
            pendingCalls: [...this.pendingCalls.values()],
            completedCalls: this.completedCalls,
            droppedCalls: this.droppedCalls,
            state,
            attachments,
        });
    }

    /**
     * Mark the end of the test. A traced call that completes later belongs to
     * a body that outlived its test, so it is appended to the report file
     * instead of being reported as a new failure.
     */
    close(): void {
        this.closedAtMs ??= this.now();
    }

    /** Append to the report file after a report, such as how cleanup ended. */
    appendAfterReport(kind: string, data: unknown): void {
        if (this.reported) {
            this.writeLine({ kind, capturedAtUtc: new Date().toISOString(), data });
        }
    }

    private recordLateCall(record: CallRecord): void {
        if (!this.reported || this.lateCalls >= this.maxLateCalls) {
            return;
        }
        this.lateCalls++;
        this.writeLine({
            kind: 'late call',
            capturedAtUtc: new Date().toISOString(),
            ...record,
        });
    }

    private writeLine(entry: unknown): void {
        if (!this.reportFile) {
            return;
        }
        try {
            fs.mkdirSync(path.dirname(this.reportFile), { recursive: true });
            fs.appendFileSync(this.reportFile, `${JSON.stringify(entry)}\n`);
        } catch (error) {
            console.error(
                `[test diagnostics] Could not write ${this.reportFile}: ${String(error)}`,
            );
        }
    }
}
