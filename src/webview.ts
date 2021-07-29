import path = require('path');
import * as vscode from 'vscode';
import { extensionContext } from './extension';
import { readContent } from './util';

export async function newWebview(file: string, title: string, viewer: string | boolean): Promise<void> {
    const dir = path.dirname(file);
    const panel = vscode.window.createWebviewPanel('webview', title,
        {
            preserveFocus: true,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            viewColumn: vscode.ViewColumn[String(viewer)],
        },
        {
            enableScripts: true,
            enableFindWidget: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(dir), extensionContext.extensionUri],
        });

    const observerPath = vscode.Uri.file(extensionContext.asAbsolutePath('html/webview/observer.js'));
    const body = (await readContent(file, 'utf8')).toString()
        .replace('<body>', '<body style="color: black;">')
        .replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
            `<$1 $2="${String(panel.webview.asWebviewUri(vscode.Uri.file(dir)))}/`);

    const htmlOut = `<!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">
            <title>${title}</title>
        </head>
        <body>
            <pre>
                ${body}
            </pre>
        </body>
        <script src = ${String(panel.webview.asWebviewUri(observerPath))}></script>
    </html>`;

    panel.webview.html = htmlOut;
}

