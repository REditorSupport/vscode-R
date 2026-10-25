import type { NotebookCellExecution, NotebookCellOutput } from 'vscode';
import type { StreamSnapshot, StreamText } from './streamText';

const streams = new WeakMap<NotebookCellOutput, StreamSnapshot>();

/** Text is encoded only after a render is confirmed current and ready to write. */
export function prepareNotebookStream(output: NotebookCellOutput, snapshot: StreamSnapshot): void {
    streams.set(output, snapshot);
}

export class NotebookOutputState {
    private delivered = new WeakMap<
        StreamText,
        { length: number; output: NotebookCellOutput; data: Uint8Array }
    >();

    get(
        snapshot: StreamSnapshot,
    ): { length: number; output: NotebookCellOutput; data: Uint8Array } | undefined {
        return this.delivered.get(snapshot.source);
    }

    set(snapshot: StreamSnapshot, output: NotebookCellOutput): void {
        this.delivered.set(snapshot.source, {
            length: snapshot.length,
            output,
            data: output.items[0].data,
        });
    }

    reset(): void {
        this.delivered = new WeakMap();
    }
}

function materialize(output: NotebookCellOutput): number | undefined {
    const snapshot = streams.get(output);
    if (!snapshot) {
        return;
    }
    const bytes = Buffer.from(snapshot.text());
    output.items = [{ mime: output.items[0].mime, data: bytes }];
    return bytes.length;
}

/** Keep existing output identities while an execution appends or updates results. */
export async function updateNotebookOutputs(
    execution: Pick<
        NotebookCellExecution,
        'replaceOutput' | 'replaceOutputItems' | 'appendOutput'
    > &
        Partial<Pick<NotebookCellExecution, 'appendOutputItems'>>,
    previous: readonly NotebookCellOutput[],
    next: readonly NotebookCellOutput[],
    state = new NotebookOutputState(),
    readOutputs?: () => readonly NotebookCellOutput[],
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
        next.forEach(materialize);
        await execution.replaceOutput(next);
        next.forEach((output, index) => {
            const snapshot = streams.get(output);
            if (snapshot) {
                state.set(snapshot, readOutputs?.()[index] ?? output);
            }
        });
        return;
    }
    for (let index = 0; index < previous.length; index++) {
        const output = previous[index],
            snapshot = streams.get(next[index]),
            delivered = snapshot && state.get(snapshot);
        if (
            snapshot &&
            delivered &&
            snapshot.length >= delivered.length &&
            delivered.output === output &&
            output.items.length === 1 &&
            // Appends normalize CR/backspace; use the acknowledged model buffer.
            output.items[0].data === delivered.data &&
            execution.appendOutputItems
        ) {
            const bytes = Buffer.from(snapshot.text(delivered.length));
            if (bytes.length) {
                await execution.appendOutputItems(
                    { mime: output.items[0].mime, data: bytes },
                    output,
                );
            }
            state.set(snapshot, readOutputs?.()[index] ?? output);
            continue;
        }
        materialize(next[index]);
        const items = next[index].items;
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
        if (snapshot) {
            state.set(snapshot, readOutputs?.()[index] ?? output);
        }
    }
    if (next.length > previous.length) {
        const added = next.slice(previous.length);
        added.forEach(materialize);
        await execution.appendOutput(added);
        added.forEach((output, index) => {
            const snapshot = streams.get(output);
            if (snapshot) {
                state.set(snapshot, readOutputs?.()[previous.length + index] ?? output);
            }
        });
    }
}
