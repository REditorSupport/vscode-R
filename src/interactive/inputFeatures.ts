import * as vscode from 'vscode';
import { DocumentHighlightRequest, LanguageClient } from 'vscode-languageclient/node';

interface EditorState {
    timer?: NodeJS.Timeout;
    request?: vscode.CancellationTokenSource;
    revision: number;
}

function isInteractiveInput(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    return editor?.document.uri.scheme === 'vscode-interactive-input' && editor.document.languageId === 'r';
}

function formattingOptions(editor: vscode.TextEditor): vscode.FormattingOptions {
    return {
        tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
        insertSpaces: typeof editor.options.insertSpaces === 'boolean' ? editor.options.insertSpaces : true,
    };
}

// The native Interactive editor omits the controls for these language features.
// Use each input's owning client to supply the missing editor behavior.
export class InteractiveInputFeatures implements vscode.Disposable {
    private readonly states = new Map<vscode.TextEditor, EditorState>();
    private readonly highlights = [
        this.highlight('editor.wordHighlightTextBackground', 'editor.wordHighlightTextBorder'),
        this.highlight('editor.wordHighlightBackground', 'editor.wordHighlightBorder'),
        this.highlight('editor.wordHighlightStrongBackground', 'editor.wordHighlightStrongBorder'),
    ];
    private readonly listeners: vscode.Disposable[];
    private disposed = false;

    constructor(private readonly clientForEditor: (editor: vscode.TextEditor) => LanguageClient | undefined) {
        this.listeners = [
            // Forward every paste to the built-in command, including other editors.
            // Unlike text-change events, this also identifies single-character pastes.
            vscode.commands.registerCommand('paste', (args: unknown) => this.paste(args)),
            vscode.workspace.onDidChangeTextDocument(event => {
                void this.formatOnType(event).catch((error: unknown) => { console.warn('R Interactive on-type formatting failed', error); });
                for (const editor of this.states.keys()) {
                    if (editor.document === event.document) { this.schedule(editor); }
                }
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (isInteractiveInput(event.textEditor)) { this.schedule(event.textEditor); }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('editor')) {
                    for (const editor of this.states.keys()) { this.schedule(editor); }
                }
            }),
        ];
        this.refresh();
    }

    private highlight(background: string, border: string): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor(background), borderColor: new vscode.ThemeColor(border),
            borderStyle: 'solid', borderWidth: '1px', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
    }

    refresh(document?: vscode.TextDocument): void {
        if (this.disposed) { return; }
        const visible = vscode.window.visibleTextEditors.filter(isInteractiveInput);
        for (const [editor, state] of this.states) {
            if (!visible.includes(editor)) {
                this.cancel(state); this.clear(editor); this.states.delete(editor);
            }
        }
        for (const editor of visible) {
            if (!document || editor.document === document) { this.schedule(editor); }
        }
    }

    private clear(editor: vscode.TextEditor): void {
        this.highlights.forEach(type => this.setDecorations(editor, type, []));
    }

    private setDecorations(editor: vscode.TextEditor, type: vscode.TextEditorDecorationType,
        decorations: readonly vscode.Range[]): void {
        editor.setDecorations(type, decorations);
    }

    private cancel(state: EditorState): void {
        clearTimeout(state.timer); state.timer = undefined;
        state.request?.cancel(); state.request?.dispose(); state.request = undefined;
        state.revision++;
    }

    private schedule(editor: vscode.TextEditor): void {
        if (this.disposed) { return; }
        const state = this.states.get(editor) ?? { revision: 0 };
        this.states.set(editor, state); this.cancel(state);
        this.clear(editor);
        if (!editor.document.getText().trim()) { return; }
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.updateHighlights(editor, state).catch((error: unknown) => { console.warn('R Interactive occurrence highlighting failed', error); });
        }, 250);
    }

    private async updateHighlights(editor: vscode.TextEditor, state: EditorState): Promise<void> {
        const client = this.clientForEditor(editor);
        if (!client?.isRunning() || editor !== vscode.window.activeTextEditor) { return; }
        const document = editor.document, version = document.version, revision = state.revision;
        const selection = editor.selection;
        const config = vscode.workspace.getConfiguration('editor', document);
        const occurrenceMode = config.get<string | boolean>('occurrencesHighlight', 'singleFile');
        const wordSelected = selection.isSingleLine && document.getWordRangeAtPosition(selection.start)?.isEqual(selection);
        if (editor.selections.length !== 1 || (!selection.isEmpty && !wordSelected) || occurrenceMode === 'off' || occurrenceMode === false) { return; }
        const request = new vscode.CancellationTokenSource(); state.request = request;
        try {
            const values = await client.getFeature(DocumentHighlightRequest.method).getProvider(document)?.provideDocumentHighlights(document,
                selection.isEmpty ? selection.active : selection.start, request.token);
            if (this.disposed || request.token.isCancellationRequested || document.isClosed || document.version !== version
                || state.revision !== revision || editor !== vscode.window.activeTextEditor || this.clientForEditor(editor) !== client) { return; }
            this.highlights.forEach((type, index) => this.setDecorations(editor, type,
                (values ?? []).filter(item => (item.kind ?? vscode.DocumentHighlightKind.Text) === index).map(item => item.range)));
        } finally {
            if (state.request === request) { state.request = undefined; request.dispose(); }
        }
    }

    private async formatOnType(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const document = event.document, editor = vscode.window.activeTextEditor;
        if (this.disposed || !isInteractiveInput(editor) || editor.document !== document || event.reason !== undefined
            || event.contentChanges.length !== 1 || editor.selections.length !== 1
            || !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnType')) { return; }
        const change = event.contentChanges[0];
        // Typing over an auto-inserted closing bracket replaces that character
        // with itself. VS Code still reports a one-character replacement.
        if (change.rangeLength !== 0 && (change.rangeLength !== 1 || change.text.length !== 1)) { return; }
        // Enter may also insert the indentation supplied by the language rules.
        const ch = /^\r?\n[\t ]*$/.test(change.text) ? '\n' : change.text;
        if (ch.length !== 1) { return; }
        const client = this.clientForEditor(editor);
        const capabilities = client?.initializeResult?.capabilities.documentOnTypeFormattingProvider;
        if (!client?.isRunning() || !capabilities || ![capabilities.firstTriggerCharacter,
            ...(capabilities.moreTriggerCharacter ?? [])].includes(ch)) { return; }
        const version = document.version;
        // The command minimizes the server's edits, preserving the cursor
        // when languageserver replaces the entire expression around it.
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatOnTypeProvider', document.uri,
            document.positionAt(change.rangeOffset + change.text.length), ch, formattingOptions(editor));
        if (!edits?.length || this.disposed || document.isClosed || document.version !== version
            || vscode.window.activeTextEditor !== editor || this.clientForEditor(editor) !== client
            || !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnType')) { return; }
        await editor.edit(builder => edits.forEach(edit => builder.replace(edit.range, edit.newText)),
            { undoStopBefore: false, undoStopAfter: false });
    }

    private async paste(args: unknown): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!isInteractiveInput(editor) || !vscode.workspace.getConfiguration('editor', editor.document).get<boolean>('formatOnPaste')) {
            await vscode.commands.executeCommand('default:paste', args); return;
        }
        const client = this.clientForEditor(editor), document = editor.document;
        const changes: vscode.TextDocumentContentChangeEvent[] = [];
        const listener = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === document && event.reason === undefined) { changes.push(...event.contentChanges); }
        });
        try { await vscode.commands.executeCommand('default:paste', args); }
        finally { listener.dispose(); }
        if (this.disposed || document.isClosed || vscode.window.activeTextEditor !== editor || editor.selections.length !== 1
            || changes.length !== 1 || !changes[0].text || !client?.isRunning() || this.clientForEditor(editor) !== client) { return; }
        const version = document.version, change = changes[0];
        const range = new vscode.Range(document.positionAt(change.rangeOffset), document.positionAt(change.rangeOffset + change.text.length));
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatRangeProvider', document.uri, range, formattingOptions(editor));
        if (!edits?.length || this.disposed || document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor
            || this.clientForEditor(editor) !== client || !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnPaste')) { return; }
        // Native format-on-paste is a separate undo step: first undo the
        // formatting, then undo the paste. Keep the same behavior here.
        await editor.edit(builder => { edits.forEach(edit => builder.replace(edit.range, edit.newText)); });
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.forEach(listener => { listener.dispose(); });
        for (const [editor, state] of this.states) { this.cancel(state); this.clear(editor); }
        this.states.clear(); this.highlights.forEach(type => type.dispose());
    }
}
