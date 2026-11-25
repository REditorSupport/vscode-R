import fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TerminalStartupRecord } from './terminalStartup';

const recordName = /^[a-f0-9]{32}\.json\.startup$/i;
const pollMs = 2_000;
const fullPollMs = 60_000;

interface Snapshot {
    stamp: string;
    record?: TerminalStartupRecord;
}

function stamp(stat: fs.BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
}

/** Watch atomic terminal startup publications. Polling also works on filesystems
 * which omit filenames or silently drop notifications. Each instance owns one
 * extension-host lifetime and serializes record inspection and publication. */
export class TerminalStartupMonitor {
    private readonly stopped = new AbortController();
    private watcher?: fs.FSWatcher;
    private watchedDirectory?: string;
    private retry?: NodeJS.Timeout;
    private interval?: NodeJS.Timeout;
    private retryMs = 250;
    private scanRequested = false;
    private forceScan = false;
    private readonly named = new Set<string>();
    private readonly seen = new Map<string, Snapshot>();
    private directoryStamp?: string;
    private lastFullScan = 0;
    private running?: Promise<void>;

    constructor(
        private readonly directory: string,
        private readonly read: (file: string) => Promise<TerminalStartupRecord | undefined>,
        private readonly failed: (
            file: string,
            record: TerminalStartupRecord,
            observedRetry: boolean,
        ) => Promise<void>,
    ) {}

    async start(): Promise<void> {
        if (this.interval || this.stopped.signal.aborted) {
            return;
        }
        this.interval = setInterval(() => void this.scan(false), pollMs);
        this.interval.unref();
        await this.arm();
    }

    dispose(): Promise<void> {
        this.stopped.abort();
        clearInterval(this.interval);
        clearTimeout(this.retry);
        this.watcher?.close();
        this.watcher = undefined;
        this.named.clear();
        this.seen.clear();
        return this.running ?? Promise.resolve();
    }

    private async arm(): Promise<void> {
        try {
            await fs.promises.mkdir(this.directory, { recursive: true });
            const stat = await fs.promises.stat(this.directory, { bigint: true });
            if (this.stopped.signal.aborted) {
                return;
            }
            const watcher = fs.watch(this.directory, { persistent: false }, (_, name) => {
                if (this.watcher !== watcher || this.stopped.signal.aborted) {
                    return;
                }
                this.retryMs = 250;
                if (!name) {
                    void this.scan(true);
                } else if (recordName.test(name)) {
                    this.named.add(name);
                    void this.drain();
                }
            });
            this.watcher = watcher;
            this.watchedDirectory = `${stat.dev}:${stat.ino}`;
            const lost = (error?: Error) => {
                if (this.watcher !== watcher || this.stopped.signal.aborted) {
                    return;
                }
                this.retire(watcher, error);
                void this.scan(true);
            };
            watcher.on('error', lost);
            watcher.on('close', lost);
        } catch (error) {
            this.scheduleRetry(error);
        }
        // A publication may precede registration or land while the watcher is down.
        await this.scan(true);
    }

    private retire(watcher: fs.FSWatcher, error?: Error): void {
        if (this.watcher !== watcher || this.stopped.signal.aborted) {
            return;
        }
        this.watcher = undefined;
        this.watchedDirectory = undefined;
        this.named.clear();
        watcher.close();
        this.scheduleRetry(error);
    }

    private scheduleRetry(error?: unknown): void {
        if (this.retry || this.stopped.signal.aborted) {
            return;
        }
        if (error && this.retryMs === 250) {
            console.warn(
                '[session discovery] Terminal startup watch unavailable, polling for recovery',
                error,
            );
        }
        this.retry = setTimeout(() => {
            this.retry = undefined;
            void this.arm();
        }, this.retryMs);
        this.retry.unref();
        this.retryMs = Math.min(30_000, this.retryMs * 2);
    }

    private scan(force: boolean): Promise<void> {
        this.scanRequested = true;
        this.forceScan ||= force;
        return this.drain();
    }

    private drain(): Promise<void> {
        this.running ??= Promise.resolve().then(async () => {
            try {
                while (!this.stopped.signal.aborted && (this.named.size || this.scanRequested)) {
                    if (this.scanRequested) {
                        const force = this.forceScan;
                        this.scanRequested = this.forceScan = false;
                        await this.scanDirectory(force);
                    } else {
                        await this.nextNamed();
                    }
                }
            } finally {
                this.running = undefined;
            }
        });
        return this.running;
    }

    private async nextNamed(): Promise<void> {
        const name = this.named.values().next().value;
        if (name !== undefined) {
            this.named.delete(name);
            await this.inspect(name, true);
        }
    }

    private async scanDirectory(force: boolean): Promise<void> {
        const watcher = this.watcher;
        try {
            const stat = await fs.promises.stat(this.directory, { bigint: true });
            const identity = `${stat.dev}:${stat.ino}`;
            if (watcher && watcher === this.watcher && identity !== this.watchedDirectory) {
                // fs.watch can stay bound to an unlinked inode without emitting an error.
                this.retire(watcher);
            }
            if (this.directoryStamp && !this.directoryStamp.startsWith(identity + ':')) {
                this.seen.clear();
            }
            const current = stamp(stat);
            if (
                !force &&
                current === this.directoryStamp &&
                Date.now() - this.lastFullScan < fullPollMs
            ) {
                return;
            }
            const missing = new Set(this.seen.keys());
            const entries = await fs.promises.opendir(this.directory);
            let count = 0;
            for await (const entry of entries) {
                if (this.stopped.signal.aborted) {
                    return;
                }
                if (entry.isFile() && recordName.test(entry.name)) {
                    missing.delete(entry.name);
                    await this.inspect(entry.name, this.named.delete(entry.name));
                }
                if (this.named.size) {
                    await this.nextNamed();
                }
                // Pace metadata I/O in large historical directories. Named events
                // continue to make progress while a full scan is in flight.
                if (++count % 32 === 0) {
                    await delay(100, undefined, { ref: false, signal: this.stopped.signal });
                }
            }
            for (const name of missing) {
                this.seen.delete(name);
            }
            this.directoryStamp = current;
            this.lastFullScan = Date.now();
        } catch (error) {
            this.directoryStamp = undefined;
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                this.seen.clear();
                if (watcher) {
                    this.retire(watcher);
                }
            }
        }
    }

    private async inspect(name: string, named: boolean): Promise<void> {
        const file = path.join(this.directory, name);
        try {
            const stat = await fs.promises.lstat(file, { bigint: true });
            if (!stat.isFile() || this.stopped.signal.aborted) {
                return;
            }
            const current = stamp(stat);
            const previous = this.seen.get(name);
            if (!named && previous?.stamp === current) {
                return;
            }
            const record = await this.read(file);
            if (this.stopped.signal.aborted) {
                return;
            }
            // A scan can find a historical failure whose PID has since been
            // reused. An unlabelled terminal needs a live publication or a new
            // retry from the same managed R process before it can claim a file.
            const prior = previous?.record;
            const observedRetry =
                named ||
                Boolean(
                    record &&
                    prior &&
                    prior.pid === record.pid &&
                    prior.token === record.token &&
                    (prior.attemptId !== record.attemptId ||
                        (prior.status === 'pending' && record.status === 'failed')),
                );
            this.seen.set(name, { stamp: current, record });
            if (record?.status !== 'failed') {
                return;
            }
            await this.failed(file, record, observedRetry);
        } catch (error) {
            this.seen.delete(name);
            if (
                !this.stopped.signal.aborted &&
                (error as NodeJS.ErrnoException).code !== 'ENOENT'
            ) {
                console.warn('[session discovery] Could not inspect terminal startup', error);
            }
        }
    }
}
