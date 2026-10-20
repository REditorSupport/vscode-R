import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { documentNew, insertOrModifyText, replaceTextInCurrentSelection } from '../../rstudioapi';
import { handleEditorRequest } from '../../session';

suite('RStudio editor request completion', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => sandbox.restore());

    function document() {
        const uri = vscode.Uri.file('/project/test.R');
        return {
            uri,
            lineCount: 1,
            validatePosition: (position: vscode.Position) => position,
            validateRange: (range: vscode.Range) => range,
        } as vscode.TextDocument;
    }

    test('insert requests wait for the workspace edit before acknowledging completion', async () => {
        const doc = document();
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        let finish!: (value: boolean) => void;
        sandbox.stub(vscode.workspace, 'applyEdit').returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        let completed = false;
        const request = insertOrModifyText(
            [{ operation: 'insertText', text: 'x <- 1', location: [1, 1] }],
            doc.uri.toString(),
        );
        void request.then(() => {
            completed = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(completed, false);
        finish(true);
        await request;
        assert.strictEqual(completed, true);
    });

    test('new document requests wait for editing and showing the editor', async () => {
        const doc = document();
        sandbox
            .stub(vscode.workspace, 'workspaceFolders')
            .value([{ uri: vscode.Uri.file('/project') }]);
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        let finish!: (value: boolean) => void;
        sandbox.stub(vscode.workspace, 'applyEdit').returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const editor = { document: doc, selections: [] } as unknown as vscode.TextEditor;
        const show = sandbox.stub(vscode.window, 'showTextDocument').resolves(editor);
        let completed = false;
        const request = documentNew('x <- 1', 'R', [1, 1]);
        void request.then(() => {
            completed = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(completed, false);
        sinon.assert.notCalled(show);
        finish(true);
        await request;
        sinon.assert.calledOnce(show);
        assert.strictEqual(editor.selections.length, 1);
    });

    test('one-based positions add a newline only beyond the existing document', async () => {
        const doc = document();
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        const apply = sandbox.stub(vscode.workspace, 'applyEdit').resolves(true);
        for (const [line, expected] of [
            [1, 'x'],
            [2, 'x\n'],
            ['Inf', 'x\n'],
        ] as const) {
            await insertOrModifyText(
                [{ operation: 'insertText', text: 'x', location: [line, 1] }],
                doc.uri.toString(),
            );
            assert.strictEqual(
                (apply.lastCall.args[0] as vscode.WorkspaceEdit).get(doc.uri)[0].newText,
                expected,
            );
        }
    });

    test('insert and modify requests report an error when VS Code cannot apply the edit', async () => {
        const doc = document();
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        sandbox.stub(vscode.workspace, 'applyEdit').resolves(false);
        for (const query of [
            [{ operation: 'insertText', text: 'x', location: [1, 1] }],
            [{ operation: 'modifyRange', text: 'x', location: { start: [1, 1], end: [1, 2] } }],
        ]) {
            await assert.rejects(
                handleEditorRequest('rstudioapi/insert_or_modify_text', {
                    id: doc.uri.toString(),
                    query,
                }),
                /Could not apply editor changes/,
            );
        }
    });

    test('a failed new document edit reports an error without showing the editor', async () => {
        const doc = document();
        sandbox
            .stub(vscode.workspace, 'workspaceFolders')
            .value([{ uri: vscode.Uri.file('/project') }]);
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        sandbox.stub(vscode.workspace, 'applyEdit').resolves(false);
        const show = sandbox
            .stub(vscode.window, 'showTextDocument')
            .resolves({ selections: [] } as unknown as vscode.TextEditor);
        await assert.rejects(
            handleEditorRequest('rstudioapi/document_new', {
                text: 'x <- 1',
                type: 'R',
                position: [1, 1],
            }),
            /Could not apply editor changes/,
        );
        sinon.assert.notCalled(show);
    });

    test('selection replacement rejects an edit that VS Code cannot apply', async () => {
        const doc = document();
        sandbox.stub(vscode.window, 'activeTextEditor').value({
            document: doc,
            selection: new vscode.Selection(0, 0, 0, 1),
        });
        sandbox.stub(vscode.workspace, 'applyEdit').resolves(false);
        await assert.rejects(
            replaceTextInCurrentSelection('x', doc.uri.toString()),
            /Could not apply editor changes/,
        );
    });
});
