import * as assert from 'assert';
import * as vscode from 'vscode';
import sinon = require('sinon');

import { RMarkdownCodeLensProvider } from '../../rmarkdown';

suite('R Markdown chunk decorations', () => {
    test('clears current chunk borders when the document has no chunks', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'r',
            content: '# %%\nx <- 1\n# %%\ny <- 2'
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(1, 0, 1, 0);

        const provider = new RMarkdownCodeLensProvider();
        const setDecorations = sinon.spy(editor, 'setDecorations');
        try {
            provider.provideCodeLenses(document, vscode.CancellationToken.None);
            assert.strictEqual(setDecorations.callCount, 2);

            const edit = new vscode.WorkspaceEdit();
            edit.delete(document.uri, new vscode.Range(
                new vscode.Position(0, 0),
                document.lineAt(document.lineCount - 1).range.end
            ));
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

            setDecorations.resetHistory();
            provider.provideCodeLenses(document, vscode.CancellationToken.None);
            assert.deepStrictEqual(
                setDecorations.getCalls().map(call => call.args[1]),
                [[], []]
            );
        } finally {
            setDecorations.restore();
            provider.dispose();
        }
    });
});
