'use strict';

// Data Viewer panels backed by jdv. The webviews are the existing AG Grid and List
// Viewer documents; this module translates their requests to the jdv protocol.

import * as path from 'path';
import * as vscode from 'vscode';
import { Uri, ViewColumn, window } from 'vscode';
import {
    GridPage, JdvChannel, JdvDescriptor, JdvRequestError, JsonObject, TreeAdapter, gridColumnDefs,
    gridPageFromRows, parseClosedNotifications, parseDescriptor, tableRowsParams, unwrapResponse,
} from './jdvAdapter';
import { SequentialStream } from './jdvArrow';
import { JdvHost, JdvPeer } from './jdvTransport';
import { extensionContext } from './extension';
import * as session from './session';
import { config, UriIcon } from './util';

interface JdvPanel {
    readonly key: string;
    readonly panel: vscode.WebviewPanel;
    readonly sessionId: string | null;
    /** A title can move between the sess relay and the jdv transport. */
    channel: JdvChannel;
    descriptor: JdvDescriptor;
    title: string;
    tree?: TreeAdapter;
    /** Received Arrow pages of a sequential view. */
    stream?: SequentialStream;
    /** Set when R closed or evicted this view generation. */
    closed?: string;
}

const panels = new Map<string, JdvPanel>();
const hosts = new Map<string, Promise<JdvHost>>();
let requestSequence = 0;

/**
 * The jdv transport address for a session, creating its listener on first use.
 * Sequential Arrow views need this transport; `jdv_rpc()` cannot carry Arrow IPC.
 */
export function getJdvAddress(sessionId: string, pid: number | undefined): Promise<string> {
    let host = hosts.get(sessionId);
    if (!host) {
        host = JdvHost.create(pid, {
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
                    void openJdvView(descriptor, descriptor.title ?? 'View', sessionId, viewer, peer);
                } else {
                    void peer.request('view/close', { view: descriptor.view, generation: descriptor.generation })
                        .catch(() => undefined);
                }
            },
            viewClosed: (_peer, view, generation) => markClosed(sessionId, view, generation),
            disconnected: (peer) => {
                for (const state of panels.values()) {
                    if (state.channel === peer && !state.closed) {
                        state.closed = 'The R session disconnected from the data viewer.';
                    }
                }
            },
        });
        hosts.set(sessionId, host);
        host.catch(() => hosts.delete(sessionId));
    }
    return host.then(value => value.address);
}

/** Close the session's jdv listener when the session ends. */
export function disposeJdvHost(sessionId: string): void {
    const host = hosts.get(sessionId);
    hosts.delete(sessionId);
    void host?.then(value => value.dispose(), () => undefined);
}

function markClosed(sessionId: string | null, view: string, generation: number): void {
    const state = panels.get(panelKey(sessionId, view));
    if (state && state.descriptor.generation === generation) {
        state.closed = 'This view was closed in R. Run View() again to refresh it.';
    }
}

function createStream(descriptor: JdvDescriptor, channel: JdvChannel): SequentialStream | undefined {
    if (descriptor.access !== 'sequential' || !(channel instanceof JdvPeer)) {
        return undefined;
    }
    const { view, generation } = descriptor;
    return new SequentialStream(descriptor,
        maxRows => channel.requestWithBody('stream/next', { view, generation, max_rows: maxRows }));
}

/** Sends jdv requests through the session's existing sess RPC connection. */
function sessChannel(sessionId: string | null): JdvChannel {
    return {
        async request(method: string, params: JsonObject): Promise<unknown> {
            const request = JSON.stringify({ id: `vscode-r-${++requestSequence}`, method, params });
            const response = await session.sessionRequest({ method: 'jdv_rpc', params: { request } }, sessionId);
            if (typeof response !== 'string') {
                throw new Error('No response from the R session');
            }
            return unwrapResponse(response);
        },
    };
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

/** Handle a sess `dataview` notification whose source is `jdv`. */
export async function showJdvNotification(params: Record<string, unknown>, sessionId: string | null): Promise<void> {
    let descriptor: JdvDescriptor;
    try {
        descriptor = parseDescriptor(params.open);
    } catch (e) {
        void window.showErrorMessage(`Unable to open the data viewer: ${errorMessage(e)}`);
        return;
    }
    // Notifications precede the view they belong to; see jdv_register().
    for (const closed of parseClosedNotifications(params.notifications)) {
        markClosed(sessionId, closed.view, closed.generation);
    }
    const title = typeof params.title === 'string' ? params.title
        : Array.isArray(params.title) ? params.title.map(String).join(',') : descriptor.title ?? 'View';
    const viewer = viewerColumn();
    if (viewer) {
        await openJdvView(descriptor, title, sessionId, viewer, sessChannel(sessionId));
    }
}

async function openJdvView(
    descriptor: JdvDescriptor, title: string, sessionId: string | null, viewer: string, channel: JdvChannel,
): Promise<void> {
    const sequential = descriptor.access === 'sequential' && channel instanceof JdvPeer;
    if (descriptor.kind === 'grid' && descriptor.access !== 'random' && !sequential) {
        // Snapshot grids, and sequential grids without the jdv transport, are not supported; release the view.
        void channel.request('view/close', { view: descriptor.view, generation: descriptor.generation }).catch(() => undefined);
        void window.showWarningMessage(`The data viewer cannot display "${title}" yet (${descriptor.access} view).`);
        return;
    }
    const key = panelKey(sessionId, descriptor.view);
    const existing = panels.get(key);
    if (existing) {
        if (descriptor.generation < existing.descriptor.generation) {
            return;
        }
        existing.descriptor = descriptor;
        existing.channel = channel;
        existing.title = title;
        existing.closed = undefined;
        existing.tree = descriptor.kind === 'tree' ? new TreeAdapter(descriptor, title) : undefined;
        existing.stream?.dispose();
        existing.stream = createStream(descriptor, existing.channel);
        existing.panel.title = title;
        existing.panel.reveal(existing.panel.viewColumn, true);
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
        key, panel, sessionId, channel, descriptor, title,
        tree: descriptor.kind === 'tree' ? new TreeAdapter(descriptor, title) : undefined,
        stream: createStream(descriptor, channel),
    };
    panels.set(key, state);
    // The panel's webview getter throws once onDidDispose fires.
    const webview = panel.webview;
    panel.onDidDispose(() => {
        if (panels.get(key) === state) {
            panels.delete(key);
        }
        state.stream?.dispose();
        if (!state.closed) {
            const { view, generation } = state.descriptor;
            void state.channel.request('view/close', { view, generation }).catch(() => undefined);
        }
    });
    webview.onDidReceiveMessage((message: unknown) => {
        void handleMessage(state, webview, message as JsonObject);
    });
    webview.html = await renderPanel(state);
}

async function renderPanel(state: JdvPanel): Promise<string> {
    const webview = state.panel.webview;
    if (state.descriptor.kind === 'grid') {
        return session.getTableHtml(webview, undefined, state.title, state.sessionId);
    }
    return session.getListHtml(webview, state.title, state.tree!.navigation([]), state.sessionId);
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
                    reply(true, { columns: gridColumnDefs(state.descriptor), totalRows: 0, sequential: true });
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
                    const child = parseDescriptor(await state.channel.request('object/open', action.params));
                    const viewer = viewerColumn();
                    if (viewer) {
                        await openJdvView(child, action.title, state.sessionId, viewer, state.channel);
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
            const result = await state.channel.request('object/children', tree.childrenParams(treePath, message.start as number));
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

/** Fetch one AG Grid block, issuing further pages if jdv clamps the page size. */
async function fetchGridPage(state: JdvPanel, message: JsonObject): Promise<Omit<GridPage, 'returned'>> {
    const startRow = Number(message.startRow ?? 0);
    const endRow = Number(message.endRow ?? 0);
    const descriptor = state.descriptor;
    let page: GridPage | undefined;
    let offset = startRow;
    while (offset < endRow) {
        const params = tableRowsParams(descriptor, offset, endRow, message.sortModel, message.filterModel);
        const next = gridPageFromRows(await state.channel.request('table/rows', params), offset, params.limit);
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
        done: stream.done,
        unavailableBefore: stream.unavailableBefore,
        notice: state.closed,
    };
}
