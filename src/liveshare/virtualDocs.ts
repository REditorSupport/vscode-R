import * as vscode from 'vscode';

export const docScheme = 'vscode-r';
export const docProvider = new class implements vscode.TextDocumentContentProvider {
    // class can be expanded if needed
    provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
        return uri.query;
    }
};

export async function openVirtualDoc(str: string, preserveFocus: boolean, preview: boolean, viewColumn: number): Promise<void> {
    if (str) {
        const uri = vscode.Uri.parse(`${docScheme}:dataview.r?${str}`);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
            preserveFocus: preserveFocus,
            preview: preview,
            viewColumn: viewColumn
        });
    }
}