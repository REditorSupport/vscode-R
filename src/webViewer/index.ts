'use strict';

import * as path from 'path';
import { Uri, ViewColumn, Webview, WebviewPanel, window, env } from 'vscode';
import { readContent, UriIcon } from '../util';
import { extensionContext } from '../extension';

interface WidgetViewer {
    panel: WebviewPanel;
    revision: number;
    disposed: boolean;
}

const widgetViewers = new Map<string, WidgetViewer>();

export async function showWebView(
    file: string, title: string, viewer: string | boolean, sessionId: string | null = null,
): Promise<void> {
    console.info(`[showWebView] file: ${file}, viewer: ${viewer.toString()}`);
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
    } else {
        const dir = path.dirname(file);
        const resourceRoots = [
            Uri.file(dir),
            Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview')),
        ];
        let entry = sessionId ? widgetViewers.get(sessionId) : undefined;
        if (!entry) {
            const panel = window.createWebviewPanel('webview', title,
                {
                    preserveFocus: true,
                    viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn],
                },
                {
                    enableScripts: true,
                    enableFindWidget: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: resourceRoots,
                });
            entry = { panel, revision: 0, disposed: false };
            // Register before loading HTML so concurrent requests reuse the panel.
            if (sessionId) { widgetViewers.set(sessionId, entry); }
            const created = entry;
            panel.onDidDispose(() => {
                created.disposed = true;
                if (sessionId && widgetViewers.get(sessionId) === created) {
                    widgetViewers.delete(sessionId);
                }
            });
            panel.iconPath = new UriIcon('globe');
            panel.webview.onDidReceiveMessage((msg: { message: string, href?: string }) => {
                if (msg.message === 'linkClicked' && msg.href) {
                    void env.openExternal(Uri.parse(msg.href));
                }
            });
        }
        const revision = ++entry.revision;
        const { panel } = entry;
        const html = await getWebviewHtml(panel.webview, file, title, dir);
        if (!entry.disposed && entry.revision === revision) {
            panel.title = title;
            panel.webview.options = { ...panel.webview.options, localResourceRoots: resourceRoots };
            panel.webview.html = html;
            panel.reveal(panel.viewColumn, true);
        }
    }
    console.info('[showWebView] Done');
}

export async function getWebviewHtml(
    webview: Webview, file: string, title: string, dir: string,
): Promise<string> {
    // Resolve webview URIs before awaiting I/O; the panel may close while loading.
    const baseUri = String(webview.asWebviewUri(Uri.file(dir)));
    const scriptUri = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview/index.js')));
    const styleUri = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview/style.css')));
    const body = (await readContent(file, 'utf8') || '').toString()
        .replace(/<(\w+)(.*)\s+(href|src)="(?!\w+:)/g,
            `<$1 $2 $3="${baseUri}/`);

    // define the content security policy for the webview
    // * whilst it is recommended to be strict as possible,
    // * there are several packages that require unsafe requests
    const CSP = `
        upgrade-insecure-requests;
        default-src https: data: filesystem:;
        style-src https: data: filesystem: 'unsafe-inline' ${webview.cspSource};
        script-src https: data: filesystem: 'unsafe-inline' 'unsafe-eval' ${webview.cspSource};
        worker-src https: data: filesystem: blob:;
    `;

    return `
    <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="${CSP}">
                <title>${title}</title>
                <link rel="stylesheet" href="${String(styleUri)}">
            </head>
            <body>
                <span id="webview-content">
                    ${body}
                </span>
                <script src="${String(scriptUri)}"></script>
            </body>
        </html>`;
}
