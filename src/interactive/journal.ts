import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentSnapshot, ExecutionRecord, SessionEvent, Submission, identifier } from './protocol';
import {
    JournalIndex,
    getJournalIndex,
    getJournalIndexAsync,
    indexedAssetIds,
    indexEvent,
    recentEvents,
    recentEventsAsync,
    saveJournalIndex,
    segmentNames,
    repairJournalTail,
    replayEvents,
    indexSegment,
} from './journalIndex';

const maxRecentBytes = 3 * 1024 * 1024;
const maxMemoryBytes = 4 * 1024 * 1024;

/** Directory timestamps can be coarse; the durable admission set is authoritative. */
function sameExecutionFiles(entries: [string, unknown][], names: string[]): boolean {
    const ids = new Set(entries.map(([id]) => id));
    return (
        entries.length === names.length &&
        ids.size === names.length &&
        names.every((name) => ids.has(name.slice(0, -5)))
    );
}

/** Durable records stay on disk; only a byte-bounded working set retains source code. */
class ExecutionLedger {
    private metadata = new Map<string, { order: number; state: ExecutionRecord['state'] }>();
    private cache = new Map<string, { record: ExecutionRecord; bytes: number }>();
    private cacheBytes = 0;

    constructor(private directory: string) {
        const folder = path.join(directory, 'executions');
        const names = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
        let entries: [string, { order: number; state: ExecutionRecord['state'] }][] | undefined;
        try {
            const saved = JSON.parse(
                fs.readFileSync(path.join(directory, 'executions-index.json'), 'utf8'),
            ) as { data: string; hash: string; mtime: number };
            if (
                saved.mtime === fs.statSync(folder).mtimeMs &&
                createHash('sha256').update(saved.data).digest('hex') === saved.hash
            ) {
                entries = JSON.parse(saved.data) as typeof entries;
                if (
                    !Array.isArray(entries) ||
                    !sameExecutionFiles(entries, names) ||
                    entries.some(([id, data]) => {
                        identifier(id);
                        return !Number.isSafeInteger(data.order);
                    })
                ) {
                    entries = undefined;
                }
            }
        } catch {
            entries = undefined;
        }
        if (entries) {
            this.metadata = new Map(entries);
        } else {
            for (const name of names) {
                const record = JSON.parse(
                    fs.readFileSync(path.join(folder, name), 'utf8'),
                ) as ExecutionRecord;
                identifier(record.id);
                this.set(record);
            }
            this.metadata = new Map([...this.metadata].sort((a, b) => a[1].order - b[1].order));
        }
    }
    get size(): number {
        return this.metadata.size;
    }
    get(id: string): ExecutionRecord | undefined {
        if (!this.metadata.has(id)) {
            return;
        }
        const cached = this.cache.get(id);
        if (cached) {
            this.cache.delete(id);
            this.cache.set(id, cached);
            return cached.record;
        }
        const record = JSON.parse(
            fs.readFileSync(
                path.join(this.directory, 'executions', identifier(id) + '.json'),
                'utf8',
            ),
        ) as ExecutionRecord;
        this.remember(record);
        return record;
    }
    set(record: ExecutionRecord): void {
        this.metadata.set(record.id, { order: record.order, state: record.state });
        this.remember(record);
    }
    *values(): Generator<ExecutionRecord> {
        for (const id of this.metadata.keys()) {
            yield this.get(id)!;
        }
    }
    *unfinished(): Generator<ExecutionRecord> {
        for (const [id, meta] of this.metadata) {
            if (meta.state === 'queued' || meta.state === 'running') {
                yield this.get(id)!;
            }
        }
    }
    recent(limit: number, budget = Number.POSITIVE_INFINITY): ExecutionRecord[] {
        const records: ExecutionRecord[] = [];
        for (const id of [...this.metadata.keys()].slice(-limit).reverse()) {
            const record = this.get(id)!,
                bytes = Buffer.byteLength(JSON.stringify(record));
            if (bytes > budget) {
                break;
            }
            records.unshift(record);
            budget -= bytes;
        }
        return records;
    }
    history(
        query: string,
        before: number,
        limit = 100,
    ): { executions: ExecutionRecord[]; more: boolean } {
        const needle = query.toLocaleLowerCase(),
            executions: ExecutionRecord[] = [];
        let bytes = 0;
        for (const id of [...this.metadata.keys()].reverse()) {
            if (this.metadata.get(id)!.order >= before) {
                continue;
            }
            const record = this.get(id)!;
            if (!record.code.toLocaleLowerCase().includes(needle)) {
                continue;
            }
            const size = Buffer.byteLength(JSON.stringify(record));
            if (executions.length >= limit || bytes + size > 2 * 1024 * 1024) {
                return { executions, more: true };
            }
            executions.push(record);
            bytes += size;
        }
        return { executions, more: false };
    }
    save(): void {
        const data = JSON.stringify([...this.metadata]);
        atomicJson(path.join(this.directory, 'executions-index.json'), {
            data,
            hash: createHash('sha256').update(data).digest('hex'),
            mtime: fs.statSync(path.join(this.directory, 'executions')).mtimeMs,
        });
    }
    private remember(record: ExecutionRecord): void {
        const previous = this.cache.get(record.id);
        if (previous) {
            this.cacheBytes -= previous.bytes;
            this.cache.delete(record.id);
        }
        const bytes = Buffer.byteLength(JSON.stringify(record));
        this.cache.set(record.id, { record, bytes });
        this.cacheBytes += bytes;
        while (this.cacheBytes > maxMemoryBytes && this.cache.size) {
            const id = this.cache.keys().next().value as string;
            this.cacheBytes -= this.cache.get(id)!.bytes;
            this.cache.delete(id);
        }
    }
}

function recentRecords(directory: string, limit: number): ExecutionRecord[] {
    return new ExecutionLedger(directory).recent(Math.max(1, limit), 1400 * 1024);
}
async function recentRecordsAsync(directory: string, limit: number): Promise<ExecutionRecord[]> {
    const folder = path.join(directory, 'executions');
    const names = (await fs.promises.readdir(folder)).filter((name) => name.endsWith('.json'));
    let metadata: [string, { order: number }][] | undefined;
    try {
        const saved = JSON.parse(
            await fs.promises.readFile(path.join(directory, 'executions-index.json'), 'utf8'),
        ) as { data: string; hash: string; mtime: number };
        if (
            saved.mtime === (await fs.promises.stat(folder)).mtimeMs &&
            createHash('sha256').update(saved.data).digest('hex') === saved.hash
        ) {
            metadata = JSON.parse(saved.data) as typeof metadata;
            if (
                !Array.isArray(metadata) ||
                !sameExecutionFiles(metadata, names) ||
                metadata.some(([id, data]) => {
                    identifier(id);
                    return !Number.isSafeInteger(data.order);
                })
            ) {
                metadata = undefined;
            }
        }
    } catch {
        metadata = undefined;
    }
    if (!metadata) {
        metadata = [];
        for (let start = 0; start < names.length; start += 16) {
            const records = await Promise.all(
                names
                    .slice(start, start + 16)
                    .map(
                        async (name) =>
                            JSON.parse(
                                await fs.promises.readFile(path.join(folder, name), 'utf8'),
                            ) as ExecutionRecord,
                    ),
            );
            for (const record of records) {
                identifier(record.id);
                metadata.push([record.id, { order: record.order }]);
            }
        }
        metadata.sort((a, b) => a[1].order - b[1].order);
    }
    const records: ExecutionRecord[] = [];
    let budget = 1400 * 1024;
    for (const [id] of metadata.slice(-Math.max(1, limit)).reverse()) {
        const record = JSON.parse(
            await fs.promises.readFile(path.join(folder, identifier(id) + '.json'), 'utf8'),
        ) as ExecutionRecord;
        const bytes = Buffer.byteLength(JSON.stringify(record));
        if (bytes > budget) {
            break;
        }
        records.unshift(record);
        budget -= bytes;
    }
    return records;
}
function previousSnapshot(
    executions: ExecutionRecord[],
    events: SessionEvent[],
    seq: number,
): Pick<AgentSnapshot, 'executions' | 'events' | 'seq' | 'truncated'> {
    const admitted = new Set(
        events.filter((event) => event.type === 'accepted').map((event) => event.executionId),
    );
    return {
        executions,
        events,
        seq,
        truncated: executions
            .filter((record) => !admitted.has(record.id))
            .map((record) => record.id),
    };
}

/** Read a completed process without opening a writer or repairing its journal. */
export function readPreviousJournal(
    storage: string,
    generation: string,
    limit: number,
): Pick<AgentSnapshot, 'executions' | 'events' | 'seq' | 'truncated'> {
    const directory = path.join(storage, identifier(generation));
    const executions = recentRecords(directory, limit),
        index = getJournalIndex(directory, generation);
    const budget =
        maxRecentBytes -
        executions.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
    return previousSnapshot(
        executions,
        recentEvents(directory, index, new Set(executions.map((record) => record.id)), budget),
        index.seq,
    );
}

/** Cold legacy indexes and event ranges are read in chunks without blocking the editor. */
export async function readPreviousJournalAsync(
    storage: string,
    generation: string,
    limit: number,
): Promise<Pick<AgentSnapshot, 'executions' | 'events' | 'seq' | 'truncated'>> {
    const directory = path.join(storage, identifier(generation));
    const index = await getJournalIndexAsync(directory, generation);
    const executions = await recentRecordsAsync(directory, limit);
    const budget =
        maxRecentBytes -
        executions.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0);
    return previousSnapshot(
        executions,
        await recentEventsAsync(
            directory,
            index,
            new Set(executions.map((record) => record.id)),
            budget,
        ),
        index.seq,
    );
}

export function readExecutionRecords(directory: string): ExecutionRecord[] {
    return [...new ExecutionLedger(directory).values()];
}

export async function readExecutionRecordsAsync(directory: string): Promise<ExecutionRecord[]> {
    const folder = path.join(directory, 'executions');
    const names = (await fs.promises.readdir(folder)).filter((name) => name.endsWith('.json'));
    const records: ExecutionRecord[] = [];
    for (let start = 0; start < names.length; start += 16) {
        const batch = await Promise.all(
            names
                .slice(start, start + 16)
                .map(
                    async (name) =>
                        JSON.parse(
                            await fs.promises.readFile(path.join(folder, name), 'utf8'),
                        ) as ExecutionRecord,
                ),
        );
        for (const record of batch) {
            identifier(record.id);
            records.push(record);
        }
    }
    return records.sort((a, b) => a.order - b.order);
}

export function atomicJson(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
}

/** Latest committed display versions; changed/corrupt journals force an index rebuild. */
export function retainedAssetIds(storage: string): Set<string> {
    const retained = new Set<string>();
    for (const generation of fs.readdirSync(storage, { withFileTypes: true })) {
        if (!generation.isDirectory() || generation.name === 'assets') {
            continue;
        }
        const index = getJournalIndex(path.join(storage, generation.name), generation.name, true);
        for (const id of indexedAssetIds(index)) {
            retained.add(id);
        }
    }
    return retained;
}

/** Durable admission ledger plus a bounded, segmented output journal. */
export class SessionJournal {
    readonly executions: ExecutionLedger;
    private index: JournalIndex;
    private memoryBytes = 0;
    private eventSizes: number[] = [];
    private events: SessionEvent[] = [];
    private fd: number;
    private size = 0;
    private segment = 0;
    private nextOrder = 1;
    seq = 0;
    earliestSeq = 1;

    constructor(
        readonly directory: string,
        private readonly generation: string,
        private readonly maxBytes = 128 * 1024 * 1024,
    ) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'executions'), { recursive: true, mode: 0o700 });
        this.executions = new ExecutionLedger(directory);
        this.nextOrder = (this.executions.recent(1)[0]?.order ?? 0) + 1;
        const segments = this.segments();
        for (const name of segments) {
            repairJournalTail(path.join(directory, name));
        }
        if (segments.length) {
            this.segment = Number(segments[segments.length - 1].slice(7, -6));
        }
        this.index = getJournalIndex(directory, generation);
        this.seq = this.index.seq;
        this.earliestSeq =
            this.index.segments.find((segment) => segment.first)?.first ?? this.seq + 1;
        const file = this.segmentFile();
        this.fd = fs.openSync(file, 'a', 0o600);
        this.size = fs.fstatSync(this.fd).size;
        indexSegment(this.index, path.basename(file), fs.fstatSync(this.fd));
        this.trimMemory();
    }

    accept(request: Submission): { record: ExecutionRecord; duplicate: boolean } {
        const hash = createHash('sha256').update(request.code).digest('hex');
        const previous = this.executions.get(request.id);
        if (previous) {
            if (previous.hash !== hash) {
                throw new Error('Execution ID already used for different code');
            }
            return { record: previous, duplicate: true };
        }
        const record: ExecutionRecord = {
            ...request,
            hash,
            state: 'queued',
            order: this.nextOrder++,
            accepted: Date.now(),
        };
        this.update(record);
        return { record, duplicate: false };
    }

    update(record: ExecutionRecord): void {
        atomicJson(
            path.join(this.directory, 'executions', `${identifier(record.id)}.json`),
            record,
        );
        this.executions.set(record);
    }

    append(
        type: string,
        data: Record<string, unknown>,
        executionId?: string,
        durable = false,
    ): SessionEvent {
        const event: SessionEvent = {
            seq: this.seq + 1,
            generation: this.generation,
            type,
            data,
            executionId,
            time: Date.now(),
        };
        const line = `${JSON.stringify(event)}\n`;
        fs.writeSync(this.fd, line);
        if (durable) {
            fs.fsyncSync(this.fd);
        }
        this.seq = event.seq;
        this.size += Buffer.byteLength(line);
        indexEvent(
            this.index,
            path.basename(this.segmentFile()),
            event,
            this.size - Buffer.byteLength(line),
            Buffer.byteLength(line),
            fs.fstatSync(this.fd),
        );
        this.remember(event, Buffer.byteLength(line));
        if (this.size >= 4 * 1024 * 1024) {
            this.rotate();
        }
        this.trimMemory();
        return event;
    }

    replay(after: number, limit = 1000): { events: SessionEvent[]; reset: boolean; seq: number } {
        if (after < this.earliestSeq - 1) {
            return { events: [], reset: true, seq: this.seq };
        }
        const events: SessionEvent[] = [];
        if (after >= (this.events[0]?.seq ?? this.seq + 1) - 1) {
            let bytes = 0;
            for (const event of this.events) {
                if (event.seq <= after) {
                    continue;
                }
                const size = Buffer.byteLength(JSON.stringify(event));
                if (events.length && (bytes + size > 3 * 1024 * 1024 || events.length >= limit)) {
                    break;
                }
                events.push(event);
                bytes += size;
            }
        } else {
            return {
                events: replayEvents(this.directory, this.index, after, maxRecentBytes, limit),
                reset: false,
                seq: this.seq,
            };
        }
        return { events, reset: false, seq: this.seq };
    }

    recent(
        limit: number,
        activeId?: string,
    ): { executions: ExecutionRecord[]; events: SessionEvent[] } {
        const records = this.executions.recent(limit, 1400 * 1024);
        const active = activeId && this.executions.get(activeId);
        if (active && !records.some((record) => record.id === active.id)) {
            records.push(active);
        }
        records.sort((a, b) =>
            a.id === activeId ? -1 : b.id === activeId ? 1 : b.order - a.order,
        );
        const executions: ExecutionRecord[] = [];
        let recordBytes = 0;
        for (const record of records) {
            const bytes = Buffer.byteLength(JSON.stringify(record));
            // Raw code is bounded at admission, but JSON escaping can exceed the
            // history allowance. Active work must survive reconnect regardless.
            if (record.id !== activeId && recordBytes + bytes > 1400 * 1024) {
                continue;
            }
            executions.push(record);
            recordBytes += bytes;
        }
        executions.sort((a, b) => a.order - b.order);
        return {
            executions,
            events: recentEvents(
                this.directory,
                this.index,
                new Set(executions.map((record) => record.id)),
                Math.max(0, maxRecentBytes - recordBytes),
            ),
        };
    }

    close(): void {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        saveJournalIndex(this.directory, this.index);
        this.executions.save();
    }

    private segments(): string[] {
        return segmentNames(this.directory);
    }

    private segmentFile(): string {
        return path.join(this.directory, `events-${String(this.segment).padStart(6, '0')}.jsonl`);
    }

    private remember(event: SessionEvent, bytes: number): void {
        this.events.push(event);
        this.eventSizes.push(bytes);
        this.memoryBytes += bytes;
        this.trimMemory();
    }

    private trimMemory(): void {
        while (this.events.length > 2000 || this.memoryBytes > maxMemoryBytes) {
            this.events.shift();
            this.memoryBytes -= this.eventSizes.shift()!;
        }
    }

    private rotate(): void {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.segment++;
        this.fd = fs.openSync(this.segmentFile(), 'a', 0o600);
        indexSegment(this.index, path.basename(this.segmentFile()), fs.fstatSync(this.fd));
        this.size = 0;
        const segments = this.segments();
        let total = segments.reduce(
            (sum, name) => sum + fs.statSync(path.join(this.directory, name)).size,
            0,
        );
        while (total > this.maxBytes && segments.length > 1) {
            const file = path.join(this.directory, segments.shift()!);
            total -= fs.statSync(file).size;
            fs.unlinkSync(file);
        }
        const retained = new Set(segments);
        this.index.segments = this.index.segments.filter((segment) => retained.has(segment.name));
        this.earliestSeq =
            this.index.segments.find((segment) => segment.first)?.first ?? this.seq + 1;
        saveJournalIndex(this.directory, this.index);
    }
}
