import { GridPage, JdvDescriptor, JdvRequestError, JsonObject, gridPageFromRows, tableRowsParams } from './jdvAdapter';

/** Fill an AG Grid block, retrying oversized column selections with adaptive all-column pages. */
export async function fetchGridPage(
    descriptor: JdvDescriptor, message: JsonObject,
    request: (method: string, params: JsonObject) => Promise<unknown>,
): Promise<Omit<GridPage, 'returned'>> {
    const startRow = Number(message.startRow ?? 0);
    const endRow = Number(message.endRow ?? 0);
    // Only the displayed columns; the webview reloads its cache when a hidden column is shown.
    let columns = message.columns;
    const rows: Record<string, unknown>[] = [];
    let page: GridPage | undefined;
    let offset = startRow;
    while (offset < endRow) {
        const params = tableRowsParams(descriptor, offset, endRow, message.sortModel, message.filterModel, columns);
        let result: unknown;
        try {
            result = await request('grid/rows', params);
        } catch (e) {
            // jdv shortens pages only when every column is selected; an explicit
            // selection that does not fit fails, so fall back to all columns.
            if (params.cols && e instanceof JdvRequestError && e.code === 'limit_exceeded') {
                columns = undefined;
                continue;
            }
            throw e;
        }
        page = gridPageFromRows(result, offset, params.limit);
        for (const row of page.rows) {
            rows.push(row);
        }
        offset += page.returned;
        if (page.returned === 0 || offset >= page.totalRows) {
            break;
        }
    }
    if (!page) {
        throw new JdvRequestError('invalid_request', 'Empty page request');
    }
    return { rows, totalRows: page.totalRows, totalUnfiltered: page.totalUnfiltered, lastRow: page.totalRows };
}
