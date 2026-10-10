'use strict';

import * as path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { readFile } from 'fs/promises';
import { load } from 'cheerio';
import { Disposable, ExtensionContext, ProgressLocation, Uri, ViewColumn, Webview, WebviewPanel, window, env, commands, workspace } from 'vscode';
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
    finishLoading?: () => void;
    showSessionInfo: boolean;
    subscriptions: Array<{ dispose(): void }>;
    resourceRoots: Map<string, Uri[]>;
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
            id, panel, revision: 0, disposed: false, loading: false, showSessionInfo, session, saved, subscriptions: [], resourceRoots: new Map(),
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
            } else if (msg.message === 'widget/loaded' && msg.generation === entry.revision) {
                entry.finishLoading?.();
                this.updateToolbar();
            } else if (msg.message === 'widget/find' && msg.generation === entry.revision) {
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
        entry.finishLoading?.();
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

    private startLoading(entry: WidgetViewer, generation: number): void {
        entry.finishLoading?.();
        entry.loading = true;
        void window.withProgress({ location: ProgressLocation.Window }, progress => new Promise<void>(resolve => {
            progress.report({ message: 'HTML Viewer: Loading HTML output…' });
            // Run in the extension host: the output's CSP may block our script,
            // or a resource may prevent the window load event from completing.
            const timeout = setTimeout(() => {
                if (entry.disposed || entry.revision !== generation) { return; }
                entry.loading = false;
                progress.report({ message: 'HTML Viewer: Still loading. Navigation is available.' });
                this.updateToolbar();
            }, 5000);
            entry.finishLoading = () => {
                clearTimeout(timeout);
                entry.loading = false;
                entry.finishLoading = undefined;
                resolve();
            };
        }));
        this.updateToolbar();
    }

    private async render(entry: WidgetViewer, reveal = true): Promise<void> {
        const { extensionPath } = this.context;
        const generation = ++entry.revision;
        this.startLoading(entry, generation);
        const item = entry.state.history[entry.state.index];
        const dir = item ? path.dirname(item.file) : path.join(extensionPath, 'dist/webviews/webview');
        const { panel } = entry;
        try {
            const { html, localResourceRoots, failed } = await getWebviewHtml(panel.webview, item?.file, dir, Boolean(entry.session), generation, { id: entry.id });
            if (!entry.disposed && entry.revision === generation) {
                if (item) { entry.resourceRoots.set(item.file, localResourceRoots); }
                const files = new Set(entry.state.history.map(output => output.file));
                for (const file of entry.resourceRoots.keys()) {
                    if (!files.has(file)) { entry.resourceRoots.delete(file); }
                }
                // Keep permissions stable while browsing already rendered outputs.
                // Recheck authored bases against current workspace trust, and forget
                // directories when their output leaves this viewer's bounded history.
                const assetRoot = Uri.file(path.join(extensionPath, 'dist/webviews/webview')).toString();
                const roots = entry.state.history.flatMap(output => (entry.resourceRoots.get(output.file) ?? [])
                    .filter(root => root.toString() === assetRoot || isAllowedResourceRoot(root, path.dirname(output.file))));
                const resourceRoots = [...new Map((roots.length ? roots : localResourceRoots).map(root => [root.toString(), root])).values()];
                const previousRoots = panel.webview.options.localResourceRoots;
                if (!previousRoots || previousRoots.length !== resourceRoots.length ||
                    previousRoots.some((root, index) => root.toString() !== resourceRoots[index].toString())) {
                    // Changing resource roots reloads the current HTML in VS Code.
                    // Clear only for permission changes, never ordinary Back/Forward.
                    panel.webview.html = '';
                    panel.webview.options = { ...panel.webview.options, localResourceRoots: resourceRoots };
                }
                panel.webview.html = html;
                if (failed) {
                    entry.finishLoading?.();
                    this.updateToolbar();
                }
                if (reveal) { panel.reveal(panel.viewColumn, true); }
            }
        } catch (error) {
            if (!entry.disposed && entry.revision === generation) {
                entry.finishLoading?.();
                this.updateToolbar();
            }
            throw error;
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

async function getWebviewHtml(
    webview: Webview, file: string | undefined, dir: string, sessionOwned = false, generation = 0, state?: HtmlViewerPanelReference,
): Promise<{ html: string; localResourceRoots: Uri[]; failed: boolean }> {
    const { extensionPath } = getManager().context;
    // Resolve webview URIs before awaiting I/O; the panel may close while loading.
    const baseUri = String(webview.asWebviewUri(Uri.file(dir)));
    const scriptUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/index.js')));
    const styleUri = webview.asWebviewUri(Uri.file(path.join(extensionPath, 'dist/webviews/webview/style.css')));
    const localResourceRoots = [Uri.file(dir), Uri.file(path.join(extensionPath, 'dist/webviews/webview'))];
    let source = '<p>No HTML outputs in this session. New HTML output will appear here.</p>';
    let failed = false;
    if (file !== undefined) {
        try {
            source = await readFile(file, 'utf8');
        } catch (error) {
            if (!sessionOwned) { throw error; }
            failed = true;
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
    const script = `<script src="${escapeHtml(String(scriptUri))}" data-generation="${generation}" data-session-owned="${sessionOwned}" data-viewer-state="${escapeHtml(JSON.stringify(state ?? null))}"></script>`;

    // Parse only to locate real document boundaries, then splice the original
    // source without reserializing it or changing authored titles and scripts.
    const document = load(source, { sourceCodeLocationInfo: true });
    const htmlLocation = document('html')[0]?.sourceCodeLocation;
    const headLocation = document('html > head')[0]?.sourceCodeLocation;
    const bodyLocation = document('html > body')[0]?.sourceCodeLocation;
    const headOffset = headLocation?.startTag?.endOffset ?? htmlLocation?.startTag?.endOffset ??
        document.root()[0].children.find(node => node.type === 'directive')?.sourceCodeLocation?.endOffset ?? 0;
    const bodyOffset = bodyLocation?.endTag?.startOffset ?? htmlLocation?.endTag?.startOffset ?? source.length;
    const base = document('base[href]').toArray().find(element => {
        if (element.namespace !== 'http://www.w3.org/1999/xhtml') { return false; }
        // Template contents live in a separate document fragment, so their
        // bases do not participate in the output's document base URL.
        for (let parent = element.parent; parent; parent = parent.parent) {
            if (parent.type === 'tag' && parent.name === 'template') { return false; }
        }
        return true;
    });
    const edits = [{ start: bodyOffset, end: bodyOffset, text: script }];
    if (base) {
        const fileUrl = pathToFileURL(file ?? path.join(dir, 'index.html'));
        let resolvedBase: URL;
        try {
            resolvedBase = new URL(base.attribs.href, fileUrl);
        } catch {
            resolvedBase = fileUrl;
        }
        // Invalid, data:, and javascript: bases fall back to the original file.
        if (resolvedBase.protocol === 'data:' || resolvedBase.protocol === 'javascript:') { resolvedBase = fileUrl; }
        const hrefLocation = (base.sourceCodeLocation as {
            attrs?: Record<string, { startOffset: number; endOffset: number }>;
        } | undefined)?.attrs?.href;
        if (resolvedBase.protocol === 'file:' && hrefLocation) {
            const localBase = Uri.parse(resolvedBase.href);
            const resourceRoot = Uri.joinPath(localBase, localBase.path.endsWith('/') ? '.' : '..').with({ query: '', fragment: '' });
            // Authored HTML may select a base URL, but cannot grant itself access
            // outside the output directory or an independently trusted workspace.
            if (isAllowedResourceRoot(resourceRoot, dir)) {
                localResourceRoots.push(resourceRoot);
            }
            edits.push({ start: hrefLocation.startOffset, end: hrefLocation.endOffset,
                text: `href="${escapeHtml(String(webview.asWebviewUri(localBase)))}"` });
        }
    }
    const baseTag = base ? '' : `<base href="${escapeHtml(baseUri)}/">`;
    const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}">${baseTag}<link rel="stylesheet" href="${escapeHtml(String(styleUri))}">`;
    const headInsertion = headLocation?.startTag ? head : `<head>${head}</head>`;
    edits.push({ start: headOffset, end: headOffset, text: headInsertion });
    let html = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
    }
    return { html, localResourceRoots, failed };
}

function isAllowedResourceRoot(resourceRoot: Uri, dir: string): boolean {
    const trustedRoots = [Uri.file(dir), ...(workspace.isTrusted ? workspace.workspaceFolders?.map(folder => folder.uri) ?? [] : [])];
    return trustedRoots.some(root => {
        if (root.scheme !== 'file' || root.authority !== resourceRoot.authority) { return false; }
        const relative = path.relative(root.fsPath, resourceRoot.fsPath);
        return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    });
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
