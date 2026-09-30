// Match the R-side inline preview so advancing a page never skips unseen rows.
export const TABLE_PAGE_SIZE = 20;

export function tablePage(total: number, start: number): { start: number; end: number } {
    const count = Number.isSafeInteger(total) && total > 0 ? total : 0;
    const last = Math.max(0, Math.ceil(count / TABLE_PAGE_SIZE) - 1) * TABLE_PAGE_SIZE;
    const offset = Number.isFinite(start) ? Math.max(0, Math.floor(start / TABLE_PAGE_SIZE)) * TABLE_PAGE_SIZE : 0;
    const first = Math.min(last, offset);
    return { start: first, end: Math.min(count, first + TABLE_PAGE_SIZE) };
}
