'use strict';

// Sequential (forward-only) jdv Arrow views. The extension host keeps the
// received Arrow IPC pages, decodes them with apache-arrow, and serves the
// existing AG Grid infinite row model with formatted rows.

import { tableFromIPC } from 'apache-arrow';
import { JdvDescriptor, JdvRequestError, ROW_LABEL_FIELD } from './jdvAdapter';

// ---------------------------------------------------------------------------
// Formatting. Values are formatted from physical buffers where JavaScript
// number getters lose precision. Ported from jdv's reference viewer
// (server/web/sequential.js, MIT).

export const CELL_TEXT_LIMIT = 4096;
const NANOSECONDS = [1_000_000_000n, 1_000_000n, 1_000n, 1n];
const UNIT_NAMES = ['s', 'ms', 'us', 'ns'];

// apache-arrow Type ids used below.
const TYPE_DICTIONARY = -1;
const TYPE_NULL = 1;
const TYPE_INT = 2;
const TYPE_DECIMAL = 7;
const TYPE_DATE = 8;
const TYPE_TIME = 9;
const TYPE_TIMESTAMP = 10;
const TYPE_LIST = 12;
const TYPE_STRUCT = 13;
const TYPE_FIXED_SIZE_LIST = 16;
const TYPE_MAP = 17;
const TYPE_DURATION = 18;
const TYPE_LARGE_LIST = 21;

interface ArrowType {
    typeId: number;
    bitWidth?: number;
    scale?: number;
    unit?: number;
    timezone?: string | null;
    listSize?: number;
    children?: unknown[];
}

interface ArrowData {
    length: number;
    stride: number;
    values: ArrayLike<number | bigint>;
    valueOffsets?: ArrayLike<number | bigint>;
    dictionary?: ArrowVector;
}

interface ArrowVector {
    length: number;
    type: ArrowType;
    data: ArrowData[];
    isValid(index: number): boolean;
    get(index: number): unknown;
}

interface ArrowTable {
    numRows: number;
    numCols: number;
    getChildAt(index: number): unknown;
}

export function formatScaled(coefficient: bigint, scale: number): string {
    if (!Number.isSafeInteger(scale)) {
        throw new Error('Invalid Arrow decimal scale: expected a safe integer.');
    }
    const negative = coefficient < 0n;
    const digits = (negative ? -coefficient : coefficient).toString();
    const sign = negative ? '-' : '';
    const fixedLength = sign.length + (scale <= 0 ? digits.length - scale : Math.max(digits.length, scale + 1) + 1);
    // Arrow decimal coefficients have at most 76 digits; never expand a huge scale.
    if (fixedLength > CELL_TEXT_LIMIT) {
        return `${sign}${digits}e${-scale}`;
    }
    if (scale <= 0) {
        return sign + digits + '0'.repeat(-scale);
    }
    const padded = digits.padStart(scale + 1, '0');
    return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function signedWords(values: ArrayLike<number | bigint>, start: number, width: number): bigint {
    let result = 0n;
    for (let word = 0; word < width; word++) {
        result |= BigInt(Number(values[start + word]) >>> 0) << BigInt(word * 32);
    }
    return BigInt.asIntN(width * 32, result);
}

function floorDiv(value: bigint, divisor: bigint): bigint {
    const quotient = value / divisor;
    return value % divisor < 0n ? quotient - 1n : quotient;
}

export function formatTimestamp(ticks: bigint, unit: number, timezone: string | null = null): string {
    const nanoseconds = ticks * NANOSECONDS[unit];
    const seconds = floorDiv(nanoseconds, 1_000_000_000n);
    const fraction = nanoseconds - seconds * 1_000_000_000n;
    const date = new Date(Number(seconds) * 1000);
    if (!Number.isSafeInteger(Number(seconds)) || !Number.isFinite(date.getTime())) {
        return `${ticks} ${UNIT_NAMES[unit]}${timezone ? ` [${timezone}]` : ''}`;
    }
    const digits = [0, 3, 6, 9][unit];
    const suffix = digits ? `.${fraction.toString().padStart(9, '0').slice(0, digits)}` : '';
    if (!timezone || timezone === 'UTC' || timezone === 'Etc/UTC') {
        return date.toISOString().replace(/\.\d{3}Z$/, suffix + (timezone ? 'Z' : ''));
    }
    try {
        const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
            timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
        });
        const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
        const offset = (parts.timeZoneName ?? '').replace(/^GMT/, '') || '+00:00';
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${suffix}${offset} [${timezone}]`;
    } catch {
        return `${date.toISOString().replace(/\.\d{3}Z$/, suffix + 'Z')} [${timezone}]`;
    }
}

function chunkAt(vector: ArrowVector, row: number): { data: ArrowData; row: number } {
    for (const data of vector.data) {
        if (row < data.length) {
            return { data, row };
        }
        row -= data.length;
    }
    throw new Error('Arrow row is outside its buffers.');
}

function boundedText(value: string): string {
    return value.length > CELL_TEXT_LIMIT ? value.slice(0, CELL_TEXT_LIMIT) + '… [truncated]' : value;
}

/** Display text of one Arrow value, or `null` for a missing value. */
export function formatArrowValue(vector: ArrowVector, row: number, dictionaries = new Set<ArrowData>()): string | null {
    if (!Number.isSafeInteger(row) || row < 0 || row >= vector.length) {
        throw new Error('Arrow row is outside its buffers.');
    }
    const type = vector.type;
    if (type.typeId === TYPE_NULL || !vector.isValid(row)) {
        return null;
    }
    const { data, row: local } = chunkAt(vector, row);
    // Arrow Data slices already adjust values; offset belongs to the validity bitmap.
    const start = local * data.stride;
    if (type.typeId === TYPE_DICTIONARY) {
        const index = Number(data.values[start]);
        if (!data.dictionary || !Number.isSafeInteger(index) || index < 0 || index >= data.dictionary.length) {
            throw new Error('Invalid Arrow dictionary index.');
        }
        if (dictionaries.has(data) || dictionaries.size >= 32) {
            throw new Error('Arrow dictionary nesting is cyclic or exceeds 32 levels.');
        }
        dictionaries.add(data);
        return formatArrowValue(data.dictionary, index, dictionaries);
    }
    if (type.typeId === TYPE_INT && type.bitWidth === 64) {
        return BigInt(data.values[start]).toString();
    }
    if (type.typeId === TYPE_DECIMAL) {
        return formatScaled(signedWords(data.values, start, (type.bitWidth ?? 128) / 32), type.scale ?? 0);
    }
    if (type.typeId === TYPE_TIMESTAMP) {
        return formatTimestamp(BigInt(data.values[start]), type.unit ?? 0, type.timezone ?? null);
    }
    if (type.typeId === TYPE_TIME || type.typeId === TYPE_DURATION) {
        return `${String(data.values[start])} ${UNIT_NAMES[type.unit ?? 0]}`;
    }
    if (type.typeId === TYPE_LIST || type.typeId === TYPE_FIXED_SIZE_LIST || type.typeId === TYPE_LARGE_LIST) {
        const size = type.listSize ?? Number(data.valueOffsets![local + 1]) - Number(data.valueOffsets![local]);
        return `<list: ${size} items>`;
    }
    if (type.typeId === TYPE_STRUCT) {
        return `<struct: ${type.children?.length ?? 0} fields>`;
    }
    if (type.typeId === TYPE_MAP) {
        return '<map>';
    }
    const value = vector.get(row);
    if (value instanceof Uint8Array) {
        const shown = value.subarray(0, CELL_TEXT_LIMIT / 2);
        return Array.from(shown, byte => byte.toString(16).padStart(2, '0')).join('') +
            (shown.length < value.length ? '… [truncated]' : '');
    }
    if (type.typeId === TYPE_DATE) {
        return new Date(Number(value)).toISOString().slice(0, 10);
    }
    return boundedText(typeof value === 'string' ? value : String(value as number | boolean | bigint));
}

// ---------------------------------------------------------------------------
// Page cache

interface SequentialColumn {
    position: number;
    name: string;
    type: string;
    ipc_index: number | null;
    unsupported: string | null;
}

export const VIEW_CACHE_BYTES = 64 * 1024 * 1024;
export const TOTAL_CACHE_BYTES = 256 * 1024 * 1024;
const PAGE_OVERHEAD_BYTES = 1024;
const DECODED_PAGES = 4;
/** Empty non-EOF pages are legal; bound how many one row request may consume. */
const MAX_EMPTY_PAGES = 64;
export const UNAVAILABLE_TEXT = '(no longer retained)';

interface StoredPage {
    firstRow: number;
    rows: number;
    ipc: Uint8Array;
    charge: number;
    sequence: number;
}

export interface StreamPageResult {
    first_row: number;
    rows_fetched: number;
    rows_seen: number;
    done: boolean;
}

export type FetchNext = (maxRows: number) => Promise<{ result: unknown; body?: Uint8Array }>;

let pageSequence = 0;
const streams = new Set<SequentialStream>();

function totalBytes(): number {
    let total = 0;
    for (const stream of streams) {
        total += stream.bytes;
    }
    return total;
}

function parseProgress(result: unknown, requested: number, rowsSeen: number): StreamPageResult {
    const value = result as Partial<StreamPageResult> | null;
    const integer = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
    if (!value || !integer(value.first_row) || !integer(value.rows_fetched) || !integer(value.rows_seen) ||
        typeof value.done !== 'boolean' || value.rows_seen !== value.first_row! + value.rows_fetched! ||
        value.rows_fetched! > requested || value.first_row! < rowsSeen) {
        throw new JdvRequestError('invalid_request', 'Invalid jdv stream page metadata.');
    }
    return value as StreamPageResult;
}

/**
 * Received pages of one view generation. R cannot rewind the stream, so pages
 * are kept within byte budgets; evicted rows are reported as unavailable.
 */
export class SequentialStream {
    private pages: StoredPage[] = [];
    private readonly decoded = new Map<StoredPage, ArrowTable>();
    private fetching?: Promise<void>;
    bytes = 0;
    rowsSeen = 0;
    done = false;
    /** Rows before this index are no longer held. */
    unavailableBefore = 0;
    private failed?: Error;
    readonly columns: SequentialColumn[];
    readonly pageRows: number;

    constructor(
        readonly descriptor: JdvDescriptor, private readonly next: FetchNext,
        preferredRows = 1000, private readonly viewCacheBytes = VIEW_CACHE_BYTES,
    ) {
        this.columns = (descriptor.columns ?? []) as unknown as SequentialColumn[];
        // parseDescriptor() guarantees a positive safe-integer cap for sequential views.
        this.pageRows = Math.min(preferredRows, descriptor.max_page_rows!);
        streams.add(this);
    }

    dispose(): void {
        streams.delete(this);
        this.pages = [];
        this.decoded.clear();
        this.bytes = 0;
    }

    /** Fetch pages until `endRow` rows have been seen or the stream ends. */
    async ensure(endRow: number): Promise<void> {
        while (!this.done && this.rowsSeen < endRow) {
            if (this.failed) {
                throw this.failed;
            }
            // One stream/next per view generation at a time.
            this.fetching ??= this.fetchUntil(endRow).finally(() => { this.fetching = undefined; });
            const rowsBeforeFetch = this.rowsSeen;
            await this.fetching;
            // fetchUntil() bounds consecutive empty pages. Do not immediately
            // start another round when that bound was reached without progress.
            // A gap page advances rowsSeen and therefore remains progress.
            if (this.rowsSeen === rowsBeforeFetch && !this.done) {
                return;
            }
        }
    }

    private async fetchUntil(endRow: number): Promise<void> {
        let empty = 0;
        while (!this.done && this.rowsSeen < endRow) {
            let response;
            try {
                response = await this.next(this.pageRows);
            } catch (e) {
                // A producer failure is terminal; R releases the stream.
                if (e instanceof JdvRequestError && e.code === 'stream_failed') {
                    this.failed = e;
                }
                throw e;
            }
            const progress = parseProgress(response.result, this.pageRows, this.rowsSeen);
            // A gap (first_row > rowsSeen) has no page; rows() reports it as unavailable.
            if (progress.rows_fetched > 0) {
                if (!response.body) {
                    throw new JdvRequestError('invalid_request', 'The jdv stream page has no Arrow body.');
                }
                this.store(progress, response.body);
                empty = 0;
            } else if (progress.rows_seen > this.rowsSeen) {
                // A gap has no body, but it advances the stream and is progress.
                empty = 0;
            } else {
                empty++;
            }
            this.rowsSeen = progress.rows_seen;
            this.done = progress.done;
            if (empty >= MAX_EMPTY_PAGES && !this.done) {
                return;
            }
        }
    }

    private store(progress: StreamPageResult, ipc: Uint8Array): void {
        const page: StoredPage = {
            firstRow: progress.first_row, rows: progress.rows_fetched, ipc,
            charge: ipc.byteLength + PAGE_OVERHEAD_BYTES, sequence: ++pageSequence,
        };
        this.pages.push(page);
        this.bytes += page.charge;
        while (this.bytes > this.viewCacheBytes && this.pages.length > 0) {
            this.evictOldest();
        }
        // Evict across views, oldest page first.
        while (totalBytes() > TOTAL_CACHE_BYTES) {
            let victim: SequentialStream | undefined;
            for (const stream of streams) {
                if (stream.pages.length > 0 && (!victim || stream.pages[0].sequence < victim.pages[0].sequence)) {
                    victim = stream;
                }
            }
            if (!victim) {
                break;
            }
            victim.evictOldest();
        }
    }

    private evictOldest(): void {
        const page = this.pages.shift();
        if (page) {
            this.bytes -= page.charge;
            this.decoded.delete(page);
            this.unavailableBefore = Math.max(this.unavailableBefore, page.firstRow + page.rows);
        }
    }

    private pageFor(row: number): StoredPage | undefined {
        let low = 0;
        let high = this.pages.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const page = this.pages[middle];
            if (row < page.firstRow) {
                high = middle - 1;
            } else if (row >= page.firstRow + page.rows) {
                low = middle + 1;
            } else {
                return page;
            }
        }
        return undefined;
    }

    private table(page: StoredPage): ArrowTable {
        let table = this.decoded.get(page);
        if (table) {
            // Refresh the small decoded LRU.
            this.decoded.delete(page);
        } else {
            table = tableFromIPC(page.ipc) as unknown as ArrowTable;
            if (table.numRows !== page.rows && table.numCols !== 0) {
                throw new JdvRequestError('invalid_request', 'Arrow rows do not match the stream page metadata.');
            }
        }
        this.decoded.set(page, table);
        while (this.decoded.size > DECODED_PAGES) {
            this.decoded.delete(this.decoded.keys().next().value!);
        }
        return table;
    }

    /** Formatted rows in `[startRow, endRow)` that have been seen. */
    rows(startRow: number, endRow: number): Record<string, unknown>[] {
        const rows: Record<string, unknown>[] = [];
        const end = Math.min(endRow, this.rowsSeen);
        for (let row = Math.max(0, startRow); row < end; row++) {
            const output: Record<string, unknown> = { [ROW_LABEL_FIELD]: String(row + 1) };
            const page = this.pageFor(row);
            const table = page ? this.table(page) : undefined;
            for (const column of this.columns) {
                const field = String(column.position + 1);
                if (column.unsupported || column.ipc_index === null) {
                    output[field] = `<unsupported: ${column.unsupported ?? 'no IPC mapping'}>`;
                } else if (!page || !table) {
                    output[field] = UNAVAILABLE_TEXT;
                } else {
                    const vector = table.getChildAt(column.ipc_index) as ArrowVector | null;
                    if (!vector) {
                        throw new JdvRequestError('invalid_request', 'Arrow column mapping is outside the IPC schema.');
                    }
                    output[field] = formatArrowValue(vector, row - page.firstRow);
                }
            }
            rows.push(output);
        }
        return rows;
    }
}
