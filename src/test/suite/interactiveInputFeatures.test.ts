import * as assert from 'assert';
import * as path from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import type { InteractiveManager } from '../../interactive/manager';
import { acknowledgeEditorSelection, executeEditorCommand } from '../common/editorState';

suite('Interactive input formatting with independent providers', () => {
    let editor: vscode.TextEditor;
    let controller: vscode.NotebookController;
    let notebook: vscode.NotebookDocument;
    let inputUri: vscode.Uri;
    let originalTabs: Set<vscode.Tab>;
    let providers: vscode.Disposable[];
    let previousOnType: boolean | undefined;
    let previousOnPaste: boolean | undefined;
    let previousAutoClosingBrackets: string | undefined;
    const selector = { scheme: 'vscode-interactive-input', language: 'r' };
    const settings = (): vscode.WorkspaceConfiguration =>
        vscode.workspace.getConfiguration('editor', { languageId: 'r' });
    const until = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            assert.ok(Date.now() < deadline, 'Timed out waiting for Interactive formatting');
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };
    const replaceInput = async (text: string): Promise<void> => {
        assert.ok(
            await editor.edit((builder) =>
                builder.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text),
            ),
        );
        await until(() => editor.document.getText() === text);
        const end = editor.document.positionAt(text.length);
        await acknowledgeEditorSelection(editor, new vscode.Selection(end, end));
    };
    const focusInput = async (): Promise<void> => {
        await vscode.commands.executeCommand(
            'interactive.open',
            { preserveFocus: false },
            notebook.uri,
        );
        await vscode.commands.executeCommand('interactive.input.focus');
        await until(
            () => vscode.window.activeTextEditor?.document.uri.toString() === inputUri.toString(),
        );
        editor = vscode.window.activeTextEditor!;
        await acknowledgeEditorSelection(editor, editor.selection);
    };
    const setFormatSetting = async (
        name: 'formatOnType' | 'formatOnPaste',
        value: boolean | undefined,
    ): Promise<void> => {
        await settings().update(name, value, vscode.ConfigurationTarget.Global, true);
        await until(() => settings().inspect<boolean>(name)?.globalLanguageValue === value);
        if (value !== undefined) {
            await until(
                () =>
                    vscode.workspace.getConfiguration('editor', editor.document).get(name) ===
                    value,
            );
        }
    };
    const formatExpression = (document: vscode.TextDocument): vscode.TextEdit[] => [
        vscode.TextEdit.replace(
            new vscode.Range(0, 0, document.lineCount, 0),
            document.getText().replace('1+1', '1 + 1'),
        ),
    ];

    suiteSetup(async () => {
        assert.strictEqual(
            vscode.workspace.getConfiguration('r').get('lsp.enabled'),
            false,
            'Provider tests must run with the built-in language service disabled',
        );
        originalTabs = new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs));
        controller = vscode.notebooks.createNotebookController(
            'independent-formatting-test',
            'interactive',
            'Independent formatter test',
        );
        controller.supportedLanguages = ['r'];
        const opened = await vscode.commands.executeCommand<{
            notebookUri: vscode.Uri;
            inputUri: vscode.Uri;
        }>(
            'interactive.open',
            { preserveFocus: false },
            undefined,
            `REditorSupport.r/${controller.id}`,
            'Independent formatting',
        );
        notebook = await vscode.workspace.openNotebookDocument(opened.notebookUri);
        inputUri = opened.inputUri;
        await vscode.languages.setTextDocumentLanguage(
            await vscode.workspace.openTextDocument(opened.inputUri),
            'r',
        );
        await vscode.commands.executeCommand('interactive.input.focus');
        await until(
            () =>
                vscode.window.activeTextEditor?.document.uri.toString() ===
                opened.inputUri.toString(),
        );
        editor = vscode.window.activeTextEditor!;
        previousOnType = settings().inspect<boolean>('formatOnType')?.globalLanguageValue;
        previousOnPaste = settings().inspect<boolean>('formatOnPaste')?.globalLanguageValue;
        previousAutoClosingBrackets =
            settings().inspect<string>('autoClosingBrackets')?.globalLanguageValue;
        // This fixture verifies provider triggers. Auto-closing can consume a
        // typed ')' by moving the cursor, which intentionally makes no edit.
        // The language-server integration suite separately covers that behavior.
        await settings().update(
            'autoClosingBrackets',
            'never',
            vscode.ConfigurationTarget.Global,
            true,
        );
        await until(
            () =>
                vscode.workspace
                    .getConfiguration('editor', editor.document)
                    .get('autoClosingBrackets') === 'never',
        );
    });
    setup(async () => {
        providers = [];
        await focusInput();
        await setFormatSetting('formatOnType', true);
        await setFormatSetting('formatOnPaste', true);
        await replaceInput('');
    });
    teardown(async () => {
        providers.forEach((provider) => {
            provider.dispose();
        });
        await focusInput();
        await setFormatSetting('formatOnType', false);
        await replaceInput('');
    });
    suiteTeardown(async () => {
        await setFormatSetting('formatOnType', previousOnType);
        await setFormatSetting('formatOnPaste', previousOnPaste);
        await settings().update(
            'autoClosingBrackets',
            previousAutoClosingBrackets,
            vscode.ConfigurationTarget.Global,
            true,
        );
        controller.dispose();
        await vscode.window.tabGroups.close(
            vscode.window.tabGroups.all
                .flatMap((group) => group.tabs)
                .filter((tab) => !originalTabs.has(tab)),
            true,
        );
    });

    test('formats typing with a registered provider, including its own trigger characters', async () => {
        const calls: Array<{ ch: string; options: vscode.FormattingOptions }> = [];
        providers.push(
            vscode.languages.registerOnTypeFormattingEditProvider(
                selector,
                {
                    provideOnTypeFormattingEdits(document, _position, ch, options) {
                        calls.push({ ch, options });
                        return formatExpression(document);
                    },
                },
                ')',
                '!',
            ),
        );
        editor.options = { tabSize: 2, insertSpaces: true };
        for (const text of ['(1+1)', '(1+1)!']) {
            await replaceInput('');
            const before = calls.length;
            for (const ch of text) {
                await executeEditorCommand(editor, 'type', ch);
            }
            await until(() => editor.document.getText() === text.replace('1+1', '1 + 1'));
            assert.ok(calls.length > before);
            // Formatting's document change can arrive before its selection update.
            await until(
                () =>
                    editor.selection.isEmpty &&
                    editor.document.offsetAt(editor.selection.active) ===
                        editor.document.getText().length,
            );
        }
        assert.ok(
            calls.some((call) => call.ch === '!'),
            'VS Code uses the independent provider’s triggers',
        );
        assert.deepStrictEqual(calls[0].options, { tabSize: 2, insertSpaces: true });
        await replaceInput('(1+1');
        await executeEditorCommand(editor, 'type', ')');
        await until(() => editor.document.getText() === '(1 + 1)');
        await vscode.commands.executeCommand('undo');
        await until(() => editor.document.getText() === '(1+1');
    });

    test('honors format-on-type settings and ignores unregistered triggers', async () => {
        let calls = 0;
        providers.push(
            vscode.languages.registerOnTypeFormattingEditProvider(
                selector,
                {
                    provideOnTypeFormattingEdits(document) {
                        calls++;
                        return formatExpression(document);
                    },
                },
                ')',
            ),
        );
        await setFormatSetting('formatOnType', false);
        await replaceInput('(1+1');
        await executeEditorCommand(editor, 'type', ')');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(editor.document.getText(), '(1+1)');
        assert.strictEqual(calls, 0);
        await setFormatSetting('formatOnType', true);
        await executeEditorCommand(editor, 'type', '!');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(calls, 0);
    });

    test('single-character paste only uses format-on-paste even when format-on-type is enabled', async () => {
        let typeCalls = 0;
        const ranges: vscode.Range[] = [];
        providers.push(
            vscode.languages.registerOnTypeFormattingEditProvider(
                selector,
                {
                    provideOnTypeFormattingEdits(document) {
                        typeCalls++;
                        return formatExpression(document);
                    },
                },
                ')',
            ),
        );
        providers.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
                provideDocumentRangeFormattingEdits(document, range) {
                    ranges.push(range);
                    return formatExpression(document);
                },
            }),
        );
        for (const enabled of [false, true]) {
            await setFormatSetting('formatOnPaste', enabled);
            await replaceInput('(1+1');
            await executeEditorCommand(editor, 'paste', ')');
            // On-type formatting runs asynchronously from document-change events.
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.strictEqual(
                typeCalls,
                0,
                'Pasting a trigger character must not invoke the on-type provider',
            );
            assert.strictEqual(editor.document.getText(), enabled ? '(1 + 1)' : '(1+1)');
            assert.strictEqual(ranges.length, enabled ? 1 : 0);
        }
        assert.deepStrictEqual(ranges[0], new vscode.Range(0, 4, 0, 5));
        await replaceInput('(1+1');
        await executeEditorCommand(editor, 'type', ')');
        await until(() => editor.document.getText() === '(1 + 1)');
        assert.strictEqual(typeCalls, 1, 'Typing still invokes the on-type provider after paste');
    });

    test('formats pasted ranges and keeps separate undo steps for formatting and paste', async () => {
        const ranges: vscode.Range[] = [];
        providers.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
                provideDocumentRangeFormattingEdits(document, range) {
                    ranges.push(range);
                    return formatExpression(document);
                },
            }),
        );
        await executeEditorCommand(editor, 'paste', '(1+1)');
        assert.strictEqual(editor.document.getText(), '(1 + 1)');
        assert.deepStrictEqual(ranges[0], new vscode.Range(0, 0, 0, 5));
        assert.strictEqual(editor.document.offsetAt(editor.selection.active), 7);
        await vscode.commands.executeCommand('undo');
        await until(() => editor.document.getText() === '(1+1)');
        await vscode.commands.executeCommand('undo');
        await until(() => editor.document.getText() === '');
        await setFormatSetting('formatOnPaste', false);
        await executeEditorCommand(editor, 'paste', '(1+1)');
        assert.strictEqual(editor.document.getText(), '(1+1)');
        assert.strictEqual(ranges.length, 1);
        const source = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: '',
        });
        const sourceEditor = await vscode.window.showTextDocument(source);
        await until(() => vscode.window.activeTextEditor?.document === source);
        await acknowledgeEditorSelection(sourceEditor, new vscode.Selection(0, 0, 0, 0));
        await executeEditorCommand(sourceEditor, 'paste', '(1+1)');
        assert.strictEqual(source.getText(), '(1+1)');
        await focusInput();
    });

    for (const operation of ['type', 'paste'] as const) {
        test(`discards delayed ${operation} formatting after the input clears`, async () => {
            let reply: ((edits: vscode.TextEdit[]) => void) | undefined;
            const provide = (): Promise<vscode.TextEdit[]> =>
                new Promise((resolve) => {
                    reply = resolve;
                });
            providers.push(
                operation === 'type'
                    ? vscode.languages.registerOnTypeFormattingEditProvider(
                          selector,
                          { provideOnTypeFormattingEdits: provide },
                          ')',
                      )
                    : vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
                          provideDocumentRangeFormattingEdits: provide,
                      }),
            );
            await replaceInput(operation === 'type' ? '(1+1' : '');
            const request = vscode.commands.executeCommand(operation, {
                text: operation === 'type' ? ')' : '(1+1)',
            });
            try {
                await until(() => reply !== undefined);
                const edits = formatExpression(editor.document);
                await replaceInput('');
                reply!(edits);
                await request;
                await new Promise((resolve) => setTimeout(resolve, 100));
                assert.strictEqual(
                    editor.document.getText(),
                    '',
                    'A delayed provider must not restore cleared input',
                );
            } finally {
                reply?.([]);
                await request;
            }
        });
    }

    test('discards pending formatting when the Interactive manager is recreated', async () => {
        let reply: ((edits: vscode.TextEdit[]) => void) | undefined;
        providers.push(
            vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
                provideDocumentRangeFormattingEdits: () =>
                    new Promise((resolve) => {
                        reply = resolve;
                    }),
            }),
        );
        const extension = vscode.extensions.getExtension('REditorSupport.r')!;
        const bundleRequire = createRequire(__filename);
        const bundlePath = bundleRequire.resolve(
            path.join(extension.extensionPath, 'dist/extension'),
        );
        const key = Object.keys(bundleRequire.cache).find((filename) =>
            process.platform === 'win32'
                ? filename.toLowerCase() === bundlePath.toLowerCase()
                : filename === bundlePath,
        );
        assert.ok(key);
        const context = (
            bundleRequire.cache[key]!.exports as { extensionContext: vscode.ExtensionContext }
        ).extensionContext;
        const manager = context.subscriptions.find(
            (item) =>
                typeof (item as InteractiveManager).open === 'function' &&
                typeof (item as InteractiveManager).getChildren === 'function',
        ) as InteractiveManager;
        assert.ok(manager);
        const Manager = (
            Object.getPrototypeOf(manager) as { constructor: typeof InteractiveManager }
        ).constructor;
        const request = vscode.commands.executeCommand('paste', { text: '(1+1)' });
        try {
            await until(() => reply !== undefined);
            manager.dispose();
            context.subscriptions.splice(
                context.subscriptions.indexOf(manager),
                1,
                new Manager(context),
            );
            reply!(formatExpression(editor.document));
            await request;
            assert.strictEqual(
                editor.document.getText(),
                '(1+1)',
                'Disposed manager must not apply pending formatting',
            );
        } finally {
            reply?.([]);
            await request;
        }
    });
});
