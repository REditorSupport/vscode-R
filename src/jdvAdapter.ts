'use strict';

// Adapter between the jdv protocol and the existing Data Viewer and List Viewer
// webviews. It is independent of VS Code so the conversions can be tested in Node.

export type JsonObject = Record<string, unknown>;

export interface JdvCapabilities {
    seek: boolean;
    sort: boolean;
    filter: boolean;
    known_total: boolean;
    next: boolean;
    children: boolean;
}

export interface JdvColumnSchema {
    position: number;
    name: string;
    type: string;
    class?: string[];
    sortable: boolean;
    filterable: boolean;
    drillable?: boolean;
    levels?: string[];
    ordered?: boolean;
    tz?: string;
}

export interface JdvDescriptor {
    view: string;
    generation: number;
    kind: 'grid' | 'tree';
    access: string;
    encoding: string;
    capabilities: JdvCapabilities;
    title?: string | null;
    mode?: string;
    nrow?: number | null;
    ncol?: number;
    columns?: JdvColumnSchema[];
    path?: JdvPathStep[];
    class?: string[];
    parent?: string;
}

export type JdvPathStep =
    | { type: 'index'; index: number }
    | { type: 'binding' | 'slot' | 'attr'; name: string };

export interface JdvError {
    code: string;
    message: string;
}

export class JdvRequestError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

/** A channel that sends one jdv request and returns its `result`. */
export interface JdvChannel {
    request(method: string, params: JsonObject): Promise<unknown>;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text of a scalar filter operand or channel value; other values become ''. */
function scalarText(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ||
        typeof value === 'boolean' ? String(value) : '';
}

/** Parse a `view/open` message or a direct descriptor (as returned by `object/open`). */
export function parseDescriptor(value: unknown): JdvDescriptor {
    const message = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    const params = isObject(message) && message.method === 'view/open' ? message.params : message;
    if (!isObject(params) || typeof params.view !== 'string' || typeof params.generation !== 'number' ||
        (params.kind !== 'grid' && params.kind !== 'tree') || !isObject(params.capabilities)) {
        throw new Error('Invalid jdv view descriptor');
    }
    if (params.kind === 'grid' && !Array.isArray(params.columns)) {
        throw new Error('Invalid jdv grid descriptor');
    }
    return params as unknown as JdvDescriptor;
}

/** Return the view ids and generations announced by `view/closed` notifications. */
export function parseClosedNotifications(values: unknown): { view: string; generation: number }[] {
    const list: unknown[] = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
    const closed: { view: string; generation: number }[] = [];
    for (const value of list) {
        try {
            const message = typeof value === 'string' ? JSON.parse(value) as unknown : value;
            if (isObject(message) && message.method === 'view/closed' && isObject(message.params) &&
                typeof message.params.view === 'string' && typeof message.params.generation === 'number') {
                closed.push({ view: message.params.view, generation: message.params.generation });
            }
        } catch {
            // Ignore malformed notifications; they cannot identify a view.
        }
    }
    return closed;
}

/** Unwrap a jdv response envelope, throwing its error code and message. */
export function unwrapResponse(response: unknown): unknown {
    const message = typeof response === 'string' ? JSON.parse(response) as unknown : response;
    if (!isObject(message)) {
        throw new Error('Invalid jdv response');
    }
    if (isObject(message.error)) {
        const error = message.error as Partial<JdvError>;
        throw new JdvRequestError(String(error.code ?? 'unknown'), String(error.message ?? 'jdv request failed'));
    }
    if (!('result' in message)) {
        throw new Error('Invalid jdv response');
    }
    return message.result;
}

// ---------------------------------------------------------------------------
// Grid

/** Row label column. Data columns use their one-based position as field id. */
export const ROW_LABEL_FIELD = '0';

export interface GridColumnDef {
    headerName: string;
    headerTooltip?: string;
    field: string;
    type: string;
    filter: string | boolean;
    sortable: boolean;
    cellDataType?: string;
    suppressHeaderMenuButton?: boolean;
    lockPosition?: string;
    /** Webview-only options; see prepareViewerColumns(). */
    jdv?: { filterOptions: string[]; naOptions: boolean };
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
    let tooltip = `${column.name}, class: [${(column.class ?? []).join(', ')}], type: ${column.type}`;
    if (column.type === 'factor' && Array.isArray(column.levels)) {
        const levels = column.levels.slice(0, 20).join(', ');
        tooltip += `, levels: ${levels}${column.levels.length > 20 ? ', ...' : ''}`;
    }
    if (column.type === 'datetime' && column.tz !== undefined) {
        tooltip += `, tz: ${column.tz || '(local)'}`;
    }
    return tooltip;
}

export function gridColumnDefs(descriptor: JdvDescriptor): GridColumnDef[] {
    const columns: GridColumnDef[] = [{
        headerName: '',
        field: ROW_LABEL_FIELD,
        type: 'textColumn',
        filter: false,
        sortable: false,
        lockPosition: 'left',
        suppressHeaderMenuButton: true,
    }];
    for (const column of descriptor.columns ?? []) {
        const sortable = descriptor.capabilities.sort && column.sortable;
        const filterEnabled = descriptor.capabilities.filter;
        let type = 'textColumn';
        let filter: string | boolean = false;
        let filterOptions: string[] = [];
        switch (column.type) {
            case 'integer':
            case 'number':
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
            default:
                filter = 'agTextColumnFilter';
                filterOptions = TEXT_FILTER_OPTIONS;
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
            jdv: { filterOptions, naOptions: true },
        };
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

function dateOperand(value: unknown, column: JdvColumnSchema): string {
    // AG Grid date filters use "YYYY-MM-DD HH:mm:ss" in the column's wall time.
    const text = scalarText(value);
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/.exec(text);
    if (!match) {
        throw new JdvRequestError('invalid_request', `Invalid date for column "${column.name}"`);
    }
    if (column.type === 'date') {
        return match[1];
    }
    // An operand without offset uses the column's time zone in jdv.
    return `${match[1]}T${match[2] ?? '00:00:00'}`;
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
        case 'number': {
            if (type === 'inRange') {
                return {
                    op: 'between', col,
                    lower: numberOperand(condition.filter, column), upper: numberOperand(condition.filterTo, column),
                };
            }
            const op = ORDER_OPS[String(type)];
            return op ? { op, col, value: numberOperand(condition.filter, column) } : unsupportedFilter(column, type);
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
        default: {
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

export interface TableRowsParams extends JsonObject {
    view: string;
    generation: number;
    offset: number;
    limit: number;
    sort: JdvSort[];
    filter?: FilterNode;
}

export function tableRowsParams(
    descriptor: JdvDescriptor, startRow: number, endRow: number, sortModel: unknown, filterModel: unknown,
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
    // jdv omits display for strings, factors and int64 when it equals the value.
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

/** Convert a `table/rows` result to row objects keyed by the grid field ids. */
export function gridPageFromRows(result: unknown, startRow: number, requested: number): GridPage {
    if (!isObject(result) || !isObject(result.data) || typeof result.total !== 'number' ||
        typeof result.total_unfiltered !== 'number' || !Array.isArray(result.data.row_index)) {
        throw new Error('Invalid jdv table/rows result');
    }
    const data = result.data;
    const rowIndex = data.row_index as number[];
    const rowNames = Array.isArray(data.row_names) ? data.row_names as (string | null)[] : undefined;
    const columns = Array.isArray(data.columns) ? data.columns as PageColumn[] : [];
    const rows: Record<string, unknown>[] = rowIndex.map((index, row) => ({
        [ROW_LABEL_FIELD]: rowNames?.[row] ?? String(index),
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
    hasChildren: boolean;
    viewable: boolean;
}

interface TreeChild {
    index: number;
    label: string;
    class?: string[];
    summary?: string;
    has_children?: boolean;
    viewable?: boolean;
    unavailable?: string;
    path?: JdvPathStep[];
}

export const TREE_PAGE_SIZE = 200;

const ATOMIC_CLASSES = new Set([
    'logical', 'integer', 'numeric', 'double', 'character', 'complex', 'raw',
    'factor', 'Date', 'POSIXct', 'difftime', 'integer64',
]);
const TABLE_CLASSES = new Set(['data.frame', 'matrix']);

/** Atomic vectors are shown as value rows, as in the previous List Viewer. */
export function isVectorClass(classes: string[]): boolean {
    return classes.length > 0 && classes.every(cls => ATOMIC_CLASSES.has(cls) || cls === 'array' || cls === 'ordered') &&
        !classes.includes('matrix');
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
            path: [], label: title, title, class: descriptor.class ?? [], hasChildren: true, viewable: true,
        });
    }

    private node(path: number[]): TreeNode {
        const node = this.nodes.get(JSON.stringify(path));
        if (!node) {
            throw new JdvRequestError('unavailable', 'This item is no longer available. Reload the parent list.');
        }
        return node;
    }

    navigation(path: number[] = []): ListViewNavigation {
        const node = this.node(path);
        const breadcrumbs = [];
        for (let depth = 0; depth <= path.length; depth++) {
            const prefix = path.slice(0, depth);
            breadcrumbs.push({ label: this.node(prefix).label, path: prefix });
        }
        return { title: node.title, path, breadcrumbs, vector: isVectorClass(node.class) };
    }

    childrenParams(path: number[], start: number): JsonObject {
        const node = this.node(path);
        return {
            view: this.descriptor.view,
            generation: this.descriptor.generation,
            path: node.path,
            offset: Math.max(0, start - 1),
            limit: TREE_PAGE_SIZE,
        };
    }

    /** Record the children of `path` and convert them to List Viewer rows. */
    children(path: number[], result: unknown): { children: ListViewChild[]; next_start: number | null } {
        if (!isObject(result) || !Array.isArray(result.children) || typeof result.offset !== 'number' ||
            typeof result.total_children !== 'number') {
            throw new Error('Invalid jdv object/children result');
        }
        const parent = this.node(path);
        const vector = isVectorClass(parent.class);
        const children = (result.children as TreeChild[]).map(child => {
            const addressable = Array.isArray(child.path) && child.viewable !== false;
            if (addressable) {
                this.nodes.set(JSON.stringify([...path, child.index]), {
                    path: child.path!,
                    label: child.label,
                    title: childTitle(parent, child),
                    class: child.class ?? [],
                    hasChildren: child.has_children === true,
                    viewable: child.viewable !== false,
                });
            }
            const summary = child.unavailable ? `(${child.unavailable})` : child.summary ?? '';
            return {
                label: child.label,
                str: summary,
                index: child.index,
                // Vector elements are terminal rows in the List Viewer.
                viewable: addressable && !vector,
                has_children: !vector && child.has_children === true,
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
                params: { view: this.descriptor.view, generation: this.descriptor.generation, path: node.path },
            };
        }
        return { kind: 'navigate', navigation: this.navigation(childPath) };
    }
}
