import * as assert from 'assert';
import * as sinon from 'sinon';
import { PassThrough } from 'stream';
import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient/node';
import { completionMiddleware } from '../../completionMiddleware';
import { acknowledgeEditorSelection } from '../common/editorState';

suite('Completion signature help', () => {
    let sandbox: sinon.SinonSandbox;
    let document: vscode.TextDocument;
    let cancellation: vscode.CancellationTokenSource;
    let configuration: sinon.SinonStub;
    let enabled: sinon.SinonStub;
    const position = new vscode.Position(0, 3);
    const context = {
        triggerKind: vscode.CompletionTriggerKind.Invoke,
        triggerCharacter: undefined,
    };
    const provide = completionMiddleware.provideCompletionItem!;

    function callItem(
        label = 'fun1',
        kind = vscode.CompletionItemKind.Function,
    ): vscode.CompletionItem {
        const item = new vscode.CompletionItem(label, kind);
        item.insertText = new vscode.SnippetString(`${label}($0)`);
        return item;
    }

    setup(async () => {
        document = await vscode.workspace.openTextDocument({ language: 'r', content: 'fun' });
        cancellation = new vscode.CancellationTokenSource();
        sandbox = sinon.createSandbox();
        enabled = sandbox.stub().returns(true);
        configuration = sandbox.stub(vscode.workspace, 'getConfiguration').callThrough();
        configuration
            .withArgs('editor', document)
            .returns({ get: enabled } as unknown as vscode.WorkspaceConfiguration);
    });

    teardown(() => {
        sandbox.restore();
        cancellation.dispose();
    });

    test('adds a command to function, package, method, and constructor call snippets', async () => {
        const items = [
            callItem(),
            callItem('pkg::fun1'),
            callItem('`run task`', vscode.CompletionItemKind.Method),
            callItem('new', vscode.CompletionItemKind.Constructor),
        ];
        const next = sandbox.stub().resolves(items);
        const result = await provide(document, position, context, cancellation.token, next);

        assert.strictEqual(result, items);
        sinon.assert.calledOnceWithExactly(next, document, position, context, cancellation.token);
        sinon.assert.calledWithExactly(configuration, 'editor', document);
        sinon.assert.calledOnceWithExactly(enabled, 'parameterHints.enabled', true);
        for (const item of items) {
            assert.strictEqual(item.command?.command, 'editor.action.triggerParameterHints');
        }
    });

    test('preserves completion-list metadata and uses the document setting on each request', async () => {
        enabled.returns(false);
        const item = callItem();
        const list = new vscode.CompletionList([item], true);
        const next = () => list;
        assert.strictEqual(
            await provide(document, position, context, cancellation.token, next),
            list,
        );
        assert.strictEqual(item.command, undefined);
        enabled.returns(true);
        assert.strictEqual(
            await provide(document, position, context, cancellation.token, next),
            list,
        );
        assert.strictEqual(list.items[0].command?.command, 'editor.action.triggerParameterHints');
        assert.strictEqual(list.isIncomplete, true);
    });

    test('leaves name-only completions, non-call snippets, fields, and existing commands alone', async () => {
        const nameOnly = callItem();
        nameOnly.insertText = 'fun1';
        const plainText = callItem();
        plainText.insertText = 'fun1($0)';
        const snippetName = callItem();
        snippetName.insertText = new vscode.SnippetString('fun1');
        const afterCall = callItem();
        afterCall.insertText = new vscode.SnippetString('fun1()$0');
        const hasCommand = callItem();
        const command = {
            title: 'Existing command',
            command: 'existing.command',
            arguments: ['original'],
        };
        hasCommand.command = command;
        const items = [
            nameOnly,
            plainText,
            snippetName,
            afterCall,
            callItem('field', vscode.CompletionItemKind.Field),
            new vscode.CompletionItem('fun1', vscode.CompletionItemKind.Function),
        ];

        await provide(document, position, context, cancellation.token, () => [
            ...items,
            hasCommand,
        ]);
        assert.ok(items.every((item) => item.command === undefined));
        assert.strictEqual(hasCommand.command, command);
    });

    test('passes through empty and cancelled results', async () => {
        for (const result of [undefined, null, [], new vscode.CompletionList()]) {
            assert.strictEqual(
                await provide(document, position, context, cancellation.token, () => result),
                result,
            );
        }
        const item = callItem();
        const result = await provide(document, position, context, cancellation.token, () => {
            cancellation.cancel();
            return [item];
        });
        assert.deepStrictEqual(result, [item]);
        assert.strictEqual(item.command, undefined);
    });

    test('handles LSP insert text, text edits, insert/replace edits, and completion-list defaults', async () => {
        const client = new lsp.LanguageClient(
            'completion-converter-test',
            'Completion converter test',
            { command: 'unused' },
            { documentSelector: [] },
        );
        const range = lsp.Range.create(0, 0, 0, 3);
        const base = {
            label: 'fun1',
            kind: lsp.CompletionItemKind.Function,
            insertTextFormat: lsp.InsertTextFormat.Snippet,
        };
        const responses: Array<lsp.CompletionItem[] | lsp.CompletionList> = [
            [{ ...base, insertText: 'fun1($0)' }],
            [{ ...base, insertText: 'ignored', textEdit: { range, newText: 'fun1($0)' } }],
            [{ ...base, textEdit: { insert: range, replace: range, newText: 'fun1($0)' } }],
            {
                isIncomplete: true,
                itemDefaults: { editRange: range, insertTextFormat: lsp.InsertTextFormat.Snippet },
                items: [
                    {
                        label: 'fun1',
                        kind: lsp.CompletionItemKind.Function,
                        textEditText: 'fun1($0)',
                    },
                ],
            },
        ];
        try {
            for (const response of responses) {
                const converted = await client.protocol2CodeConverter.asCompletionResult(response);
                const result = await provide(
                    document,
                    position,
                    context,
                    cancellation.token,
                    () => converted,
                );
                assert.ok(result);
                const item = (Array.isArray(result) ? result : result.items)[0];
                assert.strictEqual(item.command?.command, 'editor.action.triggerParameterHints');
                // languageserver resolves documentation on the supplied item and
                // returns it, including its command, through these converters.
                const resolved = client.protocol2CodeConverter.asCompletionItem({
                    ...client.code2ProtocolConverter.asCompletionItem(item),
                    documentation: 'Function documentation',
                });
                assert.strictEqual(
                    resolved.command?.command,
                    'editor.action.triggerParameterHints',
                );
                assert.strictEqual(resolved.documentation, 'Function documentation');
            }
        } finally {
            await client.dispose();
        }
    });
});

suite('Completion signature help acceptance', () => {
    const settings = () => vscode.workspace.getConfiguration('editor', { languageId: 'r' });
    let previousHints: boolean | undefined;

    async function until(predicate: () => boolean): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            assert.ok(Date.now() < deadline, 'Timed out waiting for completion or signature help');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    suiteSetup(() => {
        previousHints = settings().inspect<boolean>('parameterHints.enabled')?.globalLanguageValue;
    });

    suiteTeardown(async () => {
        await settings().update(
            'parameterHints.enabled',
            previousHints,
            vscode.ConfigurationTarget.Global,
            true,
        );
    });

    for (const enabled of [true, false]) {
        test(`accepting a resolved call snippet ${enabled ? 'requests' : 'does not request'} signature help when hints are ${enabled ? 'enabled' : 'disabled'}`, async () => {
            await settings().update(
                'parameterHints.enabled',
                enabled,
                vscode.ConfigurationTarget.Global,
                true,
            );
            const toServer = new PassThrough();
            const toClient = new PassThrough();
            const server = lsp.createProtocolConnection(toServer, toClient);
            const signatures: lsp.SignatureHelpParams[] = [];
            const openedDocuments = new Set<string>();
            let resolutions = 0;
            server.onRequest(lsp.InitializeRequest.type, (): lsp.InitializeResult => ({
                capabilities: {
                    textDocumentSync: lsp.TextDocumentSyncKind.Full,
                    completionProvider: { resolveProvider: true },
                    signatureHelpProvider: { triggerCharacters: ['(', ','] },
                },
            }));
            server.onRequest(lsp.CompletionRequest.type, () => [
                {
                    label: 'fun1',
                    kind: lsp.CompletionItemKind.Function,
                    insertTextFormat: lsp.InsertTextFormat.Snippet,
                    insertText: 'fun1($0)',
                },
            ]);
            server.onRequest(lsp.CompletionResolveRequest.type, (item) => {
                resolutions++;
                return { ...item, documentation: 'Adds 1 to its input.' };
            });
            server.onRequest(lsp.SignatureHelpRequest.type, (params) => {
                signatures.push(params);
                return {
                    signatures: [{ label: 'fun1(x)', parameters: [{ label: 'x' }] }],
                    activeSignature: 0,
                    activeParameter: 0,
                };
            });
            server.onRequest(lsp.ShutdownRequest.type, () => undefined);
            server.onNotification(lsp.DidOpenTextDocumentNotification.type, (params) => {
                openedDocuments.add(params.textDocument.uri);
            });
            server.listen();
            const client = new lsp.LanguageClient(
                'completion-acceptance-test',
                'Completion acceptance test',
                () => Promise.resolve({ reader: toClient, writer: toServer }),
                {
                    documentSelector: [{ scheme: 'untitled', language: 'r' }],
                    middleware: completionMiddleware,
                },
            );
            try {
                await client.start();
                const document = await vscode.workspace.openTextDocument({
                    language: 'r',
                    content: 'fun',
                });
                const editor = await vscode.window.showTextDocument(document);
                await until(() => openedDocuments.has(document.uri.toString()));
                await until(
                    () =>
                        vscode.workspace
                            .getConfiguration('editor', document)
                            .get('parameterHints.enabled') === enabled,
                );
                await acknowledgeEditorSelection(editor, new vscode.Selection(0, 3, 0, 3));
                await vscode.commands.executeCommand('editor.action.triggerSuggest');
                await until(() => resolutions > 0);
                assert.strictEqual(
                    signatures.length,
                    0,
                    'Browsing completions must not request signature help',
                );
                await vscode.commands.executeCommand('acceptSelectedSuggestion');
                await until(() => document.getText() === 'fun1()');
                if (enabled) {
                    await until(() => signatures.length > 0);
                    assert.deepStrictEqual(signatures[0].position, { line: 0, character: 5 });
                    assert.strictEqual(signatures[0].textDocument.uri, document.uri.toString());
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    assert.strictEqual(signatures.length, 0);
                }
                await until(() => editor.selection.active.character === 5);
                assert.strictEqual(editor.selection.active.character, 5);
            } finally {
                await vscode.commands.executeCommand('closeParameterHints');
                await vscode.commands.executeCommand('hideSuggestWidget');
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
                await client.dispose();
                server.dispose();
                toServer.destroy();
                toClient.destroy();
            }
        });
    }
});
