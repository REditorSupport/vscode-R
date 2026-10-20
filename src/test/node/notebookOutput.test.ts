import * as assert from 'assert';
import type { NotebookCellExecution, NotebookCellOutput } from 'vscode';
import { updateNotebookOutputs } from '../../interactive/notebookOutput';

const plot = (svg: string, embedded = true): NotebookCellOutput => ({
    metadata: { rDisplayId: 'plot-1' },
    items: [
        {
            mime: 'application/vnd.vscode-r.display+json',
            data: Buffer.from(JSON.stringify({ kind: 'plot', svg })),
        },
        ...(embedded ? [{ mime: 'image/svg+xml', data: Buffer.from(svg) }] : []),
    ],
});
const stream = (text: string): NotebookCellOutput => ({
    items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from(text) }],
});

suite('Interactive notebook output updates', () => {
    function execution(
        outputs: NotebookCellOutput[],
    ): Pick<NotebookCellExecution, 'replaceOutput' | 'replaceOutputItems' | 'appendOutput'> {
        return {
            replaceOutput: () => assert.fail('Existing plot outputs must not be replaced'),
            replaceOutputItems: (items, output) => {
                assert.ok(
                    outputs.includes(output),
                    'Updates must use the existing VS Code output handle',
                );
                output.items = 'mime' in items ? [items] : [...items];
                return Promise.resolve();
            },
            appendOutput: (added) => {
                outputs.push(...('items' in added ? [added] : added));
                return Promise.resolve();
            },
        };
    }

    test('retains plot identity through partial frames, console output and the final frame', async () => {
        const initial = plot('panel 1'),
            outputs = [initial];
        const task = execution(outputs);
        await updateNotebookOutputs(task, [...outputs], [plot('panels 1-4'), stream('drawing')]);
        await updateNotebookOutputs(
            task,
            [...outputs],
            [plot('panels 1-8'), stream('drawing\ndone')],
        );
        assert.strictEqual(outputs[0], initial);
        assert.strictEqual(Buffer.from(outputs[0].items[1].data).toString(), 'panels 1-8');
        assert.strictEqual(Buffer.from(outputs[1].items[0].data).toString(), 'drawing\ndone');
    });

    test('preserves a growing plot when it exceeds the embedded asset limit', async () => {
        const initial = plot('small'),
            outputs = [initial];
        await updateNotebookOutputs(execution(outputs), [...outputs], [plot('large', false)]);
        assert.strictEqual(outputs[0], initial);
        assert.strictEqual(outputs[0].items.length, 1);
    });

    test('does not rerender unchanged plots when an execution finishes', async () => {
        const outputs = [plot('final')],
            task = execution(outputs);
        task.replaceOutputItems = () => assert.fail('Unchanged images must not reload');
        await updateNotebookOutputs(task, outputs, [plot('final')]);
    });

    test('replaces outputs when their display identity changes', async () => {
        const initial = plot('old'),
            next = plot('new');
        next.metadata = { rDisplayId: 'plot-2' };
        const task = execution([initial]);
        let replaced = false;
        task.replaceOutput = (outputs) => {
            assert.deepStrictEqual(outputs, [next]);
            replaced = true;
            return Promise.resolve();
        };
        await updateNotebookOutputs(task, [initial], [next]);
        assert.ok(replaced);
    });
});
