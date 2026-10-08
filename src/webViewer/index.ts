'use strict';

import * as path from 'path';
import { Uri, ViewColumn, Webview, WebviewPanel, window, env } from 'vscode';
import { readContent, UriIcon } from '../util';
import { extensionContext } from '../extension';
import { ViewerSessionContext, viewerSessionStyle } from '../viewerSession';

interface WidgetViewer {
    panel: WebviewPanel;
    revision: number;
    disposed: boolean;
    session?: ViewerSessionContext;
    history: Array<{ file: string; title: string }>;
    index: number;
}

const widgetViewers = new Map<string, WidgetViewer>();
const historyLimit = 50;

interface WidgetToolbar {
    index: number;
    count: number;
    generation: number;
    sessionHtml: string;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
}

async function renderWidget(entry: WidgetViewer): Promise<void> {
    const generation = ++entry.revision;
    const item = entry.history[entry.index];
    const dir = path.dirname(item.file);
    const { panel } = entry;
    const resourceRoots = [
        Uri.file(dir),
        Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview')),
        Uri.file(path.join(extensionContext.extensionPath, 'dist/resources')),
    ];
    const toolbar = entry.session ? {
        index: entry.index, count: entry.history.length, generation, sessionHtml: entry.session.getHtml(),
    } : undefined;
    const html = await getWebviewHtml(panel.webview, item.file, item.title, dir, toolbar);
    if (!entry.disposed && entry.revision === generation) {
        panel.title = item.title;
        panel.webview.options = { ...panel.webview.options, localResourceRoots: resourceRoots };
        panel.webview.html = html;
        panel.reveal(panel.viewColumn, true);
    }
}

export async function showWebView(
    file: string, title: string, viewer: string | boolean, session?: ViewerSessionContext,
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
        const sessionId = session?.sessionId;
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
            entry = { panel, revision: 0, disposed: false, session, history: [], index: -1 };
            // Register before loading HTML so concurrent requests reuse the panel.
            if (sessionId) { widgetViewers.set(sessionId, entry); }
            const created = entry;
            panel.onDidDispose(() => {
                created.disposed = true;
                created.history = [];
                if (sessionId && widgetViewers.get(sessionId) === created) {
                    widgetViewers.delete(sessionId);
                }
            });
            panel.iconPath = new UriIcon('globe');
            session?.attach(panel);
            panel.webview.onDidReceiveMessage(async (msg: {
                message: string; href?: string; direction?: string; generation?: number;
            }) => {
                if (msg.message === 'linkClicked' && msg.href) {
                    void env.openExternal(Uri.parse(msg.href));
                } else if (msg.message === 'widget/navigate' && session && !created.disposed &&
                    msg.generation === created.revision && (msg.direction === 'back' || msg.direction === 'forward')) {
                    const index = created.index + (msg.direction === 'back' ? -1 : 1);
                    if (index < 0 || index >= created.history.length) { return; }
                    created.index = index;
                    await renderWidget(created);
                }
            });
        }
        entry.history.push({ file, title });
        if (entry.history.length > historyLimit) { entry.history.shift(); }
        entry.index = entry.history.length - 1;
        await renderWidget(entry);
    }
    console.info('[showWebView] Done');
}

export async function getWebviewHtml(
    webview: Webview, file: string, title: string, dir: string, toolbar?: WidgetToolbar,
): Promise<string> {
    // Resolve webview URIs before awaiting I/O; the panel may close while loading.
    const baseUri = String(webview.asWebviewUri(Uri.file(dir)));
    const scriptUri = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview/index.js')));
    const styleUri = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview/style.css')));
    const widgetScript = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview/widget.js')));
    const codicons = webview.asWebviewUri(Uri.file(path.join(extensionContext.extensionPath, 'dist/resources/codicon.css')));
    let source: string;
    try {
        source = (await readContent(file, 'utf8') || '').toString();
    } catch (error) {
        if (!toolbar) { throw error; }
        source = `<p role="alert">This HTML widget could not be loaded. Its original file may no longer be available.</p><pre>${escapeHtml(file)}</pre>`;
    }

    // define the content security policy for the webview
    // * whilst it is recommended to be strict as possible,
    // * there are several packages that require unsafe requests
    const CSP = `
        upgrade-insecure-requests;
        default-src https: data: filesystem:;
        style-src https: data: filesystem: 'unsafe-inline' ${webview.cspSource};
        script-src https: data: filesystem: 'unsafe-inline' 'unsafe-eval' ${webview.cspSource};
        worker-src https: data: filesystem: blob:;
        frame-src 'self' https: data: blob:;
    `;

    if (toolbar) {
        // Keep the complete widget document and its styles inside the iframe.
        const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><base href="${escapeHtml(baseUri)}/">`;
        let widget = /<head\b[^>]*>/i.test(source)
            ? source.replace(/<head\b[^>]*>/i, match => match + head)
            : `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
        const bridge = `<script src="${String(widgetScript)}"></script>`;
        widget = /<\/body\s*>/i.test(widget) ? widget.replace(/<\/body\s*>/i, bridge + '</body>') : widget + bridge;
        return `<!doctype html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="${CSP}">
            <title>${escapeHtml(title)}</title>
            <link rel="stylesheet" href="${String(styleUri)}">
            <link rel="stylesheet" href="${String(codicons)}">
            <style>${viewerSessionStyle}</style>
        </head>
        <body class="widget-viewer">
            <div id="widget-toolbar" role="toolbar" aria-label="HTML widget navigation" data-generation="${toolbar.generation}">
                <button id="widget-back" type="button" title="Back (Alt+Left)" aria-label="Previous HTML widget" ${toolbar.index === 0 ? 'disabled' : ''}><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
                <button id="widget-forward" type="button" title="Forward (Alt+Right)" aria-label="Next HTML widget" ${toolbar.index === toolbar.count - 1 ? 'disabled' : ''}><span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>
                <span id="widget-position" role="status">${toolbar.index + 1} / ${toolbar.count}</span>
                <span id="widget-session-info">${toolbar.sessionHtml}</span>
            </div>
            <iframe id="widget-frame" title="${escapeHtml(title)}" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" data-widget-document="${escapeHtml(widget)}"></iframe>
            <script src="${String(scriptUri)}"></script>
        </body></html>`;
    }

    const body = source.replace(/<(\w+)(.*)\s+(href|src)="(?!\w+:)/g,
        `<$1 $2 $3="${baseUri}/`);

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
