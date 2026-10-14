import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AgentSnapshot, ExecutionRecord, SessionEvent, Submission, identifier } from './protocol';

/** Read a completed process without opening a writer or repairing its journal. */
export function readPreviousJournal(storage: string, generation: string, limit: number): Pick<AgentSnapshot, 'executions' | 'events' | 'seq' | 'truncated'> {
    const directory = path.join(storage, identifier(generation));
    const executions: ExecutionRecord[] = [];
    let bytes = 0;
    for (const record of readExecutionRecords(directory).slice(-Math.max(1, limit)).reverse()) {
        bytes += Buffer.byteLength(JSON.stringify(record));
        if (bytes > 1400 * 1024) { break; }
        executions.unshift(record);
    }
    const ids = new Set(executions.map(record => record.id));
    const events: SessionEvent[] = [];
    let seq = 0;
    // Bound restoration as with a live snapshot; full output stays on disk.
    for (const name of fs.readdirSync(directory).filter(name => /^events-\d{6}\.jsonl$/.test(name)).sort().reverse()) {
        const text = fs.readFileSync(path.join(directory, name), 'utf8');
        for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').reverse()) {
            if (!line) { continue; }
            const event = JSON.parse(line) as SessionEvent;
            if (event.generation !== generation) { throw new Error('Journal generation mismatch'); }
            seq = Math.max(seq, event.seq);
            if (!event.executionId || !ids.has(event.executionId)) { continue; }
            bytes += Buffer.byteLength(line);
            if (bytes <= 3 * 1024 * 1024) { events.push(event); }
        }
    }
    events.reverse();
    return { executions, events, seq,
        truncated: executions.filter(record => !events.some(event => event.type === 'accepted' && event.executionId === record.id)).map(record => record.id) };
}

export function readExecutionRecords(directory: string): ExecutionRecord[] {
    return fs.readdirSync(path.join(directory, 'executions')).filter(name => name.endsWith('.json')).map(name => {
        const record = JSON.parse(fs.readFileSync(path.join(directory, 'executions', name), 'utf8')) as ExecutionRecord;
        identifier(record.id);
        return record;
    }).sort((a, b) => a.order - b.order);
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

/** Latest display versions in every retained generation; HTML roots protect all dependencies. */
export function retainedAssetIds(storage: string): Set<string> {
    const retained = new Set<string>();
    for (const generation of fs.readdirSync(storage, { withFileTypes: true })) {
        if (!generation.isDirectory() || generation.name === 'assets') { continue; }
        const directory = path.join(storage, generation.name);
        const displays = new Map<string, Record<string, unknown>>();
        for (const name of fs.readdirSync(directory).filter(name => /^events-\d{6}\.jsonl$/.test(name)).sort()) {
            const text = fs.readFileSync(path.join(directory, name), 'utf8');
            for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
                if (!line) { continue; }
                const event = JSON.parse(line) as SessionEvent;
                if (event.type === 'display' && typeof event.data.displayId === 'string') {
                    displays.set(`${event.executionId ?? ''}:${event.data.displayId}`, event.data);
                }
            }
        }
        for (const display of displays.values()) {
            for (const key of ['svg', 'asset']) { if (typeof display[key] === 'string') { retained.add(display[key]); } }
        }
    }
    return retained;
}

/** Durable admission ledger plus a bounded, segmented output journal. */
export class SessionJournal {
    readonly executions = new Map<string, ExecutionRecord>();
    private events: SessionEvent[] = [];
    private fd: number;
    private size = 0;
    private segment = 0;
    private nextOrder = 1;
    seq = 0;
    earliestSeq = 1;

    constructor(readonly directory: string, private readonly generation: string,
        private readonly maxBytes = 128 * 1024 * 1024) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(directory, 'executions'), { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(path.join(directory, 'executions'))) {
            if (!name.endsWith('.json')) { continue; }
            const entry = JSON.parse(fs.readFileSync(path.join(directory, 'executions', name), 'utf8')) as ExecutionRecord;
            identifier(entry.id);
            this.executions.set(entry.id, entry);
            this.nextOrder = Math.max(this.nextOrder, entry.order + 1);
        }
        const segments = this.segments();
        for (const name of segments) {
            const file = path.join(directory, name);
            const data = fs.readFileSync(file, 'utf8');
            const boundary = data.lastIndexOf('\n') + 1;
            if (boundary < data.length) {
                // A torn final append has no committed event; remove it before reuse.
                fs.truncateSync(file, Buffer.byteLength(data.slice(0, boundary)));
            }
            for (const line of data.slice(0, boundary).split('\n')) {
                if (!line) { continue; }
                const event = JSON.parse(line) as SessionEvent;
                if (event.generation !== generation) { throw new Error('Journal generation mismatch'); }
                this.seq = Math.max(this.seq, event.seq);
                this.events.push(event);
            }
        }
        if (segments.length) {
            this.segment = Number(segments[segments.length - 1].slice(7, -6));
        }
        this.earliestSeq = this.events[0]?.seq ?? this.seq + 1;
        const file = this.segmentFile();
        this.fd = fs.openSync(file, 'a', 0o600);
        this.size = fs.fstatSync(this.fd).size;
        this.trimMemory();
    }

    accept(request: Submission): { record: ExecutionRecord; duplicate: boolean } {
        const hash = createHash('sha256').update(request.code).digest('hex');
        const previous = this.executions.get(request.id);
        if (previous) {
            if (previous.hash !== hash) { throw new Error('Execution ID already used for different code'); }
            return { record: previous, duplicate: true };
        }
        const record: ExecutionRecord = { ...request, hash, state: 'queued',
            order: this.nextOrder++, accepted: Date.now() };
        this.update(record);
        return { record, duplicate: false };
    }

    update(record: ExecutionRecord): void {
        atomicJson(path.join(this.directory, 'executions', `${identifier(record.id)}.json`), record);
        this.executions.set(record.id, record);
    }

    append(type: string, data: Record<string, unknown>, executionId?: string, durable = false): SessionEvent {
        const event: SessionEvent = { seq: this.seq + 1, generation: this.generation,
            type, data, executionId, time: Date.now() };
        const line = `${JSON.stringify(event)}\n`;
        fs.writeSync(this.fd, line);
        if (durable) { fs.fsyncSync(this.fd); }
        this.seq = event.seq;
        this.size += Buffer.byteLength(line);
        this.events.push(event);
        if (this.size >= 4 * 1024 * 1024) { this.rotate(); }
        this.trimMemory();
        return event;
    }

    replay(after: number, limit = 1000): { events: SessionEvent[]; reset: boolean; seq: number } {
        if (after < this.earliestSeq - 1) { return { events: [], reset: true, seq: this.seq }; }
        const events: SessionEvent[] = [];
        if (after >= (this.events[0]?.seq ?? this.seq + 1) - 1) {
            let bytes = 0;
            for (const event of this.events) {
                if (event.seq <= after) { continue; }
                const size = Buffer.byteLength(JSON.stringify(event));
                if (events.length && (bytes + size > 3 * 1024 * 1024 || events.length >= limit)) { break; }
                events.push(event); bytes += size;
            }
        } else {
            let bytes = 0;
            for (const name of this.segments()) {
                for (const line of fs.readFileSync(path.join(this.directory, name), 'utf8').split('\n')) {
                    if (!line) { continue; }
                    const event = JSON.parse(line) as SessionEvent;
                    if (event.seq > after) {
                        const size = Buffer.byteLength(JSON.stringify(event));
                        if (events.length && bytes + size > 3 * 1024 * 1024) { return { events, reset: false, seq: this.seq }; }
                        events.push(event); bytes += size;
                    }
                    if (events.length >= limit) { return { events, reset: false, seq: this.seq }; }
                }
            }
        }
        return { events, reset: false, seq: this.seq };
    }

    recent(limit: number): { executions: ExecutionRecord[]; events: SessionEvent[] } {
        const executions = [...this.executions.values()].sort((a, b) => a.order - b.order).slice(-limit);
        const ids = new Set(executions.map(record => record.id));
        const events: SessionEvent[] = [];
        for (const name of this.segments()) {
            for (const line of fs.readFileSync(path.join(this.directory, name), 'utf8').split('\n')) {
                if (!line) { continue; }
                const event = JSON.parse(line) as SessionEvent;
                if (event.executionId && ids.has(event.executionId)) { events.push(event); }
            }
        }
        return { executions, events };
    }

    close(): void {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
    }

    private segments(): string[] {
        return fs.readdirSync(this.directory).filter(name => /^events-\d{6}\.jsonl$/.test(name)).sort();
    }

    private segmentFile(): string {
        return path.join(this.directory, `events-${String(this.segment).padStart(6, '0')}.jsonl`);
    }

    private trimMemory(): void {
        if (this.events.length > 2000) { this.events.splice(0, this.events.length - 2000); }
    }

    private rotate(): void {
        fs.fsyncSync(this.fd);
        fs.closeSync(this.fd);
        this.segment++;
        this.fd = fs.openSync(this.segmentFile(), 'a', 0o600);
        this.size = 0;
        const segments = this.segments();
        let total = segments.reduce((sum, name) => sum + fs.statSync(path.join(this.directory, name)).size, 0);
        while (total > this.maxBytes && segments.length > 1) {
            const file = path.join(this.directory, segments.shift()!);
            total -= fs.statSync(file).size;
            fs.unlinkSync(file);
        }
        const first = fs.readFileSync(path.join(this.directory, segments[0]), 'utf8').split('\n')[0];
        this.earliestSeq = first ? (JSON.parse(first) as SessionEvent).seq : this.seq + 1;
    }
}
