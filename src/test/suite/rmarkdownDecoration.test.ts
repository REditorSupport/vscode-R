import * as assert from 'assert';
import * as vscode from 'vscode';

import { RMarkdownCodeLensProvider } from '../../rmarkdown';

suite('R Markdown chunk decorations', () => {
    test('clears current chunk borders when the document has no chunks', async () => {
        const document = {
            languageId: 'r',
            uri: vscode.Uri.parse('untitled:rmarkdown-decoration-test'),
            getText: () => 'x <- 1',
        } as vscode.TextDocument;

        const decorationCalls: Array<readonly vscode.Range[]> = [];
        const editor = {
            document,
            selection: new vscode.Selection(0, 0, 0, 0),
            setDecorations: (
                _decorationType: vscode.TextEditorDecorationType,
                ranges: readonly vscode.Range[],
            ) => decorationCalls.push(ranges),
        } as unknown as vscode.TextEditor;
        const provider = new RMarkdownCodeLensProvider(() => [editor]);
        try {
            provider.provideCodeLenses(document, new vscode.CancellationTokenSource().token);
            assert.deepStrictEqual(decorationCalls, [[], []]);
        } finally {
            provider.dispose();
        }
    });
});
