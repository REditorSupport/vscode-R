'use strict';

// Data Viewer panels backed by jdv. The webviews are the existing AG Grid and List
// Viewer documents; this module translates their requests to the jdv protocol.
// R connects to a listener owned by the session (see JdvHost) and every view,
// including child views opened from trees, arrives there as a `view/open`.

import * as path from 'path';
import * as vscode from 'vscode';
import { Uri, ViewColumn, window } from 'vscode';
import {
    GridPage, JdvDescriptor, cellOpenParams, JdvRequestError, JdvTracking, JsonObject, TreeAdapter, canRefresh, gridColumnDefs,
    gridPageFromRows, parseDescriptor, parseTracking, revealsPanel, tableRowsParams,
} from './jdvAdapter';
import { SequentialStream } from './jdvArrow';
import { JdvHost, JdvPeer } from './jdvTransport';
import { disposeJdvHostIfCurrentAddress } from './jdvHostLifecycle';
import { extensionContext } from './extension';
import * as session from './session';
import { config, UriIcon } from './util';

interface JdvPanel {
    readonly key: string;
    readonly panel: vscode.WebviewPanel;
    readonly sessionId: string | null;
    /** The R connection that owns the view. */
    peer: JdvPeer;
    descriptor: JdvDescriptor;
    title: string;
    hintScope: string;
    knownTotal?: number;
    tree?: TreeAdapter;
    /** Received Arrow pages of a sequential view. */
    stream?: SequentialStream;
    /** Title for the child view that a pending `object/open` is about to open. */
    childTitle?: string;
    /** Set when R closed or evicted this view generation. */
    closed?: string;
}

const panels = new Map<string, JdvPanel>();
const hosts = new Map<string, Promise<JdvHost>>();
const pendingRowCounts = new Map<string, number>();

function rowCountScope(sessionId: string | null, address: string): string {
    return JSON.stringify([sessionId, address]);
}

/** A display-only hint from the authenticated sess notification channel. */
export function applyJdvRowCount(sessionId: string | null, params: Record<string, unknown>): void {
    if (!sessionId || typeof params.address !== 'string' || !params.address ||
        typeof params.view !== 'string' || !params.view ||
        !Number.isSafeInteger(params.generation) || Number(params.generation) < 1 ||
        !Number.isSafeInteger(params.nrow) || Number(params.nrow) < 0) {
        return;
    }
    const scope = rowCountScope(sessionId, params.address);
    const state = panels.get(panelKey(sessionId, params.view));
    if (state?.stream && !state.closed && state.hintScope === scope &&
        state.descriptor.generation === params.generation) {
        state.knownTotal = Number(params.nrow);
        const webview = state.panel.webview;
        void webview.postMessage({ message: 'dataview/rowCount',
            documentGeneration: session.getDocumentGeneration(webview), knownTotal: state.knownTotal });
    } else {
        pendingRowCounts.set(JSON.stringify([scope, params.view, params.generation]), Number(params.nrow));
        if (pendingRowCounts.size > 64) {
            pendingRowCounts.delete(pendingRowCounts.keys().next().value!);
        }
    }
}

function bindRowCount(state: JdvPanel): void {
    const key = JSON.stringify([state.hintScope, state.descriptor.view, state.descriptor.generation]);
    state.knownTotal = state.stream ? pendingRowCounts.get(key) : undefined;
    pendingRowCounts.delete(key);
}

/** The jdv transport address for a session, creating its listener on first use. */
export function getJdvAddress(sessionId: string, hostKey = sessionId): Promise<string> {
    let host = hosts.get(hostKey);
    if (!host) {
        let address = '';
        host = JdvHost.create({
            viewOpen: (peer, params) => {
                let descriptor: JdvDescriptor;
                try {
                    descriptor = parseDescriptor(params);
                } catch (e) {
                    void window.showErrorMessage(`Unable to open the data viewer: ${errorMessage(e)}`);
                    return;
                }
                const viewer = viewerColumn();
                if (viewer) {
                    void openJdvView(descriptor, sessionId, viewer, peer, rowCountScope(sessionId, address));
                } else {
                    void peer.request('view/close', { view: descriptor.view, generation: descriptor.generation })
                        .catch(() => undefined);
                }
            },
            viewClosed: (_peer, view, generation) => markClosed(sessionId, view, generation),
            viewUpdateFailed: (_peer, params) => warnUpdateFailed(sessionId, params),
            viewTracking: (_peer, params) => applyTracking(sessionId, params),
            disconnected: (peer) => {
                for (const state of panels.values()) {
                    if (state.peer === peer && !state.closed) {
                        state.closed = 'The R session disconnected from the data viewer.';
                    }
                }
            },
        }).then(value => {
            address = value.address;
            return value;
        });
        hosts.set(hostKey, host);
        void host.catch(() => {
            if (hosts.get(hostKey) === host) { hosts.delete(hostKey); }
        });
    }
    return host.then(value => value.address);
}

/** Close the session's jdv listener when the session ends. */
export function disposeJdvHost(hostKey: string): void;
export function disposeJdvHost(hostKey: string, expectedAddress: string): Promise<void>;
export function disposeJdvHost(hostKey: string, expectedAddress?: string): void | Promise<void> {
    if (expectedAddress !== undefined) {
        return disposeJdvHostIfCurrentAddress(hosts, hostKey, expectedAddress,
            host => host.address, host => host.dispose()).then(() => undefined);
    }
    const host = hosts.get(hostKey);
    hosts.delete(hostKey);
    void host?.then(value => value.dispose(), () => undefined);
}

function markClosed(sessionId: string | null, view: string, generation: number): void {
    const state = panels.get(panelKey(sessionId, view));
    if (state && state.descriptor.generation === generation) {
        state.closed = 'This view was closed in R. Run View() again to refresh it.';
    }
}

/** A tracked variable changed but jdv could not rebuild the view; the previous generation stays. */
function warnUpdateFailed(sessionId: string | null, params: JsonObject): void {
    if (typeof params.view !== 'string') {
        return;
    }
    const state = panels.get(panelKey(sessionId, params.view));
    // Ignore a failure reported for a generation that is no longer shown.
    if (!state || state.closed || params.generation !== state.descriptor.generation) {
        return;
    }
    const reason = typeof params.message === 'string' ? params.message : 'unknown error';
    void window.showWarningMessage(`The data viewer could not update "${state.title}": ${reason}`);
}

/**
 * `view/tracking` changes the state of the shown generation without a rebuild.
 * The generation is accepted as is: a pause or loss concerns the view, and a
 * newer generation arrives as a `view/open` that carries its own state.
 */
function applyTracking(sessionId: string | null, params: JsonObject): void {
    const tracking = parseTracking(params.tracking);
    if (typeof params.view !== 'string' || !tracking) {
        return;
    }
    const state = panels.get(panelKey(sessionId, params.view));
    if (!state || !state.descriptor.tracking) {
        return;
    }
    setTracking(state, tracking);
}

function setTracking(state: JdvPanel, tracking: JdvTracking): void {
    state.descriptor.tracking = tracking;
    state.descriptor.capabilities.track = tracking.state !== 'lost';
    // The webview is gone once the panel is disposed.
    try {
        const webview = state.panel.webview;
        void webview.postMessage({
            message: 'viewer/tracking', documentGeneration: session.getDocumentGeneration(webview), tracking,
        });
    } catch {
        // Disposed panel: nothing to update.
    }
}

function createStream(descriptor: JdvDescriptor, peer: JdvPeer): SequentialStream | undefined {
    if (descriptor.access !== 'sequential') {
        return undefined;
    }
    const { view, generation } = descriptor;
    return new SequentialStream(descriptor,
        maxRows => peer.requestWithBody('stream/next', { view, generation, max_rows: maxRows }));
}

function panelKey(sessionId: string | null, view: string): string {
    return JSON.stringify([sessionId, view]);
}

function viewerColumn(): string | undefined {
    const viewer = config().get<Record<string, string>>('session.viewers.viewColumn')?.view ?? 'Two';
    return viewer === 'Disable' ? undefined : viewer;
}

function errorMessage(error: unknown): string {
    if (error instanceof JdvRequestError) {
        return `${error.message} (${error.code})`;
    }
    return error instanceof Error ? error.message : String(error);
}

async function openJdvView(
    descriptor: JdvDescriptor, sessionId: string | null, viewer: string, peer: JdvPeer, hintScope: string,
): Promise<void> {
    const key = panelKey(sessionId, descriptor.view);
    const existing = panels.get(key);
    // jdv titles a child view when its parent has a title; an untitled parent leaves it
    // to the host-side bookkeeping of the item that was opened.
    const parent = descriptor.parent === undefined ? undefined : panels.get(panelKey(sessionId, descriptor.parent));
    const title = descriptor.title ?? parent?.childTitle ?? existing?.title ?? 'View';
    if (descriptor.kind === 'grid' && descriptor.access !== 'random' && descriptor.access !== 'sequential') {
        // Snapshot grids are not supported; release the view.
        void peer.request('view/close', { view: descriptor.view, generation: descriptor.generation }).catch(() => undefined);
        void window.showWarningMessage(`The data viewer cannot display "${title}" yet (${descriptor.access} view).`);
        return;
    }
    if (existing) {
        if (existing.hintScope === hintScope && descriptor.generation < existing.descriptor.generation) {
            return;
        }
        // The same view with a newer generation (View() again, or a refresh) updates the panel.
        existing.descriptor = descriptor;
        existing.peer = peer;
        existing.title = title;
        existing.closed = undefined;
        existing.tree = descriptor.kind === 'tree' ? new TreeAdapter(descriptor, title) : undefined;
        existing.stream?.dispose();
        existing.stream = createStream(descriptor, peer);
        existing.hintScope = hintScope;
        bindRowCount(existing);
        existing.panel.title = title;
        // Updates that R made on its own (a tracked variable, a Refresh click) keep
        // the panel where it is. Otherwise, including when jdv sends no reason,
        // reveal without taking focus so that an explicit View() surfaces the panel.
        if (revealsPanel(descriptor)) {
            existing.panel.reveal(existing.panel.viewColumn, true);
        }
        existing.panel.webview.html = await renderPanel(existing);
        return;
    }

    const resDir = path.join(extensionContext.extensionPath, 'dist', 'resources');
    const panel = window.createWebviewPanel('dataview', title,
        {
            preserveFocus: true,
            viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
        },
        {
            enableScripts: true,
            enableFindWidget: true,
            retainContextWhenHidden: true,
            localResourceRoots: [Uri.file(resDir)],
        });
    panel.iconPath = new UriIcon(descriptor.kind === 'grid' ? 'open-preview' : 'preview');
    session.attachViewerSessionBridge(panel, sessionId);
    const state: JdvPanel = {
        key, panel, sessionId, peer, descriptor, title, hintScope,
        tree: descriptor.kind === 'tree' ? new TreeAdapter(descriptor, title) : undefined,
        stream: createStream(descriptor, peer),
    };
    panels.set(key, state);
    bindRowCount(state);
    // The panel's webview getter throws once onDidDispose fires.
    const webview = panel.webview;
    panel.onDidDispose(() => {
        if (panels.get(key) === state) {
            panels.delete(key);
        }
        state.stream?.dispose();
        if (!state.closed) {
            const { view, generation } = state.descriptor;
            void state.peer.request('view/close', { view, generation }).catch(() => undefined);
        }
    });
    webview.onDidReceiveMessage((message: unknown) => {
        void handleMessage(state, webview, message as JsonObject);
    });
    webview.html = await renderPanel(state);
}

async function renderPanel(state: JdvPanel): Promise<string> {
    const webview = state.panel.webview;
    const refreshable = canRefresh(state.descriptor);
    const tracking = state.descriptor.tracking;
    if (state.descriptor.kind === 'grid') {
        return session.getTableHtml(webview, undefined, state.title, state.sessionId, refreshable, tracking);
    }
    return session.getListHtml(webview, state.title, state.tree!.navigation([]), state.sessionId, refreshable, tracking);
}

function isPositivePath(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(index => Number.isSafeInteger(index) && index > 0);
}

async function handleMessage(state: JdvPanel, webview: vscode.Webview, message: JsonObject): Promise<void> {
    const documentGeneration = message.documentGeneration;
    if (typeof documentGeneration !== 'number' || documentGeneration !== session.getDocumentGeneration(webview)) {
        return;
    }
    const current = () => documentGeneration === session.getDocumentGeneration(webview);
    if (message.message === 'dataview/refresh' || message.message === 'listview/refresh') {
        await refreshView(state, webview, documentGeneration);
        return;
    }
    if (message.message === 'dataview/openCell') {
        await openCell(state, webview, documentGeneration, message);
        return;
    }
    if (message.message === 'viewer/track' && typeof message.enabled === 'boolean') {
        await trackView(state, webview, documentGeneration, message.enabled);
        return;
    }
    if (message.message === 'dataview/request' && typeof message.requestId === 'number') {
        const reply = (ok: boolean, result?: unknown, error?: string) => {
            if (current()) {
                void webview.postMessage({
                    message: 'dataview/response', documentGeneration, requestId: message.requestId, ok, result, error,
                });
            }
        };
        try {
            if (state.stream) {
                // Rows already received stay viewable after R closes the view.
                if (message.action === 'init') {
                    reply(true, { columns: gridColumnDefs(state.descriptor), totalRows: 0, sequential: true, knownTotal: state.knownTotal });
                } else if (message.action === 'page') {
                    reply(true, await fetchSequentialPage(state, state.stream, message));
                }
                return;
            }
            if (state.closed) {
                throw new Error(state.closed);
            }
            if (message.action === 'init') {
                reply(true, { columns: gridColumnDefs(state.descriptor), totalRows: state.descriptor.nrow ?? 0 });
            } else if (message.action === 'page') {
                reply(true, await fetchGridPage(state, message));
            } else {
                reply(false, undefined, `Unsupported dataview action: ${String(message.action)}`);
            }
        } catch (e) {
            reply(false, undefined, errorMessage(e));
        }
        return;
    }

    const tree = state.tree;
    if (!tree || !isPositivePath(message.path)) {
        return;
    }
    const treePath = message.path;
    if (message.message === 'listview/navigate' || message.message === 'listview/view') {
        let navigation;
        let error: string | undefined;
        try {
            if (state.closed) {
                throw new Error(state.closed);
            }
            if (message.message === 'listview/navigate') {
                navigation = tree.navigation(treePath);
            } else if (Number.isSafeInteger(message.index)) {
                const action = tree.open(treePath, message.index as number);
                if (action.kind === 'navigate') {
                    navigation = action.navigation;
                } else {
                    // The child arrives as a `view/open` notification before the response.
                    state.childTitle = action.title;
                    try {
                        await state.peer.request('object/open', action.params);
                    } finally {
                        state.childTitle = undefined;
                    }
                }
            }
        } catch (e) {
            error = `Unable to open this item: ${errorMessage(e)}`;
        }
        if (navigation) {
            state.panel.title = navigation.title;
        }
        if (current()) {
            void webview.postMessage({
                message: 'listview/navigation', documentGeneration, requestId: message.requestId, navigation, error,
            });
        }
    } else if (message.message === 'listview/page' && Number.isSafeInteger(message.start) &&
        typeof message.requestId === 'number') {
        let page;
        let error: string | undefined;
        try {
            if (state.closed) {
                throw new Error(state.closed);
            }
            const result = await state.peer.request('object/children', tree.childrenParams(treePath, message.start as number));
            page = tree.children(treePath, result);
        } catch (e) {
            error = `Unable to load items: ${errorMessage(e)}`;
        }
        if (current()) {
            void webview.postMessage({
                message: 'listview/page', documentGeneration, requestId: message.requestId, ...page, error,
            });
        }
    }
}

/**
 * Open a drillable grid cell as a child view. The child arrives as a `view/open`
 * notification (with jdv's title) before the response, so only a failure is reported.
 */
async function openCell(
    state: JdvPanel, webview: vscode.Webview, documentGeneration: number, message: JsonObject,
): Promise<void> {
    let error: string | undefined;
    try {
        if (state.closed) {
            throw new Error(state.closed);
        }
        await state.peer.request('object/open', cellOpenParams(state.descriptor, message.sourceRow, message.column));
    } catch (e) {
        error = `Unable to open this cell: ${errorMessage(e)}`;
    }
    if (error !== undefined && documentGeneration === session.getDocumentGeneration(webview)) {
        void webview.postMessage({ message: 'viewer/openFailed', documentGeneration, error });
    }
}

/**
 * Ask R to rebuild the view. On success the next generation arrives as a `view/open`
 * that re-renders the panel, so only a failure is reported to the webview.
 */
async function refreshView(state: JdvPanel, webview: vscode.Webview, documentGeneration: number): Promise<void> {
    const { view, generation } = state.descriptor;
    let error: string | undefined;
    try {
        if (state.closed) {
            throw new Error(state.closed);
        }
        if (!canRefresh(state.descriptor)) {
            throw new Error('This view cannot be refreshed.');
        }
        await state.peer.request('view/refresh', { view, generation });
    } catch (e) {
        error = `Unable to refresh: ${errorMessage(e)}`;
    }
    if (error !== undefined && documentGeneration === session.getDocumentGeneration(webview)) {
        void webview.postMessage({ message: 'viewer/refreshFailed', documentGeneration, error });
    }
}

/**
 * Ask R to pause or resume following the variable. Resuming may rebuild the view,
 * in which case the new generation arrives as a `view/open` that re-renders the panel;
 * otherwise the toggle is updated from the result.
 */
async function trackView(
    state: JdvPanel, webview: vscode.Webview, documentGeneration: number, enabled: boolean,
): Promise<void> {
    const { view, generation } = state.descriptor;
    let error: string | undefined;
    try {
        if (state.closed) {
            throw new Error(state.closed);
        }
        if (!state.descriptor.tracking) {
            throw new Error('This view does not follow a variable.');
        }
        const result = await state.peer.request('view/track', { view, generation, enabled });
        const tracking = parseTracking((result as JsonObject | undefined)?.tracking);
        // A rebuilt view was already applied by its `view/open`.
        if (tracking && state.descriptor.tracking && (result as JsonObject).generation === state.descriptor.generation) {
            setTracking(state, tracking);
        }
    } catch (e) {
        error = `Unable to ${enabled ? 'follow' : 'pause following'} the variable: ${errorMessage(e)}`;
    }
    if (error !== undefined && documentGeneration === session.getDocumentGeneration(webview)) {
        void webview.postMessage({ message: 'viewer/trackFailed', documentGeneration, error });
    }
}

/** Fetch one AG Grid block, issuing further pages if jdv clamps the page size. */
async function fetchGridPage(state: JdvPanel, message: JsonObject): Promise<Omit<GridPage, 'returned'>> {
    const startRow = Number(message.startRow ?? 0);
    const endRow = Number(message.endRow ?? 0);
    const descriptor = state.descriptor;
    let page: GridPage | undefined;
    let offset = startRow;
    while (offset < endRow) {
        const params = tableRowsParams(descriptor, offset, endRow, message.sortModel, message.filterModel);
        const next = gridPageFromRows(await state.peer.request('grid/rows', params), offset, params.limit);
        page = page ? { ...next, rows: [...page.rows, ...next.rows] } : next;
        offset += next.returned;
        if (next.returned === 0 || offset >= next.totalRows) {
            break;
        }
    }
    if (!page) {
        throw new JdvRequestError('invalid_request', 'Empty page request');
    }
    return { rows: page.rows, totalRows: page.totalRows, totalUnfiltered: page.totalUnfiltered, lastRow: page.totalRows };
}

/** Serve an AG Grid block from received Arrow pages, reading the stream forward as needed. */
async function fetchSequentialPage(
    state: JdvPanel, stream: SequentialStream, message: JsonObject,
): Promise<JsonObject> {
    const startRow = Math.max(0, Number(message.startRow ?? 0));
    const endRow = Math.max(startRow, Number(message.endRow ?? 0));
    if (!state.closed) {
        await stream.ensure(endRow);
    }
    // After the stream ends, or once R has closed the view, the received rows are final.
    const known = stream.done || state.closed !== undefined;
    return {
        rows: stream.rows(startRow, endRow),
        totalRows: known ? stream.rowsSeen : null,
        totalUnfiltered: known ? stream.rowsSeen : null,
        lastRow: known ? stream.rowsSeen : -1,
        loadedRows: stream.rowsSeen,
        knownTotal: state.knownTotal,
        done: stream.done,
        unavailableBefore: stream.unavailableBefore,
        notice: state.closed,
    };
}
