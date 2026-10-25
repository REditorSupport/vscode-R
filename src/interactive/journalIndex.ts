import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { SessionEvent } from './protocol';

interface SegmentIndex {
    name: string;
    size: number;
    mtime: number;
    first: number;
    last: number;
    ranges: Record<string, [number, number]>;
    displays: Record<string, { seq: number; ids: string[] }>;
}
export interface JournalIndex {
    generation: string;
    seq: number;
    segments: SegmentIndex[];
}
const caches = new Map<string, JournalIndex>();
const verified = new WeakSet<JournalIndex>();
const indexFile = 'events-index.json';
const chunkBytes = 64 * 1024;

export function segmentNames(directory: string): string[] {
    return fs
        .readdirSync(directory)
        .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
        .sort();
}
function emptySegment(name: string, size: number, mtime: number): SegmentIndex {
    return {
        name,
        size,
        mtime,
        first: 0,
        last: 0,
        ranges: Object.create(null) as Record<string, [number, number]>,
        displays: {},
    };
}
function include(segment: SegmentIndex, event: SessionEvent, offset: number, bytes: number): void {
    segment.first ||= event.seq;
    segment.last = event.seq;
    if (event.executionId) {
        const range = Object.hasOwn(segment.ranges, event.executionId)
            ? segment.ranges[event.executionId]
            : undefined;
        if (range) {
            range[1] = offset + bytes;
        } else {
            segment.ranges[event.executionId] = [offset, offset + bytes];
        }
    }
    if (event.type === 'display' && typeof event.data.displayId === 'string') {
        segment.displays[JSON.stringify([event.executionId ?? '', event.data.displayId])] = {
            seq: event.seq,
            ids: ['svg', 'asset'].flatMap((key) =>
                typeof event.data[key] === 'string' ? [event.data[key] as string] : [],
            ),
        };
    }
}

/** Read complete lines only. A final uncommitted append is deliberately ignored. */
function* forwardLines(file: string): Generator<{ text: string; offset: number; bytes: number }> {
    const fd = fs.openSync(file, 'r');
    let pending = Buffer.alloc(0),
        offset = 0;
    try {
        const chunk = Buffer.allocUnsafe(chunkBytes);
        let size: number;
        while ((size = fs.readSync(fd, chunk, 0, chunk.length, null))) {
            const data = Buffer.concat([pending, chunk.subarray(0, size)]);
            let start = 0,
                end: number;
            while ((end = data.indexOf(10, start)) >= 0) {
                const bytes = end - start + 1;
                yield { text: data.toString('utf8', start, end), offset, bytes };
                offset += bytes;
                start = end + 1;
            }
            pending = Buffer.from(data.subarray(start));
        }
    } finally {
        fs.closeSync(fd);
    }
}

async function* forwardLinesAsync(
    file: string,
): AsyncGenerator<{ text: string; offset: number; bytes: number }> {
    const handle = await fs.promises.open(file, 'r');
    let pending = Buffer.alloc(0),
        offset = 0;
    try {
        const chunk = Buffer.allocUnsafe(chunkBytes);
        let size: number;
        while ((size = (await handle.read(chunk, 0, chunk.length, null)).bytesRead)) {
            const data = Buffer.concat([pending, chunk.subarray(0, size)]);
            let start = 0,
                end: number;
            while ((end = data.indexOf(10, start)) >= 0) {
                const bytes = end - start + 1;
                yield { text: data.toString('utf8', start, end), offset, bytes };
                offset += bytes;
                start = end + 1;
            }
            pending = Buffer.from(data.subarray(start));
        }
    } finally {
        await handle.close();
    }
}

function decodeIndex(text: string, generation: string): JournalIndex | undefined {
    try {
        const saved = JSON.parse(text) as { data: string; hash: string };
        if (
            typeof saved.data !== 'string' ||
            createHash('sha256').update(saved.data).digest('hex') !== saved.hash
        ) {
            return;
        }
        const index = JSON.parse(saved.data) as JournalIndex;
        if (
            index.generation !== generation ||
            !Array.isArray(index.segments) ||
            !Number.isSafeInteger(index.seq)
        ) {
            return;
        }
        return index;
    } catch {
        return;
    }
}
function remember(directory: string, index: JournalIndex): JournalIndex {
    caches.delete(directory);
    caches.set(directory, index);
    while (caches.size > 16) {
        caches.delete(caches.keys().next().value as string);
    }
    return index;
}
function sameFiles(index: JournalIndex, names: string[], stats: fs.Stats[]): boolean {
    return (
        index.segments.length === names.length &&
        index.segments.every(
            (segment, i) =>
                segment.name === names[i] &&
                segment.size === stats[i].size &&
                segment.mtime === stats[i].mtimeMs,
        )
    );
}
export function getJournalIndex(
    directory: string,
    generation: string,
    verify = false,
): JournalIndex {
    const names = segmentNames(directory);
    const stats = names.map((name) => fs.statSync(path.join(directory, name)));
    let index = caches.get(directory);
    if (
        index?.generation === generation &&
        sameFiles(index, names, stats) &&
        (!verify || verified.has(index))
    ) {
        return index;
    }
    try {
        index = decodeIndex(fs.readFileSync(path.join(directory, indexFile), 'utf8'), generation);
    } catch {
        index = undefined;
    }
    if (index && sameFiles(index, names, stats) && !verify) {
        return remember(directory, index);
    }
    index = { generation, seq: 0, segments: [] };
    for (let i = 0; i < names.length; i++) {
        const segment = emptySegment(names[i], stats[i].size, stats[i].mtimeMs);
        for (const line of forwardLines(path.join(directory, names[i]))) {
            if (!line.text) {
                continue;
            }
            const event = JSON.parse(line.text) as SessionEvent;
            if (event.generation !== generation) {
                throw new Error('Journal generation mismatch');
            }
            include(segment, event, line.offset, line.bytes);
            index.seq = Math.max(index.seq, event.seq);
        }
        index.segments.push(segment);
    }
    verified.add(index);
    return remember(directory, index);
}

export async function getJournalIndexAsync(
    directory: string,
    generation: string,
): Promise<JournalIndex> {
    const names = (await fs.promises.readdir(directory))
        .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
        .sort();
    const stats = await Promise.all(
        names.map((name) => fs.promises.stat(path.join(directory, name))),
    );
    let index = caches.get(directory);
    if (index?.generation === generation && sameFiles(index, names, stats)) {
        return index;
    }
    try {
        index = decodeIndex(
            await fs.promises.readFile(path.join(directory, indexFile), 'utf8'),
            generation,
        );
    } catch {
        index = undefined;
    }
    if (index && sameFiles(index, names, stats)) {
        return remember(directory, index);
    }
    index = { generation, seq: 0, segments: [] };
    for (let i = 0; i < names.length; i++) {
        const segment = emptySegment(names[i], stats[i].size, stats[i].mtimeMs);
        for await (const line of forwardLinesAsync(path.join(directory, names[i]))) {
            if (!line.text) {
                continue;
            }
            const event = JSON.parse(line.text) as SessionEvent;
            if (event.generation !== generation) {
                throw new Error('Journal generation mismatch');
            }
            include(segment, event, line.offset, line.bytes);
            index.seq = Math.max(index.seq, event.seq);
        }
        index.segments.push(segment);
    }
    verified.add(index);
    return remember(directory, index);
}

export function indexEvent(
    index: JournalIndex,
    name: string,
    event: SessionEvent,
    offset: number,
    bytes: number,
    stat: fs.Stats,
): void {
    let segment = index.segments.at(-1);
    if (segment?.name !== name) {
        segment = emptySegment(name, stat.size, stat.mtimeMs);
        index.segments.push(segment);
    }
    segment.size = stat.size;
    segment.mtime = stat.mtimeMs;
    include(segment, event, offset, bytes);
    index.seq = event.seq;
}
export function saveJournalIndex(directory: string, index: JournalIndex): void {
    const data = JSON.stringify(index);
    const file = path.join(directory, indexFile),
        temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(
        temporary,
        JSON.stringify({ data, hash: createHash('sha256').update(data).digest('hex') }),
        { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    remember(directory, index);
}

function ranges(
    index: JournalIndex,
    ids: Set<string>,
): { file: string; start: number; end: number }[] {
    const result: { file: string; start: number; end: number }[] = [];
    for (const segment of index.segments.slice().reverse()) {
        const selected = Object.entries(segment.ranges)
            .filter(([id]) => ids.has(id))
            .map(([, range]) => range)
            .sort((a, b) => b[1] - a[1]);
        // Overlapping execution ranges (interleaved output) are read only once.
        for (const [start, end] of selected) {
            const previous = result.at(-1);
            if (previous?.file === segment.name && end >= previous.start) {
                previous.start = Math.min(previous.start, start);
            } else {
                result.push({ file: segment.name, start, end });
            }
        }
    }
    return result;
}

function readRange(fd: number, bytes: Buffer, position: number): void {
    let offset = 0;
    while (offset < bytes.length) {
        const size = fs.readSync(fd, bytes, offset, bytes.length - offset, position + offset);
        if (!size) {
            throw new Error('Journal changed during indexed read');
        }
        offset += size;
    }
}
async function readRangeAsync(
    handle: fs.promises.FileHandle,
    bytes: Buffer,
    position: number,
): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
        const size = (await handle.read(bytes, offset, bytes.length - offset, position + offset))
            .bytesRead;
        if (!size) {
            throw new Error('Journal changed during indexed read');
        }
        offset += size;
    }
}
function* reversedLines(fd: number, start: number, end: number): Generator<string> {
    let position = end,
        pending = Buffer.alloc(0);
    while (position > start) {
        const bytes = Math.min(chunkBytes, position - start),
            chunk = Buffer.allocUnsafe(bytes);
        position -= bytes;
        readRange(fd, chunk, position);
        const data = Buffer.concat([chunk, pending]);
        let lineEnd = data.length;
        if (data[lineEnd - 1] === 10) {
            lineEnd--;
        }
        let newline: number;
        while (lineEnd > 0 && (newline = data.lastIndexOf(10, lineEnd - 1)) >= 0) {
            yield data.toString('utf8', newline + 1, lineEnd);
            lineEnd = newline;
        }
        pending = Buffer.from(data.subarray(0, lineEnd));
    }
    if (pending.length) {
        yield pending.toString('utf8');
    }
}
async function* reversedLinesAsync(
    handle: fs.promises.FileHandle,
    start: number,
    end: number,
): AsyncGenerator<string> {
    let position = end,
        pending = Buffer.alloc(0);
    while (position > start) {
        const bytes = Math.min(chunkBytes, position - start),
            chunk = Buffer.allocUnsafe(bytes);
        position -= bytes;
        await readRangeAsync(handle, chunk, position);
        const data = Buffer.concat([chunk, pending]);
        let lineEnd = data.length;
        if (data[lineEnd - 1] === 10) {
            lineEnd--;
        }
        let newline: number;
        while (lineEnd > 0 && (newline = data.lastIndexOf(10, lineEnd - 1)) >= 0) {
            yield data.toString('utf8', newline + 1, lineEnd);
            lineEnd = newline;
        }
        pending = Buffer.from(data.subarray(0, lineEnd));
    }
    if (pending.length) {
        yield pending.toString('utf8');
    }
}
function collect(
    line: string,
    generation: string,
    ids: Set<string>,
    events: SessionEvent[],
    remaining: number,
): number {
    if (!line) {
        return remaining;
    }
    const event = JSON.parse(line) as SessionEvent;
    if (event.generation !== generation) {
        throw new Error('Journal generation mismatch');
    }
    if (!event.executionId || !ids.has(event.executionId)) {
        return remaining;
    }
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > remaining) {
        return -1;
    }
    events.push(event);
    return remaining - bytes;
}
export function recentEvents(
    directory: string,
    index: JournalIndex,
    ids: Set<string>,
    budget: number,
): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const range of ranges(index, ids)) {
        const fd = fs.openSync(path.join(directory, range.file), 'r');
        try {
            for (const line of reversedLines(fd, range.start, range.end)) {
                budget = collect(line, index.generation, ids, events, budget);
                if (budget < 0) {
                    return events.sort((a, b) => a.seq - b.seq);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    }
    return events.sort((a, b) => a.seq - b.seq);
}
export async function recentEventsAsync(
    directory: string,
    index: JournalIndex,
    ids: Set<string>,
    budget: number,
): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for (const range of ranges(index, ids)) {
        const handle = await fs.promises.open(path.join(directory, range.file), 'r');
        try {
            for await (const line of reversedLinesAsync(handle, range.start, range.end)) {
                budget = collect(line, index.generation, ids, events, budget);
                if (budget < 0) {
                    return events.sort((a, b) => a.seq - b.seq);
                }
            }
        } finally {
            await handle.close();
        }
    }
    return events.sort((a, b) => a.seq - b.seq);
}
export function indexedAssetIds(index: JournalIndex): Set<string> {
    const latest = new Map<string, { seq: number; ids: string[] }>();
    for (const segment of index.segments) {
        for (const [key, display] of Object.entries(segment.displays)) {
            latest.set(key, display);
        }
    }
    return new Set([...latest.values()].flatMap((display) => display.ids));
}

/** Only a torn tail is repaired; finalized segments need no full-file reread. */
export function repairJournalTail(file: string): void {
    const fd = fs.openSync(file, 'r+');
    try {
        let position = fs.fstatSync(fd).size;
        if (!position) {
            return;
        }
        const last = Buffer.allocUnsafe(1);
        readRange(fd, last, position - 1);
        if (last[0] === 10) {
            return;
        }
        while (position > 0) {
            const size = Math.min(chunkBytes, position),
                bytes = Buffer.allocUnsafe(size);
            position -= size;
            readRange(fd, bytes, position);
            const newline = bytes.lastIndexOf(10);
            if (newline >= 0) {
                fs.ftruncateSync(fd, position + newline + 1);
                return;
            }
        }
        fs.ftruncateSync(fd, 0);
    } finally {
        fs.closeSync(fd);
    }
}
export function replayEvents(
    directory: string,
    index: JournalIndex,
    after: number,
    budget: number,
    limit: number,
): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const segment of index.segments) {
        if (segment.last <= after) {
            continue;
        }
        for (const line of forwardLines(path.join(directory, segment.name))) {
            if (!line.text) {
                continue;
            }
            const event = JSON.parse(line.text) as SessionEvent;
            if (event.generation !== index.generation) {
                throw new Error('Journal generation mismatch');
            }
            if (event.seq <= after) {
                continue;
            }
            if (events.length && (line.bytes > budget || events.length >= limit)) {
                return events;
            }
            events.push(event);
            budget -= line.bytes;
        }
    }
    return events;
}

export function indexSegment(index: JournalIndex, name: string, stat: fs.Stats): void {
    if (index.segments.at(-1)?.name !== name) {
        index.segments.push(emptySegment(name, stat.size, stat.mtimeMs));
    }
}
