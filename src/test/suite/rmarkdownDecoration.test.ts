import * as assert from 'assert';
import * as vscode from 'vscode';

import { RMarkdownCodeLensProvider } from '../../rmarkdown';

suite('R Markdown chunk decorations', () => {
    test('clears current chunk borders when the document has no chunks', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'r',
            content: '# %%\nx <- 1\n# %%\ny <- 2',
        });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(1, 0, 1, 0);

        const decorationCalls: Array<readonly vscode.Range[]> = [];
        const editorWrapper = Object.create(editor) as vscode.TextEditor;
        Object.defineProperty(editorWrapper, 'setDecorations', {
            configurable: true,
            value: (
                _decorationType: vscode.TextEditorDecorationType,
                ranges: readonly vscode.Range[],
            ) => {
                decorationCalls.push(ranges);
            },
        });
        const provider = new RMarkdownCodeLensProvider(() => [editorWrapper]);
        try {
            provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);
            assert.strictEqual(decorationCalls.length, 2);

            const edit = new vscode.WorkspaceEdit();
            edit.delete(
                document.uri,
                new vscode.Range(
                    new vscode.Position(0, 0),
                    document.lineAt(document.lineCount - 1).range.end,
                ),
            );
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

            decorationCalls.length = 0;
            provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(decorationCalls, [[], []]);
        } finally {
            provider.dispose();
        }
    });
});
