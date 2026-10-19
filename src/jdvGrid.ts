import { GridPage, JdvDescriptor, JdvRequestError, JsonObject, gridPageFromRows, tableRowsParams } from './jdvAdapter';

/** Fill an AG Grid block, issuing further pages when jdv shortens a selected-column page. */
export async function fetchGridPage(
    descriptor: JdvDescriptor, message: JsonObject,
    request: (method: string, params: JsonObject) => Promise<unknown>,
): Promise<Omit<GridPage, 'returned'>> {
    const startRow = Number(message.startRow ?? 0);
    const endRow = Number(message.endRow ?? 0);
    const rows: Record<string, unknown>[] = [];
    let page: GridPage | undefined;
    let offset = startRow;
    while (offset < endRow) {
        // Keep the displayed-column selection for every short page in the block.
        const params = tableRowsParams(descriptor, offset, endRow, message.sortModel, message.filterModel, message.columns);
        const result = await request('grid/rows', params);
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
