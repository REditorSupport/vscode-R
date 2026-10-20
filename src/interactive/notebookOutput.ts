import type { NotebookCellExecution, NotebookCellOutput } from 'vscode';

/** Keep existing output identities while an execution appends or updates results. */
export async function updateNotebookOutputs(
    execution: Pick<NotebookCellExecution, 'replaceOutput' | 'replaceOutputItems' | 'appendOutput'>,
    previous: readonly NotebookCellOutput[],
    next: readonly NotebookCellOutput[],
): Promise<void> {
    const compatible =
        previous.length <= next.length &&
        previous.every(
            (output, index) =>
                JSON.stringify(output.metadata) === JSON.stringify(next[index].metadata) &&
                (typeof output.metadata?.rDisplayId === 'string' ||
                    output.items.map((item) => item.mime).join('\n') ===
                        next[index].items.map((item) => item.mime).join('\n')),
        );
    if (!compatible) {
        await execution.replaceOutput(next);
        return;
    }
    for (let index = 0; index < previous.length; index++) {
        const output = previous[index],
            items = next[index].items;
        if (
            output.items.length !== items.length ||
            output.items.some(
                (item, itemIndex) =>
                    item.mime !== items[itemIndex].mime ||
                    Buffer.compare(item.data, items[itemIndex].data) !== 0,
            )
        ) {
            await execution.replaceOutputItems(items, output);
        }
    }
    if (next.length > previous.length) {
        await execution.appendOutput(next.slice(previous.length));
    }
}
