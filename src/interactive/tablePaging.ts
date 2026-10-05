// Match the R-side inline preview so advancing a page never skips unseen rows.
export const TABLE_PAGE_SIZE = 20;

export function tablePage(
    total: number,
    start: number,
    size = TABLE_PAGE_SIZE,
): { start: number; end: number } {
    size = [20, 50, 100].includes(size) ? size : TABLE_PAGE_SIZE;
    const count = Number.isSafeInteger(total) && total > 0 ? total : 0;
    const last = Math.max(0, Math.ceil(count / size) - 1) * size;
    const offset = Number.isFinite(start) ? Math.max(0, Math.floor(start / size)) * size : 0;
    const first = Math.min(last, offset);
    return { start: first, end: Math.min(count, first + size) };
}
