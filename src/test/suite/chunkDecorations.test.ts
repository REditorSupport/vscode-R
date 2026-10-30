import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { RMarkdownCodeLensProvider } from '../../rmarkdown';

suite('R chunk decorations', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: RMarkdownCodeLensProvider;
    let selectionChanged: (event: vscode.TextEditorSelectionChangeEvent) => unknown;
    let decorationDisposals: sinon.SinonStub[];
    let listenerDisposal: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        decorationDisposals = [];
        listenerDisposal = sandbox.stub();
        sandbox.stub(vscode.window, 'createTextEditorDecorationType').callsFake(() => {
            const dispose = sandbox.stub();
            decorationDisposals.push(dispose);
            return { key: String(decorationDisposals.length), dispose };
        });
        sandbox.stub(vscode.window, 'onDidChangeTextEditorSelection').callsFake((listener) => {
            selectionChanged = listener;
            return new vscode.Disposable(listenerDisposal);
        });
        provider = new RMarkdownCodeLensProvider();
    });
    teardown(() => {
        provider.dispose();
        sandbox.restore();
    });

    test('cursor movement inside a chunk reuses its scan and borders', () => {
        let text = '# %%\nx <- 1\ny <- 2';
        const getText = sandbox.stub().callsFake(() => text);
        const document = {
            version: 1,
            languageId: 'r',
            getText,
            lineAt: (line: number) => ({
                range: new vscode.Range(line, 0, line, text.split('\n')[line].length),
            }),
        } as unknown as vscode.TextDocument;
        const decorations = sandbox.stub();
        const editor = {
            document,
            selection: new vscode.Selection(1, 0, 1, 0),
            setDecorations: decorations,
        } as unknown as vscode.TextEditor;
        const event = { textEditor: editor } as vscode.TextEditorSelectionChangeEvent;
        selectionChanged(event);
        assert.strictEqual(getText.callCount, 1);
        assert.strictEqual(decorations.callCount, 2);

        Object.assign(editor, { selection: new vscode.Selection(2, 0, 2, 0) });
        selectionChanged(event);
        assert.strictEqual(getText.callCount, 1);
        assert.strictEqual(decorations.callCount, 2);

        text = 'x <- 1\ny <- 2';
        Object.assign(document, { version: 2 });
        selectionChanged(event);
        assert.strictEqual(getText.callCount, 2);
        assert.deepStrictEqual(decorations.getCall(2).args[1], []);
        assert.deepStrictEqual(decorations.getCall(3).args[1], []);
    });

    test('selection changes in other languages do not scan the document', () => {
        const getText = sandbox.stub().returns('large unrelated document');
        selectionChanged({
            textEditor: {
                document: { languageId: 'python', getText },
            },
        } as unknown as vscode.TextEditorSelectionChangeEvent);
        sinon.assert.notCalled(getText);
    });

    test('disposal releases every decoration type and the selection listener', () => {
        provider.dispose();
        assert.strictEqual(decorationDisposals.length, 3);
        decorationDisposals.forEach((dispose) => sinon.assert.calledOnce(dispose));
        sinon.assert.calledOnce(listenerDisposal);
    });
});
