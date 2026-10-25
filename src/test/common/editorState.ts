import * as assert from 'assert';
import * as vscode from 'vscode';

export async function waitForEditorState(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** Selection setters are asynchronous RPCs; wait for the workbench round trip. */
export async function acknowledgeEditorSelection(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
): Promise<void> {
    editor.selection = selection;
    // The command is processed after the selection RPC, even if the requested
    // selection is unchanged and no selection-change notification is emitted.
    await vscode.commands.executeCommand('revealLine', {
        lineNumber: selection.active.line,
        at: 'simple',
    });
    await waitForEditorState(
        () =>
            vscode.window.activeTextEditor === editor &&
            editor.selections.length === 1 &&
            editor.selection.isEqual(selection),
        'Timed out waiting for the focused editor selection',
    );
}

/** Native editor commands can return before their document changes are observed. */
export async function executeEditorCommand(
    editor: vscode.TextEditor,
    command: 'type' | 'paste',
    text: string,
): Promise<void> {
    const version = editor.document.version;
    await vscode.commands.executeCommand(command, { text });
    await waitForEditorState(
        () => editor.document.version > version,
        `The ${command} command did not change the intended document`,
    );
    await vscode.commands.executeCommand('revealLine', {
        lineNumber: editor.selection.active.line,
        at: 'simple',
    });
}
