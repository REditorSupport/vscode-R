import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    documentClose,
    documentSave,
    documentSaveAll,
    documentNew,
    insertOrModifyText,
    replaceTextInCurrentSelection,
    setSelections,
    projectPath,
} from '../../rstudioapi';
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
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
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

    test('selection replacement uses the requested document editor', async () => {
        const active = document();
        const target = {
            ...document(),
            uri: vscode.Uri.file('/project/other.R'),
        } as vscode.TextDocument;
        const selection = new vscode.Selection(0, 2, 0, 4);
        sandbox.stub(vscode.window, 'activeTextEditor').value({
            document: active,
            selection: new vscode.Selection(0, 0, 0, 1),
        });
        sandbox.stub(vscode.window, 'visibleTextEditors').value([{ document: target, selection }]);
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(target);
        const apply = sandbox.stub(vscode.workspace, 'applyEdit').resolves(true);
        await replaceTextInCurrentSelection('x', target.uri.toString());
        const edit = apply.firstCall.args[0] as vscode.WorkspaceEdit;
        assert.ok(edit.get(target.uri)[0].range.isEqual(selection));
        assert.strictEqual(edit.has(active.uri), false);
    });

    test('explicit selection requests can show a document without an active editor', async () => {
        const doc = document();
        sandbox.stub(vscode.window, 'activeTextEditor').value(undefined);
        sandbox.stub(vscode.window, 'visibleTextEditors').value([]);
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        const editor = { document: doc, selections: [] } as unknown as vscode.TextEditor;
        const show = sandbox.stub(vscode.window, 'showTextDocument').resolves(editor);
        await setSelections([{ start: [1, 1], end: [1, 2] }], doc.uri.toString());
        sinon.assert.calledOnce(show);
        assert.deepStrictEqual(editor.selections, [new vscode.Selection(0, 0, 0, 1)]);
    });

    test('document close keeps tabs open when saving fails', async () => {
        const doc = { ...document(), save: () => Promise.resolve(false) } as vscode.TextDocument;
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        const close = sandbox.stub().resolves(true);
        sandbox.stub(vscode.window, 'tabGroups').value({ ...vscode.window.tabGroups, close });
        await assert.rejects(documentClose(doc.uri.toString(), true), /Could not save document/);
        sinon.assert.notCalled(close);
    });

    test('save requests reject when VS Code cannot save documents', async () => {
        const doc = { ...document(), save: () => Promise.resolve(false) } as vscode.TextDocument;
        sandbox.stub(vscode.workspace, 'openTextDocument').resolves(doc);
        sandbox.stub(vscode.workspace, 'saveAll').resolves(false);
        await assert.rejects(documentSave(doc.uri.toString()), /Could not save document/);
        await assert.rejects(documentSaveAll(), /Could not save all documents/);
    });

    test('project paths are native filesystem paths', () => {
        const uri = vscode.Uri.file(process.platform === 'win32' ? 'C:\\project' : '/project');
        sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri }]);
        assert.strictEqual(projectPath().path, uri.fsPath);
    });
});
