import * as vscode from 'vscode';

function isInteractiveInput(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    return (
        editor?.document.uri.scheme === 'vscode-interactive-input' &&
        editor.document.languageId === 'r'
    );
}

function formattingOptions(editor: vscode.TextEditor): vscode.FormattingOptions {
    return {
        tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
        insertSpaces:
            typeof editor.options.insertSpaces === 'boolean' ? editor.options.insertSpaces : true,
    };
}

// The native Interactive editor omits automatic formatting contributions.
// Ask VS Code's registered providers to supply the missing formatting behavior.
export class InteractiveInputFeatures implements vscode.Disposable {
    private readonly listeners: vscode.Disposable[];
    private disposed = false;
    private pasteDepth = 0;

    constructor(private readonly contextForEditor: (editor: vscode.TextEditor) => unknown) {
        this.listeners = [
            // Forward every paste to the built-in command, including other editors.
            // Unlike text-change events, this also identifies single-character pastes.
            vscode.commands.registerCommand('paste', (args: unknown) => this.paste(args)),
            vscode.workspace.onDidChangeTextDocument((event) => {
                void this.formatOnType(event).catch((error: unknown) => {
                    console.warn('R Interactive on-type formatting failed', error);
                });
            }),
        ];
    }

    private async formatOnType(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const document = event.document,
            editor = vscode.window.activeTextEditor;
        if (
            this.disposed ||
            this.pasteDepth > 0 ||
            !isInteractiveInput(editor) ||
            editor.document !== document ||
            event.reason !== undefined ||
            event.contentChanges.length !== 1 ||
            editor.selections.length !== 1 ||
            !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnType')
        ) {
            return;
        }
        const change = event.contentChanges[0];
        // Typing over an auto-inserted closing bracket replaces that character
        // with itself. VS Code still reports a one-character replacement.
        if (change.rangeLength !== 0 && (change.rangeLength !== 1 || change.text.length !== 1)) {
            return;
        }
        // Enter may also insert the indentation supplied by the language rules.
        const ch = /^\r?\n[\t ]*$/.test(change.text) ? '\n' : change.text;
        if (ch.length !== 1) {
            return;
        }
        const context = this.contextForEditor(editor);
        const version = document.version;
        // VS Code checks the provider's trigger characters and minimizes its
        // edits, preserving the cursor even for whole-expression replacements.
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatOnTypeProvider',
            document.uri,
            document.positionAt(change.rangeOffset + change.text.length),
            ch,
            formattingOptions(editor),
        );
        if (
            !edits?.length ||
            this.disposed ||
            document.isClosed ||
            document.version !== version ||
            vscode.window.activeTextEditor !== editor ||
            this.contextForEditor(editor) !== context ||
            !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnType')
        ) {
            return;
        }
        await editor.edit(
            (builder) => edits.forEach((edit) => builder.replace(edit.range, edit.newText)),
            { undoStopBefore: false, undoStopAfter: false },
        );
    }

    private async nativePaste(args: unknown): Promise<void> {
        // Single-character pastes emit the same document changes as typing.
        // Suppress them even when format-on-paste is disabled.
        this.pasteDepth++;
        try {
            await vscode.commands.executeCommand('default:paste', args);
        } finally {
            this.pasteDepth--;
        }
    }

    private async paste(args: unknown): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (
            !isInteractiveInput(editor) ||
            !vscode.workspace
                .getConfiguration('editor', editor.document)
                .get<boolean>('formatOnPaste')
        ) {
            await this.nativePaste(args);
            return;
        }
        const context = this.contextForEditor(editor),
            document = editor.document;
        const changes: vscode.TextDocumentContentChangeEvent[] = [];
        const listener = vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === document && event.reason === undefined) {
                changes.push(...event.contentChanges);
            }
        });
        try {
            await this.nativePaste(args);
        } finally {
            listener.dispose();
        }
        if (
            this.disposed ||
            document.isClosed ||
            vscode.window.activeTextEditor !== editor ||
            editor.selections.length !== 1 ||
            changes.length !== 1 ||
            !changes[0].text ||
            this.contextForEditor(editor) !== context
        ) {
            return;
        }
        const version = document.version,
            change = changes[0];
        const range = new vscode.Range(
            document.positionAt(change.rangeOffset),
            document.positionAt(change.rangeOffset + change.text.length),
        );
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatRangeProvider',
            document.uri,
            range,
            formattingOptions(editor),
        );
        if (
            !edits?.length ||
            this.disposed ||
            document.isClosed ||
            document.version !== version ||
            vscode.window.activeTextEditor !== editor ||
            this.contextForEditor(editor) !== context ||
            !vscode.workspace.getConfiguration('editor', document).get<boolean>('formatOnPaste')
        ) {
            return;
        }
        // Native format-on-paste is a separate undo step: first undo the
        // formatting, then undo the paste. Keep the same behavior here.
        await editor.edit((builder) => {
            edits.forEach((edit) => builder.replace(edit.range, edit.newText));
        });
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.forEach((listener) => {
            listener.dispose();
        });
    }
}
