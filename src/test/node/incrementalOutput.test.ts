import * as assert from 'assert';
import type { NotebookCellExecution, NotebookCellOutput, NotebookCellOutputItem } from 'vscode';
import { ExecutionCellIndex } from '../../interactive/cellIndex';
import {
    NotebookOutputState,
    prepareNotebookStream,
    updateNotebookOutputs,
} from '../../interactive/notebookOutput';
import { StreamText } from '../../interactive/streamText';

suite('Incremental Interactive console delivery', () => {
    function streamOutput(stream: StreamText, id = 'console'): NotebookCellOutput {
        const output = {
            metadata: { rStreamId: id },
            items: [{ mime: 'application/vnd.code.notebook.stdout', data: Buffer.alloc(0) }],
        };
        prepareNotebookStream(output, stream.snapshot());
        return output;
    }

    function notebook() {
        const outputs: NotebookCellOutput[] = [];
        let bytes = 0;
        const calls: string[] = [];
        const items = (value: NotebookCellOutputItem | readonly NotebookCellOutputItem[]) =>
            'mime' in value ? [value] : [...value];
        const execution: Pick<
            NotebookCellExecution,
            'replaceOutput' | 'appendOutput' | 'replaceOutputItems' | 'appendOutputItems'
        > = {
            replaceOutput(value) {
                calls.push('replace');
                const next = 'items' in value ? [value] : [...value];
                bytes += next
                    .flatMap((output) => output.items)
                    .reduce((sum, item) => sum + item.data.length, 0);
                outputs.splice(0, outputs.length, ...next);
                return Promise.resolve();
            },
            appendOutput(value) {
                calls.push('append');
                const next = 'items' in value ? [value] : [...value];
                bytes += next
                    .flatMap((output) => output.items)
                    .reduce((sum, item) => sum + item.data.length, 0);
                outputs.push(...next);
                return Promise.resolve();
            },
            replaceOutputItems(value, output) {
                calls.push('replaceItems');
                output.items = items(value);
                bytes += output.items.reduce((sum, item) => sum + item.data.length, 0);
                return Promise.resolve();
            },
            appendOutputItems(value, output) {
                calls.push('appendItems');
                const added = items(value);
                bytes += added.reduce((sum, item) => sum + item.data.length, 0);
                // VS Code combines consecutive stdout items into one stream.
                output.items = [
                    {
                        mime: added[0].mime,
                        data: Buffer.concat([...output.items, ...added].map((item) => item.data)),
                    },
                ];
                return Promise.resolve();
            },
        };
        return {
            outputs,
            execution,
            calls,
            get bytes() {
                return bytes;
            },
        };
    }

    test('delivers a growing 4 MiB stream with exactly 4 MiB of payload', async () => {
        const model = notebook(),
            state = new NotebookOutputState(),
            text = new StreamText('');
        for (let index = 0; index < 128; index++) {
            text.append('x'.repeat(32768));
            await updateNotebookOutputs(
                model.execution,
                [...model.outputs],
                [streamOutput(text)],
                state,
            );
        }
        const handle = model.outputs[0];
        text.seal();
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        assert.strictEqual(model.outputs[0], handle);
        assert.strictEqual(model.bytes, 4 * 1024 * 1024);
        assert.strictEqual(model.outputs[0].items[0].data.length, model.bytes);
        assert.strictEqual(model.calls.filter((call) => call === 'appendItems').length, 127);
        assert.ok(!model.calls.includes('replaceItems'));
    });

    test('snapshots keep their original prefix through append and compaction', () => {
        const text = new StreamText('first'),
            before = text.snapshot();
        text.append(' second');
        text.append('🙂'.repeat(20000));
        const during = text.snapshot();
        text.seal();
        text.append('\rnext\b!');
        assert.strictEqual(before.text(), 'first');
        assert.strictEqual(during.text(5), ' second' + '🙂'.repeat(20000));
        assert.strictEqual(text.snapshot().text(during.length), '\rnext\b!');
    });

    test('restoration and externally replaced output rebuild the current stream once', async () => {
        const model = notebook(),
            state = new NotebookOutputState(),
            text = new StreamText('é🙂');
        await updateNotebookOutputs(model.execution, [], [streamOutput(text)], state);
        state.reset();
        text.append(' next');
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        model.outputs[0].items = [
            {
                mime: model.outputs[0].items[0].mime,
                data: Buffer.alloc(Buffer.byteLength('é🙂 next'), 120),
            },
        ];
        text.append(' last');
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        assert.strictEqual(Buffer.from(model.outputs[0].items[0].data).toString(), 'é🙂 next last');
        assert.strictEqual(model.calls.filter((call) => call === 'replaceItems').length, 2);
    });

    test('a failed append does not acknowledge text which was not delivered', async () => {
        const model = notebook(),
            state = new NotebookOutputState(),
            text = new StreamText('first');
        await updateNotebookOutputs(model.execution, [], [streamOutput(text)], state);
        text.append(' second');
        await assert.rejects(
            updateNotebookOutputs(
                {
                    ...model.execution,
                    appendOutputItems: () => Promise.reject(new Error('delivery failed')),
                },
                [...model.outputs],
                [streamOutput(text)],
                state,
            ),
            /delivery failed/,
        );
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        assert.strictEqual(Buffer.from(model.outputs[0].items[0].data).toString(), 'first second');
    });

    test('acknowledges normalized progress output without re-encoding its raw prefix', async () => {
        const model = notebook(),
            state = new NotebookOutputState(),
            text = new StreamText('first');
        const append = model.execution.appendOutputItems.bind(model.execution);
        model.execution.appendOutputItems = async (items, output) => {
            await append(items, output);
            let visible = '';
            for (const char of Buffer.from(output.items[0].data).toString()) {
                if (char === '\r') {
                    visible = visible.slice(0, visible.lastIndexOf('\n') + 1);
                } else if (char === '\b') {
                    visible = visible.slice(0, -1);
                } else {
                    visible += char;
                }
            }
            output.items[0].data = Buffer.from(visible);
        };
        await updateNotebookOutputs(model.execution, [], [streamOutput(text)], state);
        text.append('\rsecond');
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        text.append('\b!');
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(text)],
            state,
        );
        assert.strictEqual(Buffer.from(model.outputs[0].items[0].data).toString(), 'secon!');
        assert.ok(!model.calls.includes('replaceItems'));
        assert.strictEqual(model.bytes, Buffer.byteLength('first\rsecond\b!'));
    });

    test('interleaved console and rich output retain order and plot identity', async () => {
        const model = notebook(),
            state = new NotebookOutputState();
        const before = new StreamText('before\n'),
            after = new StreamText('after\n');
        const plot: NotebookCellOutput = {
            metadata: { rDisplayId: 'plot' },
            items: [{ mime: 'image/svg+xml', data: Buffer.from('<svg/>') }],
        };
        await updateNotebookOutputs(
            model.execution,
            [],
            [streamOutput(before, 'before'), plot],
            state,
        );
        const plotHandle = model.outputs[1];
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(before, 'before'), plot, streamOutput(after, 'after')],
            state,
        );
        after.append('\rprogress\b!');
        await updateNotebookOutputs(
            model.execution,
            [...model.outputs],
            [streamOutput(before, 'before'), plot, streamOutput(after, 'after')],
            state,
        );
        assert.strictEqual(model.outputs[1], plotHandle);
        assert.deepStrictEqual(
            model.outputs.map((output) => Buffer.from(output.items[0].data).toString()),
            ['before\n', '<svg/>', 'after\n\rprogress\b!'],
        );
    });

    test('indexes cells once while outputs change and rebuilds after notebook edits', () => {
        const index = new ExecutionCellIndex<{
            metadata: { rExecutionId: string };
            value: number;
        }>();
        let reads = 0;
        const cells = Array.from({ length: 10000 }, (_, value) => ({
            metadata: { rExecutionId: String(value) },
            value,
        }));
        const read = () => {
            reads++;
            return cells;
        };
        for (let update = 0; update < 128; update++) {
            assert.strictEqual(index.get('9999', read), cells[9999]);
        }
        assert.strictEqual(reads, 1);
        cells[9999].metadata.rExecutionId = 'edited';
        index.invalidate();
        assert.strictEqual(index.get('9999', read), undefined);
        assert.strictEqual(index.get('edited', read), cells[9999]);
        assert.strictEqual(reads, 2);
    });
});
