'use strict';

import * as path from 'path';
import { readFile } from 'fs-extra';
import { ExtensionContext, Uri, ViewColumn, Webview, WebviewPanel, window, env, commands, workspace } from 'vscode';
import { ViewerSessionContext, ViewerSessionSource, viewerSessionStyle } from '../viewerSession';
import { WidgetHistory, WidgetHistoryStore, widgetHistoryLimit, widgetSessionIdentity } from './history';

export interface HtmlViewerSessionAccess {
    resolveSession(source: ViewerSessionSource): ViewerSessionContext;
    getActiveSessionId(): string | undefined;
}

interface WidgetViewer {
    panel: WebviewPanel;
    revision: number;
    disposed: boolean;
    session?: ViewerSessionContext;
    state: Pick<WidgetHistory, 'history' | 'index' | 'viewColumn'>;
    saved?: WidgetHistory;
}

let manager: HtmlWidgetViewerManager | undefined;
const htmlViewerTitle = 'HTML Viewer';

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
    const { extensionPath } = getManager().context;
    const generation = ++entry.revision;
    const item = entry.state.history[entry.state.index];
    const dir = item ? path.dirname(item.file) : path.join(extensionPath, 'dist/webviews/webview');
    const { panel } = entry;
    const resourceRoots = [
        Uri.file(dir),
        Uri.file(path.join(extensionPath, 'dist/webviews/webview')),
        Uri.file(path.join(extensionPath, 'dist/resources')),
    ];
    const toolbar = entry.session ? {
        index: entry.state.index, count: entry.state.history.length, generation, sessionHtml: entry.session.getHtml(),
    } : undefined;
    const html = await getWebviewHtml(panel.webview, item?.file, item?.title ?? htmlViewerTitle, dir, toolbar);
    if (!entry.disposed && entry.revision === generation) {
        panel.title = htmlViewerTitle;
        panel.webview.options = { ...panel.webview.options, localResourceRoots: resourceRoots };
        panel.webview.html = html;
        panel.reveal(panel.viewColumn, true);
    }
}

/** Initialize retained history once per extension host, including closed Viewer tabs. */
export function initializeHtmlWidgetViewers(
    context: ExtensionContext, sessions: HtmlViewerSessionAccess,
): HtmlWidgetViewerManager {
    manager?.dispose();
    manager = new HtmlWidgetViewerManager(context, sessions);
    context.subscriptions.push(manager);
    return manager;
}

function getManager(): HtmlWidgetViewerManager {
    if (!manager || manager.disposed) {
        throw new Error('HTML Viewer has not been initialized.');
    }
    return manager;
}

export async function showWebView(
    file: string, title: string, viewer: string | boolean, session?: ViewerSessionContext,
): Promise<void> {
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
        return;
    }
    await getManager().show(file, title, viewer, session);
}

export async function restoreHtmlViewer(sessionId?: string): Promise<void> {
    await getManager().restore(sessionId);
}

export async function shutdownHtmlWidgetViewers(): Promise<void> {
    manager?.dispose();
    await manager?.histories.flush();
}

class HtmlWidgetViewerManager {
    readonly histories: WidgetHistoryStore;
    readonly viewers = new Map<string, WidgetViewer>();
    disposed = false;

    constructor(readonly context: ExtensionContext, private readonly sessions: HtmlViewerSessionAccess) {
        this.histories = new WidgetHistoryStore(context.workspaceState, source => sessions.resolveSession(source));
    }

    async show(file: string, title: string, viewer: string | boolean, session?: ViewerSessionContext): Promise<void> {
        const saved = session ? this.histories.remember(session) : undefined;
        const entry = this.open(viewer, session, saved);
        entry.state.history.push({ file, title });
        if (entry.state.history.length > widgetHistoryLimit) { entry.state.history.shift(); }
        entry.state.index = entry.state.history.length - 1;
        const pending = this.save(entry);
        await renderWidget(entry);
        await pending;
    }

    async restore(sessionId?: string): Promise<void> {
        // Polling can discover an exit while the session picker is open.
        const available = [...this.histories.entries.values()].filter(record => {
            if (this.sessions.resolveSession(record.source).hasExited) {
                this.histories.forget(record.source.sessionId);
                return false;
            }
            return record.history.length > 0;
        });
        const activeSessionId = sessionId ? undefined : this.sessions.getActiveSessionId();
        let record = sessionId ? this.histories.entries.get(sessionId) :
            available.find(item => item.source.sessionId === activeSessionId);
        if (!record && !sessionId) {
            if (available.length === 1) { record = available[0]; }
            else if (available.length > 1) {
                const picked = await window.showQuickPick(available.map(item => ({
                    label: item.history[item.index].title,
                    description: `R ${item.source.rVer}: ${item.source.pid} · ${item.source.host}`,
                    detail: `${item.history.length} HTML outputs · ${item.source.sessionId}`,
                    record: item,
                })), { title: 'Restore HTML Viewer', matchOnDescription: true, matchOnDetail: true });
                if (!picked) { return; }
                record = picked.record;
            }
        }
        if (!record || this.histories.entries.get(record.source.sessionId) !== record) {
            void window.showInformationMessage('No retained HTML Viewer history is available for this session.');
            return;
        }
        const session = this.sessions.resolveSession(record.source);
        if (session.hasExited) {
            this.histories.forget(session.sessionId);
            void window.showInformationMessage('This R session has exited; its HTML Viewer history is no longer available.');
            return;
        }
        const viewer = record.viewColumn ? ViewColumn[record.viewColumn] :
            workspace.getConfiguration('r').get<Record<string, string>>('session.viewers.viewColumn')?.viewer ?? 'Two';
        // Explicit restoration opens a Viewer even if automatic viewing is disabled.
        const entry = this.open(viewer, session, record);
        const pending = this.save(entry);
        await renderWidget(entry);
        await pending;
    }

    private open(viewer: string | boolean, session?: ViewerSessionContext, saved?: WidgetHistory): WidgetViewer {
        const identity = session ? widgetSessionIdentity(session.source) : undefined;
        const existing = identity ? this.viewers.get(identity) : undefined;
        if (existing) { return existing; }
        const panel = window.createWebviewPanel('webview', htmlViewerTitle,
            { preserveFocus: true, viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn] ?? ViewColumn.Two },
            { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true });
        const entry: WidgetViewer = {
            panel, revision: 0, disposed: false, session, saved,
            state: saved ?? { history: [], index: -1 },
        };
        // Register before loading HTML so concurrent requests reuse the panel.
        if (identity) { this.viewers.set(identity, entry); }
        panel.onDidDispose(() => {
            entry.disposed = true;
            if (!this.disposed) { void this.save(entry); }
            if (identity && this.viewers.get(identity) === entry) { this.viewers.delete(identity); }
        });
        panel.onDidChangeViewState(() => { if (!entry.disposed) { void this.save(entry); } });
        const iconPath = this.context.asAbsolutePath('images/icons');
        panel.iconPath = {
            dark: Uri.file(path.join(iconPath, 'dark', 'globe.svg')),
            light: Uri.file(path.join(iconPath, 'light', 'globe.svg')),
        };
        session?.attach(panel);
        panel.webview.onDidReceiveMessage(async (msg: {
            message: string; href?: string; direction?: string; generation?: number;
        }) => {
            if (msg.message === 'linkClicked' && msg.href) {
                void env.openExternal(Uri.parse(msg.href));
            } else if (msg.message === 'widget/find' && session && !entry.disposed && msg.generation === entry.revision) {
                // Synthetic key events from the nested iframe are ignored by VS Code.
                // Activate its owning panel before opening the built-in Find widget.
                panel.reveal(panel.viewColumn, false);
                await commands.executeCommand('editor.action.webvieweditor.showFind');
            } else if (msg.message === 'widget/navigate' && session && !entry.disposed &&
                msg.generation === entry.revision && (msg.direction === 'back' || msg.direction === 'forward')) {
                const index = entry.state.index + (msg.direction === 'back' ? -1 : 1);
                if (index < 0 || index >= entry.state.history.length) { return; }
                entry.state.index = index;
                const pending = this.save(entry);
                await renderWidget(entry);
                await pending;
            } else if (msg.message === 'widget/remove' && session && !entry.disposed &&
                msg.generation === entry.revision && entry.state.index >= 0 && entry.state.index < entry.state.history.length) {
                entry.state.history.splice(entry.state.index, 1);
                // Prefer the previous output; deleting the first selects the next.
                entry.state.index = entry.state.history.length ? Math.max(0, entry.state.index - 1) : -1;
                const pending = this.save(entry);
                await renderWidget(entry);
                await pending;
            }
        });
        return entry;
    }

    private save(entry: WidgetViewer): Promise<void> {
        if (!entry.disposed) { entry.state.viewColumn = entry.panel.viewColumn; }
        return entry.saved ? this.histories.save(entry.saved) : Promise.resolve();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.viewers.forEach(entry => { void this.save(entry); });
        this.disposed = true;
        this.viewers.forEach(entry => { entry.panel.dispose(); });
        this.viewers.clear();
        this.histories.dispose();
    }
}

export async function getWebviewHtml(
    webview: Webview, file: string | undefined, title: string, dir: string, toolbar?: WidgetToolbar,
): Promise<string> {
    const { extensionPath } = getManager().context;
    // Resolve webview URIs before awaiting I/O; the panel may close while loading.
    const baseUri = String(webview.asWebviewUri(Uri.file(dir)));
    const scriptUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/index.js')));
    const styleUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/style.css')));
    const widgetScript = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/widget.js')));
    const codicons = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/resources/codicon.css')));
    let source = '<p>No HTML outputs in this session. New HTML output will appear here.</p>';
    if (file !== undefined) {
        try {
            source = await readFile(file, 'utf8');
        } catch (error) {
            if (!toolbar) { throw error; }
            source = `<p role="alert">This HTML widget could not be loaded. Its original file may no longer be available.</p><pre>${escapeHtml(file)}</pre>`;
        }
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
                <button id="widget-back" type="button" title="Back (Alt+Left)" aria-label="Previous HTML widget" ${toolbar.index <= 0 ? 'disabled' : ''}><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
                <button id="widget-forward" type="button" title="Forward (Alt+Right)" aria-label="Next HTML widget" ${toolbar.index === toolbar.count - 1 ? 'disabled' : ''}><span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>
                <span id="widget-position" role="status">${toolbar.index + 1} / ${toolbar.count}</span>
                <button id="widget-remove" type="button" title="Remove current HTML output from history" aria-label="Remove current HTML output from history" ${toolbar.count === 0 ? 'disabled' : ''}><span class="codicon codicon-error" aria-hidden="true"></span></button>
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
