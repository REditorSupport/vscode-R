'use strict';

// Adapter between the jdv protocol and the existing Data Viewer and List Viewer
// webviews. It is independent of VS Code so the conversions can be tested in Node.

export type JsonObject = Record<string, unknown>;

/** Capability flags of a descriptor; parseDescriptor() fills omitted flags with false. */
export interface JdvCapabilities {
    seek: boolean;
    sort: boolean;
    filter: boolean;
    known_total: boolean;
    next: boolean;
    children: boolean;
    refresh: boolean;
    /** True only when the view tracks a variable and has not lost it. */
    track: boolean;
}

const CAPABILITY_NAMES = [
    'seek', 'sort', 'filter', 'known_total', 'next', 'children', 'refresh', 'track',
] as const;

export interface JdvColumnSchema {
    position: number;
    name: string;
    type: string;
    /** Producer-defined display hint (R: `class()`); never interpreted. */
    native_type?: string[];
    sortable: boolean;
    filterable: boolean;
    drillable?: boolean;
    levels?: string[];
    ordered?: boolean;
    tz?: string;
    /** `duration` columns: the unit of the values (secs, mins, hours, days or weeks). */
    units?: string;
}

export interface JdvDescriptor {
    view: string;
    generation: number;
    kind: 'grid' | 'tree';
    access: string;
    encoding: string;
    capabilities: JdvCapabilities;
    title?: string | null;
    collation?: 'C' | 'locale';
    /** Sequential views: the row cap captured when the view was opened. */
    max_page_rows?: number;
    nrow?: number | null;
    ncol?: number;
    columns?: JdvColumnSchema[];
    path?: JdvPathStep[];
    /** Tree views: `class()` and `typeof()` of the root object. */
    class?: string[];
    type?: string;
    parent?: string;
    /**
     * Why jdv sent this `view/open`: "register", "child", "tracked" or "refresh".
     * Missing or unknown values mean "register".
     */
    reason?: string;
    /** Present only on views that can follow a variable. */
    tracking?: JdvTracking;
}

export interface JdvTracking {
    name: string;
    state: 'active' | 'paused' | 'lost';
    /** Fixed token when lost: "removed", "collected" or an unknown value. */
    reason?: string;
    /** English display text when lost; not to be parsed. */
    message?: string;
}

export type JdvPathStep =
    | { type: 'index'; index: number }
    | { type: 'binding' | 'slot' | 'attr'; name: string };

export class JdvRequestError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of a scalar filter operand or channel value; other values become ''. */
function scalarText(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ||
        typeof value === 'boolean' ? String(value) : '';
}

/** Validate the params of a `view/open` notification. */
export function parseDescriptor(value: unknown): JdvDescriptor {
    if (!isObject(value) || typeof value.view !== 'string' || value.view === '' ||
        typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
        (value.kind !== 'grid' && value.kind !== 'tree') ||
        typeof value.access !== 'string' || typeof value.encoding !== 'string') {
        throw new Error('Invalid jdv view descriptor');
    }
    // An omitted capabilities object or flag means false.
    const supplied = value.capabilities === undefined ? {} : value.capabilities;
    if (!isObject(supplied) || CAPABILITY_NAMES.some(name => name in supplied && typeof supplied[name] !== 'boolean')) {
        throw new Error('Invalid jdv view descriptor capabilities');
    }
    const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, supplied[name] === true]));
    value.capabilities = capabilities;
    if (value.kind === 'grid') {
        validateGridDescriptor(value, capabilities as unknown as JdvCapabilities);
    }
    const descriptor = value as unknown as JdvDescriptor;
    // `reason` is optional and may gain values; keep only a string.
    if (typeof descriptor.reason !== 'string') {
        delete descriptor.reason;
    }
    const tracking = parseTracking(descriptor.tracking);
    if (tracking) {
        descriptor.tracking = tracking;
    } else {
        delete descriptor.tracking;
    }
    return descriptor;
}

function validateGridDescriptor(value: JsonObject, capabilities: JdvCapabilities): void {
    const invalid = (reason: string) => new Error(`Invalid jdv grid descriptor: ${reason}`);
    if (!Array.isArray(value.columns)) { throw invalid('columns'); }
    if (value.access === 'sequential') {
        const cap = value.max_page_rows;
        if (value.encoding !== 'arrow-ipc' || typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1 ||
            !capabilities.next) {
            throw invalid('sequential access');
        }
        return;
    }
    if ((value.access !== 'snapshot' && value.access !== 'random') || value.encoding !== 'jdv-json') {
        throw invalid('access or encoding');
    }
    if (value.collation !== 'C' && value.collation !== 'locale') { throw invalid('collation'); }
    if (value.access === 'random' && (typeof value.nrow !== 'number' || !Number.isSafeInteger(value.nrow) ||
        value.nrow < 0 || !capabilities.seek || !capabilities.known_total)) {
        throw invalid('random access');
    }
}

/** Validate a `tracking` object; a malformed one is dropped (`undefined`). */
export function parseTracking(value: unknown): JdvTracking | undefined {
    if (!isObject(value) || typeof value.name !== 'string' ||
        (value.state !== 'active' && value.state !== 'paused' && value.state !== 'lost')) {
        return undefined;
    }
    const tracking: JdvTracking = { name: value.name, state: value.state };
    if (typeof value.reason === 'string') { tracking.reason = value.reason; }
    if (typeof value.message === 'string') { tracking.message = value.message; }
    return tracking;
}

/**
 * Whether a newer generation of an open view should bring its panel to the front.
 * Updates that R made on its own (a tracked variable, a Refresh click) must not
 * switch tabs; an explicit View(), an unknown reason or none still reveal.
 */
export function revealsPanel(descriptor: JdvDescriptor): boolean {
    return descriptor.reason !== 'tracked' && descriptor.reason !== 'refresh';
}

/** Whether the view accepts `view/refresh`. Sequential streams cannot be rewound. */
export function canRefresh(descriptor: JdvDescriptor): boolean {
    return descriptor.capabilities.refresh === true && descriptor.access !== 'sequential';
}

// ---------------------------------------------------------------------------
// Grid

/** Row label column. Data columns use their one-based position as field id. */
export const ROW_LABEL_FIELD = '0';
/** Row data key holding the zero-based source row; not a column field. */
export const SOURCE_ROW_FIELD = '__sourceRow';

export interface GridColumnDef {
    headerName: string;
    headerTooltip?: string;
    field: string;
    type: string;
    filter: string | boolean;
    sortable: boolean;
    cellDataType?: string | false;
    suppressHeaderMenuButton?: boolean;
    lockPosition?: string;
    /** Drillable grid cells: the zero-based schema position that `object/open` addresses. */
    jdvDrill?: number;
    /** Webview-only options; see prepareViewerColumns(). */
    jdv?: { filterOptions: string[]; naOptions: boolean; units?: string };
}

const TEXT_FILTER_OPTIONS = ['contains', 'notContains', 'equals', 'notEqual', 'startsWith', 'endsWith'];
const ORDER_FILTER_OPTIONS = [
    'equals', 'notEqual', 'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'inRange',
];
// jdv implements only exact equality and inclusive ranges for integer64.
const INT64_FILTER_OPTIONS = ['equals', 'inRange'];
export const NA_FILTER_OPTION = 'jdvIsNa';
export const NOT_NA_FILTER_OPTION = 'jdvNotNa';

function columnTooltip(column: JdvColumnSchema): string {
    let tooltip = `${column.name}, class: [${(column.native_type ?? []).join(', ')}], type: ${column.type}`;
    if (column.type === 'categorical' && Array.isArray(column.levels)) {
        const levels = column.levels.slice(0, 20).join(', ');
        tooltip += `, levels: ${levels}${column.levels.length > 20 ? ', ...' : ''}`;
    }
    if (column.type === 'datetime' && column.tz !== undefined) {
        tooltip += `, tz: ${column.tz || '(local)'}`;
    }
    if (column.type === 'duration' && typeof column.units === 'string') {
        tooltip += `, units: ${column.units}`;
    }
    return tooltip;
}

const ARROW_NUMERIC_FORMATS = new Set(['c', 'C', 's', 'S', 'i', 'I', 'l', 'L', 'e', 'f', 'g']);

function rowLabelColumn(): GridColumnDef {
    return {
        headerName: '',
        field: ROW_LABEL_FIELD,
        type: 'textColumn',
        filter: false,
        sortable: false,
        lockPosition: 'left',
        suppressHeaderMenuButton: true,
    };
}

/** Columns of a sequential Arrow view; they can be neither sorted nor filtered. */
function sequentialColumnDefs(descriptor: JdvDescriptor): GridColumnDef[] {
    const columns = [rowLabelColumn()];
    for (const column of (descriptor.columns ?? []) as unknown as {
        position: number; name: string; type: string; unsupported: string | null;
    }[]) {
        // The descriptor no longer carries the Arrow schema, so a dictionary column
        // (whose format is its index type) is aligned like a number.
        const numeric = ARROW_NUMERIC_FORMATS.has(column.type) || column.type.startsWith('d:');
        columns.push({
            headerName: column.name,
            headerTooltip: column.unsupported
                ? `${column.name}, unsupported: ${column.unsupported}`
                : `${column.name}, Arrow format: ${column.type}`,
            field: String(column.position + 1),
            type: numeric ? 'numericColumn' : 'textColumn',
            ...(numeric ? { cellDataType: false } : {}),
            filter: false,
            sortable: false,
        });
    }
    return columns;
}

export function gridColumnDefs(descriptor: JdvDescriptor): GridColumnDef[] {
    if (descriptor.access === 'sequential') {
        return sequentialColumnDefs(descriptor);
    }
    const columns: GridColumnDef[] = [rowLabelColumn()];
    for (const column of descriptor.columns ?? []) {
        const sortable = descriptor.capabilities.sort && column.sortable;
        const filterEnabled = descriptor.capabilities.filter;
        let type = 'textColumn';
        let filter: string | boolean = false;
        let filterOptions: string[] = [];
        switch (column.type) {
            case 'integer':
            case 'number':
            case 'duration':
                type = 'numericColumn';
                filter = 'agNumberColumnFilter';
                filterOptions = ORDER_FILTER_OPTIONS;
                break;
            case 'int64':
                type = 'bigintColumn';
                filter = 'agBigIntColumnFilter';
                filterOptions = INT64_FILTER_OPTIONS;
                break;
            case 'date':
                type = 'dateColumn';
                filter = 'agDateColumnFilter';
                filterOptions = ORDER_FILTER_OPTIONS;
                break;
            case 'datetime':
                type = 'datetimeColumn';
                filter = 'agDateColumnFilter';
                filterOptions = ORDER_FILTER_OPTIONS;
                break;
            case 'boolean':
                // AG Grid's boolean data type supplies its own True/False filter.
                type = 'booleanColumn';
                filter = true;
                break;
            case 'string':
            case 'categorical':
                filter = 'agTextColumnFilter';
                filterOptions = TEXT_FILTER_OPTIONS;
                break;
            default:
                // `list`, `other` and unknown types are display-only: only the NA
                // options apply. Never infer semantics from `class`.
                filter = 'agTextColumnFilter';
        }
        // Value operators require `filterable`; `is_na` only needs a missingness mask,
        // which every column has unless its channel failed.
        if (!column.filterable) {
            filterOptions = [];
        }
        const def: GridColumnDef = {
            headerName: column.name,
            headerTooltip: columnTooltip(column),
            field: String(column.position + 1),
            type,
            filter: filterEnabled ? filter : false,
            sortable,
            jdv: {
                filterOptions,
                naOptions: true,
                ...(column.type === 'duration' && typeof column.units === 'string' ? { units: column.units } : {}),
            },
        };
        if (column.drillable === true && descriptor.capabilities.children) {
            def.jdvDrill = column.position;
        }
        if (column.type === 'boolean') {
            def.cellDataType = 'boolean';
            delete def.jdv;
            if (!column.filterable) {
                def.filter = false;
            }
        }
        if (!filterEnabled) {
            delete def.jdv;
        }
        columns.push(def);
    }
    return columns;
}

export interface AgSortModelItem {
    colId: string;
    sort: 'asc' | 'desc';
}

export interface JdvSort {
    col: number;
    desc: boolean;
}

function fieldPosition(field: string, descriptor: JdvDescriptor): number {
    const position = Number(field) - 1;
    if (!Number.isSafeInteger(position) || position < 0 || position >= (descriptor.columns?.length ?? 0)) {
        throw new JdvRequestError('invalid_request', `Unknown column: ${field}`);
    }
    return position;
}

export function toJdvSort(sortModel: unknown, descriptor: JdvDescriptor): JdvSort[] {
    if (!Array.isArray(sortModel)) {
        return [];
    }
    return sortModel.map(item => {
        const sortItem = item as Partial<AgSortModelItem>;
        const col = fieldPosition(String(sortItem.colId), descriptor);
        if (!descriptor.columns![col].sortable) {
            throw new JdvRequestError('unsupported', `Column "${descriptor.columns![col].name}" cannot be sorted`);
        }
        return { col, desc: sortItem.sort === 'desc' };
    });
}

type FilterNode = JsonObject;

function unsupportedFilter(column: JdvColumnSchema, type: unknown): never {
    throw new JdvRequestError('unsupported',
        `Filter "${String(type)}" is not supported for column "${column.name}" (${column.type})`);
}

function canonicalInt64(value: unknown, column: JdvColumnSchema): string {
    const text = scalarText(value).trim();
    if (!/^[+-]?\d+$/.test(text)) {
        throw new JdvRequestError('invalid_request', `Invalid integer64 value for column "${column.name}"`);
    }
    return BigInt(text).toString();
}

function numberOperand(value: unknown, column: JdvColumnSchema): unknown {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(number) || value === null || value === undefined || value === '') {
        throw new JdvRequestError('invalid_request', `Invalid number for column "${column.name}"`);
    }
    if (number === Infinity) { return { special: 'pos_inf' }; }
    if (number === -Infinity) { return { special: 'neg_inf' }; }
    return number;
}

/** Duration operand: a number in the column's units, or a typed `[-]H:MM:SS[.fff]` string. */
function durationOperand(value: unknown, column: JdvColumnSchema): unknown {
    if (typeof value === 'string' && /^\s*-?\d+:\d{2}:\d{2}(\.\d+)?\s*$/.test(value)) {
        return value.trim();
    }
    return numberOperand(value, column);
}

function dateOperand(value: unknown, column: JdvColumnSchema): string {
    // AG Grid's date filter model uses "YYYY-MM-DD HH:mm:ss". Keep the
    // datetime text intact (including fractional seconds and explicit offsets)
    // so jdv can interpret it without a JavaScript Date round trip.
    const text = scalarText(value);
    const invalid = () => new JdvRequestError('invalid_request', `Invalid date for column "${column.name}"`);
    if (column.type === 'date') {
        const date = /^(\d{4}-\d{2}-\d{2})$(?![\s\S])/.exec(text);
        if (date) { return date[1]; }
        // AG Grid's filter model writes a date as "YYYY-MM-DD 00:00:00"; an actual time
        // or timezone is never discarded.
        const midnight = /^(\d{4}-\d{2}-\d{2})[ T]00:00:00$(?![\s\S])/.exec(text);
        if (midnight) { return midnight[1]; }
        throw invalid();
    }
    const datetime = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$(?![\s\S])/.exec(text);
    if (!datetime) { throw invalid(); }
    // An operand without offset uses the column's time zone in jdv.
    return `${datetime[1]}T${datetime[2] ?? '00:00:00'}${datetime[3] ?? ''}${datetime[4] ?? ''}`;
}

const ORDER_OPS: Record<string, string> = {
    equals: 'eq', notEqual: 'ne', lessThan: 'lt', lessThanOrEqual: 'le', greaterThan: 'gt', greaterThanOrEqual: 'ge',
};

function conditionNode(condition: JsonObject, col: number, column: JdvColumnSchema): FilterNode {
    const type = condition.type;
    const isNa = { op: 'is_na', col };
    if (type === NA_FILTER_OPTION || type === 'blank') {
        return isNa;
    }
    if (type === NOT_NA_FILTER_OPTION || type === 'notBlank') {
        return { op: 'not', arg: isNa };
    }
    if (!column.filterable) {
        unsupportedFilter(column, type);
    }
    switch (column.type) {
        case 'boolean':
            if (type === 'true') { return { op: 'is_true', col }; }
            if (type === 'false') { return { op: 'is_false', col }; }
            return unsupportedFilter(column, type);
        case 'integer':
        case 'number':
        case 'duration': {
            const operand = column.type === 'duration' ? durationOperand : numberOperand;
            if (type === 'inRange') {
                return {
                    op: 'between', col,
                    lower: operand(condition.filter, column), upper: operand(condition.filterTo, column),
                };
            }
            const op = ORDER_OPS[String(type)];
            return op ? { op, col, value: operand(condition.filter, column) } : unsupportedFilter(column, type);
        }
        case 'int64':
            if (type === 'equals') {
                return { op: 'eq', col, value: canonicalInt64(condition.filter, column) };
            }
            if (type === 'inRange') {
                return {
                    op: 'between', col,
                    lower: canonicalInt64(condition.filter, column), upper: canonicalInt64(condition.filterTo, column),
                };
            }
            return unsupportedFilter(column, type);
        case 'date':
        case 'datetime': {
            if (type === 'inRange') {
                return {
                    op: 'between', col,
                    lower: dateOperand(condition.dateFrom, column), upper: dateOperand(condition.dateTo, column),
                };
            }
            const op = ORDER_OPS[String(type)];
            return op ? { op, col, value: dateOperand(condition.dateFrom, column) } : unsupportedFilter(column, type);
        }
        case 'string':
        case 'categorical': {
            const value = scalarText(condition.filter);
            // As in the previous viewer, negated text conditions exclude missing values.
            const negate = (node: FilterNode): FilterNode => ({
                op: 'and', args: [{ op: 'not', arg: node }, { op: 'not', arg: isNa }],
            });
            switch (type) {
                case 'contains': return { op: 'contains', col, value };
                case 'notContains': return negate({ op: 'contains', col, value });
                case 'equals': return { op: 'text_equals', col, value };
                case 'notEqual': return negate({ op: 'text_equals', col, value });
                case 'startsWith': return { op: 'starts_with', col, value };
                case 'endsWith': return { op: 'ends_with', col, value };
                default: return unsupportedFilter(column, type);
            }
        }
        default:
            // Display-only types (`list`, `other`, unknown) accept only the NA options above.
            return unsupportedFilter(column, type);
    }
}

/** Convert an AG Grid filter model to the jdv filter AST, or `undefined` for no filter. */
export function toJdvFilter(filterModel: unknown, descriptor: JdvDescriptor): FilterNode | undefined {
    if (!isObject(filterModel)) {
        return undefined;
    }
    const nodes: FilterNode[] = [];
    for (const [field, model] of Object.entries(filterModel)) {
        if (!isObject(model)) {
            continue;
        }
        const col = fieldPosition(field, descriptor);
        const column = descriptor.columns![col];
        const conditions = Array.isArray(model.conditions) ? model.conditions.filter(isObject) : undefined;
        if (conditions && conditions.length > 0) {
            const args = conditions.map(condition => conditionNode(condition, col, column));
            nodes.push(args.length === 1 ? args[0] : {
                op: String(model.operator).toUpperCase() === 'OR' ? 'or' : 'and', args,
            });
        } else {
            nodes.push(conditionNode(model, col, column));
        }
    }
    if (nodes.length === 0) {
        return undefined;
    }
    return nodes.length === 1 ? nodes[0] : { op: 'and', args: nodes };
}

/** `object/open` params that open one drillable grid cell as a child view. */
export function cellOpenParams(descriptor: JdvDescriptor, sourceRow: unknown, column: unknown): JsonObject {
    if (descriptor.kind !== 'grid' || !descriptor.capabilities.children) {
        throw new JdvRequestError('unsupported', 'This view has no cells that can be opened.');
    }
    if (typeof sourceRow !== 'number' || !Number.isSafeInteger(sourceRow) || sourceRow < 0 ||
        typeof column !== 'number' || !Number.isSafeInteger(column) || column < 0) {
        throw new JdvRequestError('invalid_request', 'Invalid cell address.');
    }
    const schema = descriptor.columns?.find(candidate => candidate.position === column);
    if (!schema?.drillable) {
        throw new JdvRequestError('invalid_request', 'This column cannot be opened.');
    }
    return {
        view: descriptor.view,
        generation: descriptor.generation,
        path: [{ kind: 'cell', source_row: sourceRow, column }],
        // Paged keeps sorting and filtering in R, as for top-level grids.
        mode: 'paged',
    };
}

export interface TableRowsParams extends JsonObject {
    view: string;
    generation: number;
    offset: number;
    limit: number;
    sort: JdvSort[];
    filter?: FilterNode;
    cols?: number[];
}

/** jdv's default `page_columns` limit for an explicit column selection. */
const MAX_PAGE_COLUMNS = 256;

/**
 * Zero-based positions for the grid fields the webview displays, or undefined to
 * request every column. Field ids are one-based positions; "0" is the row label.
 */
function pageColumns(descriptor: JdvDescriptor, fields: unknown): number[] | undefined {
    const ncol = descriptor.columns?.length ?? 0;
    if (!Array.isArray(fields)) {
        return undefined;
    }
    const cols = new Set<number>();
    for (const field of fields) {
        if (field === '0') {
            continue;
        }
        const position = typeof field === 'string' && /^[1-9][0-9]*$/.test(field) ? Number(field) - 1 : -1;
        if (position < 0 || position >= ncol) {
            return undefined;
        }
        cols.add(position);
    }
    return cols.size >= ncol || cols.size > MAX_PAGE_COLUMNS ? undefined : [...cols];
}

export function tableRowsParams(
    descriptor: JdvDescriptor, startRow: number, endRow: number, sortModel: unknown, filterModel: unknown,
    columns?: unknown,
): TableRowsParams {
    const offset = Math.max(0, Math.floor(startRow));
    const limit = Math.max(1, Math.floor(endRow) - offset);
    const params: TableRowsParams = {
        view: descriptor.view,
        generation: descriptor.generation,
        offset,
        limit,
        sort: toJdvSort(sortModel, descriptor),
    };
    const filter = toJdvFilter(filterModel, descriptor);
    if (filter) {
        params.filter = filter;
    }
    const cols = pageColumns(descriptor, columns);
    if (cols) {
        params.cols = cols;
    }
    return params;
}

interface ColumnChannels {
    values?: unknown[];
    display?: (string | null)[];
    na?: boolean[];
}

interface PageColumn {
    schema?: JdvColumnSchema;
    data?: ColumnChannels;
    errors?: unknown;
}

export interface GridPage {
    rows: Record<string, unknown>[];
    totalRows: number;
    totalUnfiltered: number;
    lastRow: number;
    /** Rows returned; may be fewer than requested when jdv clamps the page. */
    returned: number;
}

function cellValue(column: JdvColumnSchema, channels: ColumnChannels, row: number): unknown {
    if (channels.na?.[row]) {
        // Missing cells use the grid's NA renderer, unless R labels them differently
        // (NaN, or a class-specific missing label).
        const label = channels.display?.[row];
        return typeof label === 'string' && label !== 'NA' ? label : null;
    }
    // Booleans keep their value for the grid's checkbox renderer. Everything else
    // shows the R-formatted display text; comparisons happen in R.
    if (column.type === 'boolean' && channels.values) {
        return channels.values[row] ?? null;
    }
    const display = channels.display?.[row];
    if (display !== undefined && display !== null) {
        return display;
    }
    // jdv omits display for strings, categoricals and int64 when it equals the value.
    const value = channels.values?.[row];
    return value === undefined || value === null ? null : scalarText(value);
}

function columnErrorText(errors: unknown): string | undefined {
    if (!isObject(errors)) {
        return undefined;
    }
    const messages = Object.entries(errors).map(([channel, message]) => `${channel}: ${String(message)}`);
    return messages.length > 0 ? messages.join('; ') : undefined;
}

/** Convert a `grid/rows` result to row objects keyed by the grid field ids. */
export function gridPageFromRows(result: unknown, startRow: number, requested: number): GridPage {
    if (!isObject(result) || !isObject(result.data) || typeof result.total !== 'number' ||
        typeof result.total_unfiltered !== 'number' || !Array.isArray(result.data.source_row)) {
        throw new Error('Invalid jdv grid/rows result');
    }
    const data = result.data;
    const sourceRow = data.source_row as number[];
    const rowLabels = Array.isArray(data.row_labels) ? data.row_labels as (string | null)[] : undefined;
    const columns = Array.isArray(data.columns) ? data.columns as PageColumn[] : [];
    // `source_row` is zero-based; the browser shows it plus one.
    const rows: Record<string, unknown>[] = sourceRow.map((index, row) => ({
        [ROW_LABEL_FIELD]: rowLabels?.[row] ?? String(index + 1),
        // Original zero-based row, for opening a drillable cell after sorting or filtering.
        [SOURCE_ROW_FIELD]: index,
    }));
    for (const column of columns) {
        if (!column.schema) {
            continue;
        }
        const field = String(column.schema.position + 1);
        const channels = column.data ?? {};
        const error = columnErrorText(column.errors);
        for (let row = 0; row < rows.length; row++) {
            rows[row][field] = channels.display || channels.values || channels.na
                ? cellValue(column.schema, channels, row)
                : error ? `<error: ${error}>` : null;
        }
    }
    const total = result.total;
    const returned = rows.length;
    // When jdv returns fewer rows than requested before the end, report an unknown
    // last row so the grid asks again for the remainder of the block.
    const lastRow = returned < requested && startRow + returned < total ? -1 : total;
    return { rows, totalRows: total, totalUnfiltered: result.total_unfiltered, lastRow, returned };
}

// ---------------------------------------------------------------------------
// Tree

export interface ListViewNavigation {
    title: string;
    path: number[];
    breadcrumbs: { label: string; path: number[] }[];
    vector?: boolean;
}

export interface ListViewChild {
    label: string;
    str: string;
    index: number;
    viewable?: boolean;
    has_children?: boolean;
}

interface TreeNode {
    path: JdvPathStep[];
    label: string;
    title: string;
    class: string[];
    type?: string;
    hasChildren: boolean;
    viewable: boolean;
}

interface TreeChild {
    index: number;
    label: string;
    class?: string[];
    type?: string;
    summary?: string;
    has_children?: boolean;
    viewable?: boolean;
    unavailable?: string;
    path?: JdvPathStep[];
}

export const TREE_PAGE_SIZE = 200;

const TABLE_CLASSES = new Set(['data.frame', 'matrix']);
const ATOMIC_TYPES = new Set(['logical', 'integer', 'double', 'complex', 'character', 'raw']);

/** Atomic vectors are shown as value rows, as in the previous List Viewer. */
export function isVectorType(type: string | undefined, classes: string[]): boolean {
    return type !== undefined && ATOMIC_TYPES.has(type) && !classes.includes('matrix');
}

export function isTableClass(classes: string[]): boolean {
    return classes.some(cls => TABLE_CLASSES.has(cls));
}

function childTitle(parent: TreeNode, child: TreeChild): string {
    const step = child.path?.[child.path.length - 1];
    if (step?.type === 'slot') { return `${parent.title}@${step.name}`; }
    if (step?.type === 'attr') { return `attr(${parent.title}, "${step.name}")`; }
    if (step?.type === 'binding') { return `${parent.title}$${step.name}`; }
    const label = child.label;
    return /^\[\[?\d+\]\]?$/.test(label) || label === ''
        ? `${parent.title}[[${child.index}]]` : `${parent.title}$${label}`;
}

/**
 * Maps the List Viewer's positional paths (child `index` values) to jdv typed
 * paths. Typed paths are learned from `object/children` results.
 */
export class TreeAdapter {
    private readonly nodes = new Map<string, TreeNode>();

    constructor(public descriptor: JdvDescriptor, private readonly title: string) {
        this.nodes.set('[]', {
            path: [], label: title, title, class: descriptor.class ?? [], type: descriptor.type, hasChildren: true, viewable: true,
        });
    }

    private node(path: number[]): TreeNode {
        const node = this.nodes.get(JSON.stringify(path));
        if (!node) {
            throw new JdvRequestError('unavailable', 'This item is no longer available. Reload the parent list.');
        }
        return node;
    }

    /** The typed jdv path and display title of the item at a positional path. */
    locate(path: number[]): { path: JdvPathStep[]; title: string } {
        const node = this.node(path);
        return { path: node.path, title: node.title };
    }

    navigation(path: number[] = []): ListViewNavigation {
        const node = this.node(path);
        const breadcrumbs = [];
        for (let depth = 0; depth <= path.length; depth++) {
            const prefix = path.slice(0, depth);
            breadcrumbs.push({ label: this.node(prefix).label, path: prefix });
        }
        return { title: node.title, path, breadcrumbs, vector: isVectorType(node.type, node.class) };
    }

    childrenParams(path: number[], start: number): JsonObject {
        const node = this.node(path);
        return {
            view: this.descriptor.view,
            generation: this.descriptor.generation,
            path: node.path,
            offset: Math.max(0, start - 1),
            limit: TREE_PAGE_SIZE,
            // Like the previous List Viewer, show elements without attributes such as `names`.
            attributes: false,
        };
    }

    /** Record the children of `path` and convert them to List Viewer rows. */
    children(path: number[], result: unknown): { children: ListViewChild[]; next_start: number | null } {
        if (!isObject(result) || !Array.isArray(result.children) || typeof result.offset !== 'number' ||
            typeof result.total_children !== 'number') {
            throw new Error('Invalid jdv object/children result');
        }
        const parent = this.node(path);
        const vector = isVectorType(parent.type, parent.class);
        const children = (result.children as TreeChild[]).map(child => {
            const addressable = Array.isArray(child.path) && child.viewable !== false;
            if (addressable) {
                this.nodes.set(JSON.stringify([...path, child.index]), {
                    path: child.path!,
                    label: child.label,
                    title: childTitle(parent, child),
                    class: child.class ?? [],
                    type: child.type,
                    hasChildren: child.has_children === true,
                    viewable: child.viewable !== false,
                });
            }
            const hasChildren = child.has_children === true;
            const summary = child.unavailable ? `(${child.unavailable})` : child.summary ?? '';
            return {
                // Unnamed elements are labeled by position, as in the previous List Viewer.
                label: child.label === '' ? `[[${child.index}]]` : child.label,
                str: summary,
                index: child.index,
                // Vector elements are terminal rows; other leaves have nothing to open.
                viewable: addressable && !vector && (hasChildren || isTableClass(child.class ?? [])),
                has_children: hasChildren,
            };
        });
        const end = result.offset + children.length;
        return { children, next_start: end < result.total_children ? end + 1 : null };
    }

    /** What opening the child at `path`/`index` should do. */
    open(path: number[], index: number): { kind: 'navigate'; navigation: ListViewNavigation }
        | { kind: 'object'; params: JsonObject; title: string } {
        const childPath = [...path, index];
        const node = this.node(childPath);
        if (!node.viewable) {
            throw new JdvRequestError('unavailable', 'This item cannot be opened.');
        }
        if (isTableClass(node.class)) {
            return {
                kind: 'object',
                title: node.title,
                // Paged keeps sorting and filtering in R, as for top-level grids.
                params: { view: this.descriptor.view, generation: this.descriptor.generation, path: node.path, mode: 'paged' },
            };
        }
        return { kind: 'navigate', navigation: this.navigation(childPath) };
    }
}
