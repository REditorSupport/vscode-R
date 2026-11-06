import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { RMarkdownCodeLensProvider } from '../../rmarkdown';
import * as util from '../../util';

suite('R chunk decorations', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: RMarkdownCodeLensProvider;
    let selectionChanged: (event: vscode.TextEditorSelectionChangeEvent) => unknown;
    let decorationDisposals: sinon.SinonStub[];
    let listenerDisposal: sinon.SinonStub;
    let listenerDisposals: sinon.SinonStub[];
    let visibleChanged: (editors: readonly vscode.TextEditor[]) => unknown;
    let documentChanged: (event: vscode.TextDocumentChangeEvent) => unknown;
    let visibleEditors: sinon.SinonStub;
    let configuration: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        decorationDisposals = [];
        listenerDisposal = sandbox.stub();
        listenerDisposals = [listenerDisposal];
        configuration = sandbox.stub(util, 'config').returns({
            get: (key: string, fallback?: unknown) =>
                key === 'rmarkdown.chunkBackgroundColor'
                    ? 'rgba(128,128,128,0.1)'
                    : key === 'rmarkdown.enableCodeLens'
                      ? false
                      : fallback,
        } as vscode.WorkspaceConfiguration);
        visibleEditors = sandbox.stub(vscode.window, 'visibleTextEditors').value([]);
        sandbox.stub(vscode.window, 'createTextEditorDecorationType').callsFake(() => {
            const dispose = sandbox.stub();
            decorationDisposals.push(dispose);
            return { key: String(decorationDisposals.length), dispose };
        });
        sandbox.stub(vscode.window, 'onDidChangeTextEditorSelection').callsFake((listener) => {
            selectionChanged = listener;
            return new vscode.Disposable(listenerDisposal);
        });
        sandbox.stub(vscode.window, 'onDidChangeVisibleTextEditors').callsFake((listener) => {
            visibleChanged = listener;
            const dispose = sandbox.stub();
            listenerDisposals.push(dispose);
            return new vscode.Disposable(dispose);
        });
        sandbox.stub(vscode.workspace, 'onDidChangeTextDocument').callsFake((listener) => {
            documentChanged = listener;
            const dispose = sandbox.stub();
            listenerDisposals.push(dispose);
            return new vscode.Disposable(dispose);
        });
        provider = new RMarkdownCodeLensProvider();
    });

    function rmdEditor() {
        let text = 'Heading\n```{r}\nx <- 1\n```\nAfter';
        const getText = sandbox.stub().callsFake(() => text);
        const document = {
            languageId: 'rmd',
            version: 1,
            getText,
        } as unknown as vscode.TextDocument;
        const decorations = sandbox.stub();
        const editor = {
            document,
            selection: new vscode.Selection(2, 0, 2, 0),
            setDecorations: decorations,
        } as unknown as vscode.TextEditor;
        return {
            editor,
            document,
            decorations,
            getText,
            change: (value: string) => {
                text = value;
                Object.assign(document, { version: document.version + 1 });
            },
        };
    }

    test('R Markdown backgrounds update with CodeLens disabled and reuse unchanged decorations', async () => {
        const settings = vscode.workspace.getConfiguration('editor', { languageId: 'rmd' });
        const previous = settings.inspect<boolean>('codeLens')?.globalLanguageValue;
        await settings.update('codeLens', false, vscode.ConfigurationTarget.Global, true);
        try {
            const fixture = rmdEditor();
            const codeLenses = sandbox.spy(provider, 'provideCodeLenses');
            visibleEditors.value([fixture.editor]);
            selectionChanged({
                textEditor: fixture.editor,
            } as vscode.TextEditorSelectionChangeEvent);
            sinon.assert.calledOnce(fixture.getText);
            sinon.assert.calledOnce(fixture.decorations);
            assert.deepStrictEqual(fixture.decorations.firstCall.args[1], [
                new vscode.Range(1, 0, 3, 3),
            ]);
            for (const line of [2, 3, 4]) {
                Object.assign(fixture.editor, {
                    selection: new vscode.Selection(line, 0, line, 0),
                });
                selectionChanged({
                    textEditor: fixture.editor,
                } as vscode.TextEditorSelectionChangeEvent);
            }
            sinon.assert.calledOnce(fixture.getText);
            sinon.assert.calledOnce(fixture.decorations);
            // A programmatic edit need not move the cursor or request CodeLens.
            fixture.change('Prose only');
            documentChanged({ document: fixture.document } as vscode.TextDocumentChangeEvent);
            sinon.assert.calledTwice(fixture.getText);
            sinon.assert.calledTwice(fixture.decorations);
            assert.deepStrictEqual(fixture.decorations.lastCall.args[1], []);
            sinon.assert.notCalled(codeLenses);
        } finally {
            await settings.update('codeLens', previous, vscode.ConfigurationTarget.Global, true);
        }
    });

    test('new split editors receive cached R Markdown ranges without rescanning', () => {
        const fixture = rmdEditor();
        visibleEditors.value([fixture.editor]);
        visibleChanged([fixture.editor]);
        const splitDecorations = sandbox.stub();
        const split = { ...fixture.editor, setDecorations: splitDecorations } as vscode.TextEditor;
        visibleEditors.value([fixture.editor, split]);
        visibleChanged([fixture.editor, split]);
        sinon.assert.calledOnce(fixture.getText);
        sinon.assert.calledOnce(fixture.decorations);
        sinon.assert.calledOnce(splitDecorations);
        assert.strictEqual(
            splitDecorations.firstCall.args[1],
            fixture.decorations.firstCall.args[1],
        );
    });

    test('already visible R Markdown editors are decorated during initialization', () => {
        provider.dispose();
        const fixture = rmdEditor();
        visibleEditors.value([fixture.editor]);
        provider = new RMarkdownCodeLensProvider();
        sinon.assert.calledOnce(fixture.getText);
        sinon.assert.calledOnce(fixture.decorations);
    });

    test('changing a decorated editor language clears its background without scanning another language', () => {
        const fixture = rmdEditor();
        selectionChanged({ textEditor: fixture.editor } as vscode.TextEditorSelectionChangeEvent);
        Object.assign(fixture.document, { languageId: 'python' });
        selectionChanged({ textEditor: fixture.editor } as vscode.TextEditorSelectionChangeEvent);
        sinon.assert.calledOnce(fixture.getText);
        assert.deepStrictEqual(fixture.decorations.lastCall.args[1], []);
    });

    test('an empty chunk background setting disables R Markdown decoration work', () => {
        provider.dispose();
        configuration.returns({ get: () => '' } as unknown as vscode.WorkspaceConfiguration);
        provider = new RMarkdownCodeLensProvider();
        const fixture = rmdEditor();
        visibleEditors.value([fixture.editor]);
        visibleChanged([fixture.editor]);
        selectionChanged({ textEditor: fixture.editor } as vscode.TextEditorSelectionChangeEvent);
        documentChanged({ document: fixture.document } as vscode.TextDocumentChangeEvent);
        sinon.assert.notCalled(fixture.getText);
        sinon.assert.notCalled(fixture.decorations);
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
        assert.strictEqual(listenerDisposals.length, 3);
        listenerDisposals.forEach((dispose) => sinon.assert.calledOnce(dispose));
    });
});
