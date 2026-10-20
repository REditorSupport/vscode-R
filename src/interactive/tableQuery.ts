import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';

export interface TableColumn {
    field: string;
    headerName: string;
    headerTooltip?: string;
    type?: unknown;
    sortable?: boolean;
    filter?: unknown;
}
export interface TableSort {
    colId: string;
    sort: 'asc' | 'desc';
}
export interface TableFilter {
    type: string;
    filter?: string;
}
export type TableFilters = Record<string, TableFilter>;
export const filterOperators = {
    equals: '=',
    notEqual: '≠',
    lessThan: '<',
    lessThanOrEqual: '≤',
    greaterThan: '>',
    greaterThanOrEqual: '≥',
    contains: 'contains',
    notContains: 'does not contain',
    startsWith: 'starts with',
    endsWith: 'ends with',
    blank: 'is blank',
    notBlank: 'is not blank',
    true: 'is true',
    false: 'is false',
};
export function columnOperators(column: TableColumn): string[] {
    if (column.type === 'booleanColumn') {
        return ['true', 'false', 'blank', 'notBlank'];
    }
    return ['numericColumn', 'bigintColumn', 'dateColumn', 'datetimeColumn'].includes(
        String(column.type),
    )
        ? [
              'equals',
              'notEqual',
              'lessThan',
              'lessThanOrEqual',
              'greaterThan',
              'greaterThanOrEqual',
              'blank',
              'notBlank',
          ]
        : [
              'contains',
              'notContains',
              'equals',
              'notEqual',
              'startsWith',
              'endsWith',
              'blank',
              'notBlank',
          ];
}
export const filterNeedsValue = (type: string): boolean =>
    !['blank', 'notBlank', 'true', 'false'].includes(type);
// Slicing can turn automatic row numbers into explicit character row names.
// The synthetic index is never sorted/filtered and is not part of the data schema.
export const tableSchema = (columns: TableColumn[]): unknown[][] =>
    columns
        .filter((column) => column.field !== '0')
        .map((column) => [column.field, column.headerName, column.type]);

/** Validate renderer queries and choose only handles owned by this output. */
export async function queryTablePage(
    data: Record<string, unknown>,
    message: Record<string, unknown>,
    inspect: (request: {
        method: string;
        params: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
    const size = message.size === undefined ? TABLE_PAGE_SIZE : Number(message.size);
    if (![20, 50, 100].includes(size)) {
        throw new Error('Choose 20, 50 or 100 rows per page.');
    }
    const offset = Number(message.start ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483646) {
        throw new Error('Invalid table page.');
    }
    let sort = (message.sortModel ?? []) as TableSort[];
    let filters = (message.filterModel ?? {}) as TableFilters;
    if (
        !Array.isArray(sort) ||
        sort.length > 1 ||
        !filters ||
        typeof filters !== 'object' ||
        Array.isArray(filters) ||
        Object.keys(filters).length > 100
    ) {
        throw new Error('Invalid table query.');
    }
    const full =
        !!data.fullViewId &&
        (message.live === true ||
            offset + size > Number(data.totalRows) ||
            sort.length > 0 ||
            Object.keys(filters).length > 0);
    const viewId = full ? data.fullViewId : data.viewId;
    let columns = data.columns as TableColumn[];
    let queryReset = false;
    if (full && message.refresh === true) {
        const metadata = await inspect({ method: 'dataview_init', params: { view_id: viewId } });
        columns = metadata.columns as TableColumn[];
        // A by-reference rename/reorder must never apply a filter to the wrong column.
        if (JSON.stringify(tableSchema(columns)) !== JSON.stringify(message.schema)) {
            queryReset = sort.length > 0 || Object.keys(filters).length > 0;
            sort = [];
            filters = {};
        }
    } else if (full && Array.isArray(message.columns)) {
        // The live schema may differ from the historical cell after a refresh.
        // Use it only for validating field IDs; R still owns data and schema checks.
        columns = message.columns as TableColumn[];
    }
    if (!Array.isArray(columns) || columns.length > 100000) {
        throw new Error('Invalid table columns.');
    }
    for (const item of sort) {
        if (
            !item ||
            !['asc', 'desc'].includes(item.sort) ||
            !columns.some(
                (column) =>
                    column.field === item.colId &&
                    column.field !== '0' &&
                    column.sortable !== false,
            )
        ) {
            throw new Error('This column cannot be sorted.');
        }
    }
    for (const [field, filter] of Object.entries(filters)) {
        const column = columns.find(
            (column) => column.field === field && column.field !== '0' && column.filter !== false,
        );
        if (
            !column ||
            !filter ||
            !columnOperators(column).includes(filter.type) ||
            (filterNeedsValue(filter.type) &&
                (typeof filter.filter !== 'string' || filter.filter.length > 1000))
        ) {
            throw new Error('Invalid column filter.');
        }
    }
    // Do not clamp to the snapshot's count, or to a stale count after live edits.
    let start = queryReset ? 0 : Math.floor(offset / size) * size;
    const fetch = (): Promise<Record<string, unknown>> =>
        inspect({
            method: 'dataview_page',
            params: {
                view_id: viewId,
                startRow: start,
                endRow: Math.min(2147483647, start + size),
                sortModel: sort,
                filterModel: filters,
                formatNumbers: true,
            },
        });
    let result = await fetch();
    if (Number(result.totalRows) > 0 && start >= Number(result.totalRows)) {
        start = tablePage(Number(result.totalRows), start, size).start;
        result = await fetch();
    }
    return {
        ...result,
        startRow: Number(result.totalRows) === 0 ? 0 : start,
        columns,
        live: full,
        queryReset,
    };
}
