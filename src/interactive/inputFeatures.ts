import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

function isInteractiveInput(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    return editor?.document.uri.scheme === 'vscode-interactive-input' && editor.document.languageId === 'r';
}

function formattingOptions(editor: vscode.TextEditor): vscode.FormattingOptions {
    return {
        tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
        insertSpaces: typeof editor.options.insertSpaces === 'boolean' ? editor.options.insertSpaces : true,
    };
}

// The native Interactive editor omits automatic formatting contributions.
// Use each input's owning client to supply the missing formatting behavior.
export class InteractiveInputFeatures implements vscode.Disposable {
    private readonly listeners: vscode.Disposable[];
    private disposed = false;

    constructor(private readonly clientForEditor: (editor: vscode.TextEditor) => LanguageClient | undefined) {
        this.listeners = [
            // Forward every paste to the built-in command, including other editors.
            // Unlike text-change events, this also identifies single-character pastes.
            vscode.commands.registerCommand('paste', (args: unknown) => this.paste(args)),
            vscode.workspace.onDidChangeTextDocument(event => {
                void this.formatOnType(event).catch((error: unknown) => { console.warn('R Interactive on-type formatting failed', error); });
            }),
        ];
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
    }
}
