/** Notebook edits invalidate identities; output-only updates leave them intact. */
export class ExecutionCellIndex<Cell extends { metadata: { rExecutionId?: unknown } }> {
    private cells?: Map<string, Cell>;

    invalidate(): void {
        this.cells = undefined;
    }

    get(id: string, readCells: () => readonly Cell[]): Cell | undefined {
        if (!this.cells) {
            this.cells = new Map();
            for (const cell of readCells()) {
                if (typeof cell.metadata.rExecutionId === 'string') {
                    // Preserve the first matching cell, as the former find() did.
                    if (!this.cells.has(cell.metadata.rExecutionId)) {
                        this.cells.set(cell.metadata.rExecutionId, cell);
                    }
                }
            }
        }
        return this.cells.get(id);
    }
}
