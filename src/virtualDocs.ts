import * as vscode from 'vscode';

export const docScheme = 'vscode-r';
export const docProvider = new class implements vscode.TextDocumentContentProvider {
    // class can be expanded if needed
    provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
        return uri.query;
    }
};

export async function openVirtualDoc(file: string, content: string, preserveFocus: boolean, preview: boolean, viewColumn: number): Promise<void> {
    if (content) {
        const uri = vscode.Uri.parse(`${docScheme}:${file}?${content}`);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            preserveFocus: preserveFocus,
            preview: preview,
            viewColumn: viewColumn
        });
    }
}