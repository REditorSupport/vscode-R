import * as assert from 'assert';
import * as vscode from 'vscode';
import { StreamText } from '../../interactive/streamText';
import {
    NotebookOutputState,
    prepareNotebookStream,
    updateNotebookOutputs,
} from '../../interactive/notebookOutput';

suite('Interactive console append API', () => {
    test('uses only new suffixes after VS Code normalizes progress and Unicode text', async () => {
        const type = 'r-interactive';
        const controller = vscode.notebooks.createNotebookController(
            'r-stream-api-test',
            type,
            'Console API test',
        );
        controller.supportedLanguages = ['r'];
        const document = await vscode.workspace.openNotebookDocument(
            type,
            new vscode.NotebookData([
                new vscode.NotebookCellData(
                    vscode.NotebookCellKind.Code,
                    '# console delivery',
                    'r',
                ),
            ]),
        );
        const editor = await vscode.window.showNotebookDocument(document);
        try {
            await vscode.commands.executeCommand('notebook.selectKernel', {
                id: controller.id,
                extension: 'REditorSupport.r',
                notebookEditor: editor,
            });
            const cell = document.cellAt(0);
            const execution = controller.createNotebookCellExecution(cell);
            execution.start();
            const text = new StreamText('abcdef');
            const state = new NotebookOutputState();
            const starts: number[] = [];
            const write = async () => {
                const snapshot = text.snapshot();
                const read = snapshot.text.bind(snapshot);
                snapshot.text = (start = 0) => {
                    starts.push(start);
                    return read(start);
                };
                const output = new vscode.NotebookCellOutput(
                    [vscode.NotebookCellOutputItem.stdout('')],
                    { rStreamId: 'test-stream' },
                );
                prepareNotebookStream(output, snapshot);
                await updateNotebookOutputs(
                    execution,
                    cell.outputs,
                    [output],
                    state,
                    () => cell.outputs,
                );
            };
            try {
                await write();
                text.append('\rxy');
                await write();
                text.append('\b!');
                await write();
                text.append('\nλ🙂\n');
                await write();
                assert.deepStrictEqual(starts, [0, 6, 9, 11]);
                assert.strictEqual(
                    Buffer.from(cell.outputs[0].items[0].data).toString(),
                    'xycde!\nλ🙂\n',
                );
            } finally {
                execution.end(true);
            }
        } finally {
            controller.dispose();
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });
});
