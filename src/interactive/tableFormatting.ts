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
    return value === null ? 'NA' : String(value ?? '');
}
