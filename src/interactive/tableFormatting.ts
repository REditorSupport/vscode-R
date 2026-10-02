/** Saved previews must distinguish their retained rows from the full dataset. */
export function tableSnapshotSummary(data: Record<string, unknown>): string {
    const rows = Number(data.totalRows);
    const source = Number(data.sourceRows);
    return Number.isSafeInteger(rows) && Number.isSafeInteger(source) && source > rows
        ? `Snapshot: first ${rows.toLocaleString('en-US')} of ${source.toLocaleString('en-US')} rows` : '';
}

export function tableColumnAlignment(data: Record<string, unknown>, column: { field: string; type?: unknown }): 'left' | 'right' {
    const types = Array.isArray(column.type) ? column.type : [column.type];
    if (types.some(type => type === 'numericColumn' || type === 'bigintColumn')) { return 'right'; }
    if (column.type !== undefined) { return 'left'; }
    const values = ((data.rows ?? []) as Record<string, unknown>[]).map(row => row[column.field]).filter(value => value !== null && value !== undefined);
    return values.length && values.every(value => typeof value === 'number') ? 'right' : 'left';
}

/** Display labels are separate from the numeric values used by the data viewer. */
export function tableDisplayValue(data: Record<string, unknown>, row: Record<string, unknown>, field: string, rowIndex: number): string {
    const columns = data.formattedColumns as Record<string, unknown> | undefined;
    const labels = columns?.[field];
    if (Array.isArray(labels) && typeof labels[rowIndex] === 'string') { return labels[rowIndex]; }
    const value = row[field];
    // Older persistent agents and saved outputs have no R-formatted labels.
    // Approximate R's default digits = 7 without rounding integer IDs or parsing strings.
    if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
        return String(Number(value.toPrecision(7)));
    }
    if (value !== null && typeof value === 'object') { return JSON.stringify(value); }
    return value === null ? 'NA' : String(value ?? '');
}
