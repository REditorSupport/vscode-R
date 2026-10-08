'use strict';

import * as path from 'path';
import { randomUUID } from 'crypto';
import { readFile } from 'fs-extra';
import { Disposable, ExtensionContext, Uri, ViewColumn, Webview, WebviewPanel, window, env, commands, workspace } from 'vscode';
import { ViewerSessionContext, ViewerSessionSource, formatSessionLabel } from '../viewerSession';
import { WidgetHistory, WidgetHistoryStore, widgetHistoryLimit, widgetSessionIdentity } from './history';
import type { HtmlViewerPanelReference, HtmlViewerPanelState } from './webviewMessages';

export interface HtmlViewerSessionAccess {
    resolveSession(source: ViewerSessionSource): ViewerSessionContext;
    getActiveSessionId(): string | undefined;
}

interface WidgetViewer {
    id: string;
    panel: WebviewPanel;
    revision: number;
    disposed: boolean;
    loading: boolean;
    showSessionInfo: boolean;
    subscriptions: Array<{ dispose(): void }>;
    session?: ViewerSessionContext;
    state: Pick<WidgetHistory, 'history' | 'index' | 'viewColumn'>;
    saved?: WidgetHistory;
}

let manager: HtmlWidgetViewerManager | undefined;
const htmlViewerTitle = 'HTML Viewer';
const panelStateKey = 'r.htmlViewer.panels';

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
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

export type HtmlViewerAction = 'back' | 'forward' | 'remove' | 'info';

export async function runHtmlViewerCommand(action: HtmlViewerAction): Promise<void> {
    await getManager().runCommand(action);
}

export async function shutdownHtmlWidgetViewers(preservePanels = false): Promise<void> {
    manager?.dispose(preservePanels);
    await manager?.flush();
}

class HtmlWidgetViewerManager {
    readonly histories: WidgetHistoryStore;
    readonly viewers = new Map<string, WidgetViewer>();
    disposed = false;
    private readonly panels = new Set<WidgetViewer>();
    private readonly serializer: Disposable;
    private readonly panelStates = new Map<string, HtmlViewerPanelState>();
    private panelWrites: Promise<void> = Promise.resolve();

    constructor(readonly context: ExtensionContext, private readonly sessions: HtmlViewerSessionAccess) {
        this.histories = new WidgetHistoryStore(context.workspaceState, source => sessions.resolveSession(source));
        const savedPanels = context.workspaceState.get<unknown>(panelStateKey);
        if (Array.isArray(savedPanels)) {
            for (const value of savedPanels) {
                const state = parsePanelState(value);
                if (state) { this.panelStates.set(state.id, state); }
            }
        }
        this.serializer = window.registerWebviewPanelSerializer('r.htmlViewer', this);
    }

    async deserializeWebviewPanel(panel: WebviewPanel, state: unknown): Promise<void> {
        if (this.disposed) { panel.dispose(); return; }
        // Webview state contains only a reference. Paths and ownership come from
        // extension-owned storage, so output scripts cannot supply arbitrary files.
        const id = state && typeof state === 'object' && 'id' in state && typeof state.id === 'string' ? state.id : undefined;
        const restored = id ? this.panelStates.get(id) : undefined;
        const resolved = restored?.source ? this.sessions.resolveSession(restored.source) : undefined;
        const session = resolved && restored?.source &&
            widgetSessionIdentity(resolved.source) === widgetSessionIdentity(restored.source) ? resolved : undefined;
        const identity = session ? widgetSessionIdentity(session.source) : undefined;
        const retained = session ? this.histories.entries.get(session.sessionId) : undefined;
        // The restored tab must belong to the same process as its retained history.
        const saved = retained && widgetSessionIdentity(retained.source) === identity ? retained :
            session && !retained && !session.hasExited ? this.histories.remember(session) : undefined;
        if (saved && !retained && restored) {
            saved.history = restored.history.map(item => ({ ...item }));
            saved.index = restored.index;
        }
        const existing = identity ? this.viewers.get(identity) : undefined;
        // A notification may open a new panel before VS Code restores the original tab.
        // Keep the restored tab and the latest retained history as the canonical viewer.
        existing?.panel.dispose();
        const entry = this.attachPanel(panel, session, saved, restored?.showSessionInfo, restored?.id);
        if (!saved && restored) {
            entry.state = { history: restored.history.map(item => ({ ...item })), index: restored.index, viewColumn: panel.viewColumn };
        }
        panel.webview.options = { ...panel.webview.options, enableScripts: true };
        const pending = this.save(entry);
        await this.render(entry, false);
        await pending;
    }

    async show(file: string, title: string, viewer: string | boolean, session?: ViewerSessionContext): Promise<void> {
        const saved = session ? this.histories.remember(session) : undefined;
        const entry = this.open(viewer, session, saved);
        entry.state.history.push({ file, title });
        if (entry.state.history.length > widgetHistoryLimit) { entry.state.history.shift(); }
        entry.state.index = entry.state.history.length - 1;
        const pending = this.save(entry);
        await this.render(entry);
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
        await this.render(entry);
        await pending;
    }

    private open(viewer: string | boolean, session?: ViewerSessionContext, saved?: WidgetHistory): WidgetViewer {
        const identity = session ? widgetSessionIdentity(session.source) : undefined;
        const existing = identity ? this.viewers.get(identity) : undefined;
        if (existing) { return existing; }
        const panel = window.createWebviewPanel('r.htmlViewer', htmlViewerTitle,
            { preserveFocus: true, viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn] ?? ViewColumn.Two },
            { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true });
        return this.attachPanel(panel, session, saved);
    }

    private attachPanel(panel: WebviewPanel, session?: ViewerSessionContext, saved?: WidgetHistory, showSessionInfo = false, id: string = randomUUID()): WidgetViewer {
        const identity = session ? widgetSessionIdentity(session.source) : undefined;
        const entry: WidgetViewer = {
            id, panel, revision: 0, disposed: false, loading: false, showSessionInfo, session, saved, subscriptions: [],
            state: saved ?? { history: [], index: -1 },
        };
        this.panels.add(entry);
        // Register before loading HTML so concurrent requests reuse the panel.
        if (identity) { this.viewers.set(identity, entry); }
        const exitObservation = session?.observeExit(() => {
            this.updateTitle(entry);
            this.updateToolbar();
            void this.updatePanelState(entry);
        });
        if (exitObservation) { entry.subscriptions.push(exitObservation); }
        entry.subscriptions.push(panel.onDidDispose(() => {
            entry.disposed = true;
            this.releasePanel(entry);
            this.panelStates.delete(entry.id);
            this.panels.delete(entry);
            this.updateToolbar();
            if (!this.disposed) {
                if (entry.saved) { void this.histories.save(entry.saved); }
                void this.persistPanelStates();
            }
            if (identity && this.viewers.get(identity) === entry) { this.viewers.delete(identity); }
        }));
        entry.subscriptions.push(panel.onDidChangeViewState(() => {
            if (!entry.disposed) { void this.save(entry); }
            this.updateToolbar();
        }));
        const iconPath = this.context.asAbsolutePath('images/icons');
        panel.iconPath = {
            dark: Uri.file(path.join(iconPath, 'dark', 'globe.svg')),
            light: Uri.file(path.join(iconPath, 'light', 'globe.svg')),
        };
        entry.subscriptions.push(panel.webview.onDidReceiveMessage(async (msg: {
            message: string; href?: string; direction?: string; generation?: number;
        }) => {
            if (entry.disposed) { return; }
            if (msg.message === 'linkClicked' && msg.href) {
                void env.openExternal(Uri.parse(msg.href));
            } else if (msg.message === 'widget/find' && !entry.disposed && msg.generation === entry.revision) {
                panel.reveal(panel.viewColumn, false);
                await commands.executeCommand('editor.action.webvieweditor.showFind');
            } else if (msg.message === 'widget/navigate' && msg.generation === entry.revision &&
                (msg.direction === 'back' || msg.direction === 'forward')) {
                await this.changeHistory(entry, msg.direction);
            }
        }));
        this.updateTitle(entry);
        return entry;
    }

    private releasePanel(entry: WidgetViewer): void {
        entry.subscriptions.splice(0).forEach(subscription => subscription?.dispose());
    }

    private panelState(entry: WidgetViewer): HtmlViewerPanelState {
        return {
            id: entry.id, version: 1,
            source: entry.session ? { ...entry.session.source, processExited: entry.session.hasExited } : undefined,
            history: entry.state.history.map(item => ({ ...item })), index: entry.state.index,
            showSessionInfo: entry.showSessionInfo,
        };
    }

    private updatePanelState(entry: WidgetViewer): Promise<void> {
        if (entry.disposed || this.disposed) { return this.panelWrites; }
        this.panelStates.set(entry.id, this.panelState(entry));
        return this.persistPanelStates();
    }

    private persistPanelStates(): Promise<void> {
        const states = [...this.panelStates.values()];
        this.panelWrites = this.panelWrites.then(() => this.context.workspaceState.update(panelStateKey, states))
            .catch(error => console.warn('[HTML Viewer] Could not save panel state', error));
        return this.panelWrites;
    }

    async flush(): Promise<void> {
        await Promise.all([this.histories.flush(), this.panelWrites]);
    }

    private activeViewer(): WidgetViewer | undefined {
        return [...this.panels].find(entry => !entry.disposed && entry.panel.active);
    }

    private updateToolbar(): void {
        const entry = this.activeViewer();
        const session = entry?.session;
        const ready = Boolean(entry?.session && !entry.loading);
        void Promise.all([
            commands.executeCommand('setContext', 'r.htmlViewer.canGoBack', ready && entry!.state.index > 0),
            commands.executeCommand('setContext', 'r.htmlViewer.canGoForward', ready && entry!.state.index < entry!.state.history.length - 1),
            commands.executeCommand('setContext', 'r.htmlViewer.canRemove', ready && entry!.state.index >= 0),
            commands.executeCommand('setContext', 'r.htmlViewer.canShowInfo', Boolean(session &&
                (session.hasExited || (session.source.rVer && session.source.pid)))),
        ]).catch(error => console.warn('[HTML Viewer] Could not update toolbar', error));
    }

    private updateTitle(entry: WidgetViewer): void {
        if (entry.disposed) { return; }
        const session = entry.session;
        const label = session?.hasExited ? 'R: (not attached)' :
            session ? formatSessionLabel(session.source.rVer, session.source.pid) : '';
        entry.panel.title = entry.showSessionInfo && label ? `${htmlViewerTitle} · ${label}` : htmlViewerTitle;
    }

    async runCommand(action: HtmlViewerAction): Promise<void> {
        const entry = this.activeViewer();
        if (!entry) { return; }
        if (action === 'info') {
            const session = entry.session;
            if (!session || (!session.hasExited && (!session.source.rVer || !session.source.pid))) { return; }
            entry.showSessionInfo = !entry.showSessionInfo;
            this.updateTitle(entry);
            await this.updatePanelState(entry);
        } else {
            await this.changeHistory(entry, action);
        }
    }

    private async changeHistory(entry: WidgetViewer, action: 'back' | 'forward' | 'remove'): Promise<void> {
        if (entry.disposed || entry.loading || !entry.session) { return; }
        if (action === 'remove') {
            if (entry.state.index < 0 || entry.state.index >= entry.state.history.length) { return; }
            entry.state.history.splice(entry.state.index, 1);
            // Prefer the previous output; deleting the first selects the next.
            entry.state.index = entry.state.history.length ? Math.max(0, entry.state.index - 1) : -1;
        } else {
            const index = entry.state.index + (action === 'back' ? -1 : 1);
            if (index < 0 || index >= entry.state.history.length) { return; }
            entry.state.index = index;
        }
        const pending = this.save(entry);
        await this.render(entry);
        await pending;
    }

    private async render(entry: WidgetViewer, reveal = true): Promise<void> {
        const { extensionPath } = this.context;
        const generation = ++entry.revision;
        entry.loading = true;
        this.updateToolbar();
        const item = entry.state.history[entry.state.index];
        const dir = item ? path.dirname(item.file) : path.join(extensionPath, 'dist/webviews/webview');
        const { panel } = entry;
        try {
            const html = await getWebviewHtml(panel.webview, item?.file, item?.title ?? htmlViewerTitle, dir, Boolean(entry.session), generation, { id: entry.id });
            if (!entry.disposed && entry.revision === generation) {
                panel.webview.options = { ...panel.webview.options, localResourceRoots: [
                    Uri.file(dir), Uri.file(path.join(extensionPath, 'dist/webviews/webview')),
                ] };
                panel.webview.html = html;
                if (reveal) { panel.reveal(panel.viewColumn, true); }
            }
        } finally {
            if (!entry.disposed && entry.revision === generation) {
                entry.loading = false;
                this.updateToolbar();
            }
        }
    }

    private save(entry: WidgetViewer): Promise<void> {
        if (!entry.disposed) { entry.state.viewColumn = entry.panel.viewColumn; }
        return Promise.all([
            entry.saved ? this.histories.save(entry.saved) : Promise.resolve(),
            this.updatePanelState(entry),
        ]).then(() => {});
    }

    dispose(preservePanels = false): void {
        if (this.disposed) { return; }
        this.panels.forEach(entry => { void this.save(entry); });
        this.disposed = true;
        this.serializer.dispose();
        this.panels.forEach(entry => {
            if (preservePanels) { entry.disposed = true; this.releasePanel(entry); }
            else { entry.panel.dispose(); }
        });
        if (!preservePanels) { void this.persistPanelStates(); }
        this.panels.clear();
        this.viewers.clear();
        this.histories.dispose();
        this.updateToolbar();
    }
}

export async function getWebviewHtml(
    webview: Webview, file: string | undefined, title: string, dir: string, sessionOwned = false, generation = 0, state?: HtmlViewerPanelReference,
): Promise<string> {
    const { extensionPath } = getManager().context;
    // Resolve webview URIs before awaiting I/O; the panel may close while loading.
    const baseUri = String(webview.asWebviewUri(Uri.file(dir)));
    const scriptUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/index.js')));
    const styleUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/style.css')));
    let source = '<p>No HTML outputs in this session. New HTML output will appear here.</p>';
    if (file !== undefined) {
        try {
            source = await readFile(file, 'utf8');
        } catch (error) {
            if (!sessionOwned) { throw error; }
            source = `<p role="alert">This HTML widget could not be loaded. Its original file may no longer be available.</p><pre>${escapeHtml(file)}</pre>`;
        }
    }

    // Some R widgets require inline scripts, evaluation, and external resources.
    const CSP = `
        upgrade-insecure-requests;
        default-src https: data: filesystem: ${webview.cspSource};
        style-src https: data: filesystem: 'unsafe-inline' ${webview.cspSource};
        script-src https: data: filesystem: 'unsafe-inline' 'unsafe-eval' ${webview.cspSource};
        worker-src https: data: filesystem: blob:;
        frame-src https: data: blob:;
    `;
    const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><base href="${escapeHtml(baseUri)}/"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${escapeHtml(String(styleUri))}">`;
    // Keep the output's document structure; history controls live in the native title bar.
    let html = /<head\b[^>]*>/i.test(source)
        ? source.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '').replace(/<head\b[^>]*>/i, match => match + head)
        : `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
    const script = `<script src="${escapeHtml(String(scriptUri))}" data-generation="${generation}" data-session-owned="${sessionOwned}" data-viewer-state="${escapeHtml(JSON.stringify(state ?? null))}"></script>`;
    html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, script + '</body>') : html + script;
    return html;
}

function parsePanelState(state: unknown): HtmlViewerPanelState | undefined {
    if (!state || typeof state !== 'object') { return; }
    const value = state as Partial<HtmlViewerPanelState>;
    const source = value.source;
    if (typeof value.id !== 'string' || !value.id || value.version !== 1 || typeof value.showSessionInfo !== 'boolean' ||
        !Array.isArray(value.history) || value.history.length > widgetHistoryLimit ||
        !value.history.every(item => item && typeof item.file === 'string' && typeof item.title === 'string') ||
        !Number.isInteger(value.index) || value.index! < (value.history.length ? 0 : -1) || value.index! >= value.history.length ||
        (source !== undefined && (!source || typeof source.sessionId !== 'string' || !source.sessionId ||
            typeof source.host !== 'string' || typeof source.pid !== 'string' || typeof source.rVer !== 'string' ||
            typeof source.processExited !== 'boolean'))) { return; }
    return value as HtmlViewerPanelState;
}
