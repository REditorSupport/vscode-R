'use strict';

// Inline table and list previews backed by registry-free jdv handles. The R side
// owns one handle per output and answers `jdv_handle_request` inspections; this
// module converts between jdv's protocol shapes and the renderer's data. It has no
// VS Code dependency, so the agent, the extension host and tests can all use it.

import {
    JdvDescriptor, JdvPathStep, JdvRequestError, JsonObject, ListViewChild, TreeAdapter, gridColumnDefs,
    gridPageFromRows, parseDescriptor, tableRowsParams,
} from '../jdvAdapter';
import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';
import { columnOperators, filterNeedsValue, TableColumn, TableFilters, TableSort } from './tableQuery';

export type Inspect = (request: { method: string; params: Record<string, unknown> }) => Promise<Record<string, unknown>>;

/** Largest JSON result requested for one page, matching the R side's preview bound. */
export const PAGE_BYTES = 256 * 1024;

/** Whether a display event came from a jdv handle (as opposed to the dataview registry). */
export function isJdvOutput(data: Record<string, unknown>): boolean {
    return typeof data.handleId === 'string' && data.handleId !== '';
}

function parseJson(text: unknown, what: string): unknown {
    if (typeof text !== 'string') { throw new Error(`Invalid jdv ${what}`); }
    return JSON.parse(text);
}

function descriptorOf(data: Record<string, unknown>): JdvDescriptor {
    return parseDescriptor(typeof data.descriptor === 'string' ? JSON.parse(data.descriptor) : data.descriptor);
}

/**
 * Agent side: turn the raw descriptor and preview pages that R sent into the data the
 * renderer, exports and transcript already understand (columns and rows for a
 * table; navigation and children for a list). The parsed descriptor stays so the
 * host can query the same handle later.
 */
export function normalizeJdvDisplay(data: Record<string, unknown>): Record<string, unknown> {
    if (!isJdvOutput(data)) { return data; }
    const descriptor = parseDescriptor(parseJson(data.descriptor, 'descriptor'));
    const rawPage = data.page;
    const { page: _page, ...rest } = data;
    if (data.kind === 'table' && descriptor.kind === 'grid') {
        const pages = (Array.isArray(rawPage) ? rawPage : [rawPage]).map(page => parseJson(page, 'page'));
        const rows: Record<string, unknown>[] = [];
        let totalRows = 0;
        for (const raw of pages) {
            const next = gridPageFromRows(raw, rows.length, TABLE_PAGE_SIZE - rows.length);
            rows.push(...next.rows);
            totalRows = next.totalRows;
            if (rows.length >= TABLE_PAGE_SIZE) { break; }
        }
        return { ...rest, descriptor, columns: gridColumnDefs(descriptor), rows, totalRows };
    }
    if (data.kind === 'list' && descriptor.kind === 'tree') {
        const adapter = new TreeAdapter(descriptor, 'List');
        return {
            ...rest, descriptor, navigation: adapter.navigation([]),
            ...adapter.children([], parseJson(rawPage, 'page')),
        };
    }
    throw new Error('The jdv descriptor does not match the output kind');
}

// ---------------------------------------------------------------------------
// Tables

/** AG Grid names the date operand `dateFrom`; the inline filter UI writes `filter`. */
function filterModel(filters: TableFilters, columns: TableColumn[]): Record<string, unknown> {
    const model: Record<string, unknown> = {};
    for (const [field, filter] of Object.entries(filters)) {
        const type = columns.find(column => column.field === field)?.type;
        model[field] = type === 'dateColumn' || type === 'datetimeColumn' ? { ...filter, dateFrom: filter.filter } : filter;
    }
    return model;
}

/** Validate a renderer table query, as the dataview path does. */
function validateQuery(columns: TableColumn[], sort: TableSort[], filters: TableFilters): void {
    for (const item of sort) {
        if (!item || !['asc', 'desc'].includes(item.sort) ||
            !columns.some(column => column.field === item.colId && column.field !== '0' && column.sortable !== false)) {
            throw new Error('This column cannot be sorted.');
        }
    }
    for (const [field, filter] of Object.entries(filters)) {
        const column = columns.find(column => column.field === field && column.field !== '0' && column.filter !== false);
        if (!column || !filter || !columnOperators(column).includes(filter.type) ||
            (filterNeedsValue(filter.type) && (typeof filter.filter !== 'string' || filter.filter.length > 1000))) {
            throw new Error('Invalid column filter.');
        }
    }
}

/** Fetch one inline table page from the output's handle, sorted and filtered in R. */
export async function queryJdvTablePage(
    data: Record<string, unknown>, message: Record<string, unknown>, inspect: Inspect,
): Promise<Record<string, unknown>> {
    const size = message.size === undefined ? TABLE_PAGE_SIZE : Number(message.size);
    if (![20, 50, 100].includes(size)) { throw new Error('Choose 20, 50 or 100 rows per page.'); }
    const offset = Number(message.start ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483646) { throw new Error('Invalid table page.'); }
    const sort = (message.sortModel ?? []) as TableSort[];
    const filters = (message.filterModel ?? {}) as TableFilters;
    if (!Array.isArray(sort) || sort.length > 1 || !filters || typeof filters !== 'object' || Array.isArray(filters) ||
        Object.keys(filters).length > 100) {
        throw new Error('Invalid table query.');
    }
    const columns = data.columns as TableColumn[];
    if (!Array.isArray(columns) || columns.length > 100000) { throw new Error('Invalid table columns.'); }
    validateQuery(columns, sort, filters);
    const descriptor = descriptorOf(data);
    const model = filterModel(filters, columns);

    const fetch = async (from: number) => {
        const rows: Record<string, unknown>[] = [];
        let total = 0;
        let unfiltered = 0;
        let cursor = from;
        while (rows.length < size) {
            const wanted = size - rows.length;
            const { view: _view, generation: _generation, ...params } =
                tableRowsParams(descriptor, cursor, cursor + wanted, sort, model);
            if (!params.sort.length) { delete (params as { sort?: unknown }).sort; }
            const reply = await inspect({ method: 'jdv_handle_request', params: {
                handle_id: data.handleId, method: 'grid/rows', params, max_bytes: PAGE_BYTES,
            } });
            const page = gridPageFromRows(parseJson(reply.json, 'page'), cursor, wanted);
            rows.push(...page.rows);
            total = page.totalRows;
            unfiltered = page.totalUnfiltered;
            cursor += page.returned;
            // jdv may return fewer rows than requested to fit the byte budget.
            if (page.returned === 0 || cursor >= total) { break; }
        }
        return { rows, total, unfiltered };
    };
    let start = Math.floor(offset / size) * size;
    let result = await fetch(start);
    if (result.total > 0 && start >= result.total) {
        start = tablePage(result.total, start, size).start;
        result = await fetch(start);
    }
    return {
        rows: result.rows, totalRows: result.total, totalUnfiltered: result.unfiltered,
        startRow: result.total === 0 ? 0 : start, columns, live: true, queryReset: false,
    };
}

// ---------------------------------------------------------------------------
// Lists

/** What a list request needs the host to do besides replying. */
export interface ListOutcome {
    result?: unknown;
    /** Open this item (typed path and title) in the Data Viewer panel. */
    open?: { path: JdvPathStep[]; title: string };
}

/** A fresh adapter for an output, primed with the root page the renderer already shows. */
export async function createListAdapter(data: Record<string, unknown>, inspect: Inspect): Promise<TreeAdapter> {
    const adapter = new TreeAdapter(descriptorOf(data), 'List');
    const reply = await inspect({ method: 'jdv_handle_request', params: {
        handle_id: data.handleId, method: 'object/children', params: stripOwner(adapter.childrenParams([], 1)),
        max_bytes: PAGE_BYTES,
    } });
    adapter.children([], parseJson(reply.json, 'children'));
    return adapter;
}

function stripOwner(params: JsonObject): JsonObject {
    const { view: _view, generation: _generation, ...rest } = params;
    return rest;
}

/** Serve a renderer list action (`list`, `listPage`, `listNavigate`, `listItem`) from the handle. */
export async function listRequest(
    adapter: TreeAdapter, data: Record<string, unknown>, message: Record<string, unknown>, inspect: Inspect,
): Promise<ListOutcome> {
    const path = message.path as number[];
    switch (message.action) {
        case 'listPage': {
            const reply = await inspect({ method: 'jdv_handle_request', params: {
                handle_id: data.handleId, method: 'object/children',
                params: stripOwner(adapter.childrenParams(path, Number(message.start))), max_bytes: PAGE_BYTES,
            } });
            return { result: adapter.children(path, parseJson(reply.json, 'children')) };
        }
        case 'listNavigate':
            return { result: { navigation: adapter.navigation(path) } };
        case 'listItem': {
            const action = adapter.open(path, Number(message.index));
            if (action.kind === 'navigate') { return { result: { navigation: action.navigation } }; }
            return { open: adapter.locate([...path, Number(message.index)]) };
        }
        case 'list':
            return { open: adapter.locate(path) };
        default:
            throw new JdvRequestError('invalid_request', 'Unsupported list action');
    }
}

export type { ListViewChild };
