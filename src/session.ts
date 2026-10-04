'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { commands, Uri, ViewColumn, Webview, window, env } from 'vscode';

import { restartRTerminal } from './rTerminal';
import { config, readContent, setContext, UriIcon } from './util';
import * as rTerminal from './rTerminal';
import { purgeAddinPickerItems, RSEditOperation, RSRange } from './rstudioapi';

import { extensionContext, rWorkspace, globalRHelp, globalPlotManager, sessionStatusBarItem, enableSessionWatcher } from './extension';
import { resolveBackend, jgdEnabled, CommonPlotManager } from './plotViewer';
import type { RSessionConnectionInfo } from './api';

import { showWebView } from './webViewer';
import { getListViewerScript, ListViewNavigation } from './listViewer';
import { getDataViewerScript, getDataViewerStyle, getDataViewerToolbarHtml } from './dataViewer';
import { getDataViewerColumnPanelHtml, getDataViewerColumnPanelScript, getDataViewerColumnPanelStyle } from './dataViewerColumnPanel';

export interface SessionInfo {
    version: string;
    command: string;
    start_time: string;
}

export interface GlobalEnv {
    [key: string]: {
        class: string[] | string;
        type: string;
        length: number;
        str: string;
        dim?: number[],
        names?: string[],
        slots?: string[],
        has_children?: boolean
    }
}

export interface WorkspaceData {
    search: string[];
    loaded_namespaces: string[];
    globalenv: GlobalEnv;
}

// Thin adapter to track per-socket metadata alongside net.Socket
interface IpcSocket extends net.Socket {
    _terminalPid?: number;
    _pipePath?: string;
    _sessionId?: string;
}

export class Session {
    public label?: string;
    public workspaceUnavailable?: string;
    public execute?: (code: string) => Promise<void>;
    public rPath?: string;
    public libraryPaths?: string[];
    public requester?: (data: Record<string, unknown>) => Promise<unknown>;
    public sessionId: string;
    public host: string;
    public sessVersion: string;
    public pipePath: string;
    public socket: IpcSocket;
    public pid: string;
    public rVer: string;
    public info: SessionInfo;
    public sessionDir: string;
    public workingDir: string;
    public workspaceData: WorkspaceData;

    constructor(sessionId: string, host: string, sessVersion: string, pipePath: string, socket: IpcSocket) {
        this.sessionId = sessionId;
        this.host = host;
        this.sessVersion = sessVersion;
        this.pipePath = pipePath;
        this.socket = socket;
        this.pid = '';
        this.rVer = '';
        this.info = { version: '', command: '', start_time: '' };
        this.sessionDir = '';
        this.workingDir = '';
        this.workspaceData = { search: [], loaded_namespaces: [], globalenv: {} };
    }
}

export let workspaceData: WorkspaceData;
let resDir: string;
export let requestFile: string;
export let requestLockFile: string;
export let sessionDir: string;
export let workingDir: string;
let rVer: string;
let pid: string;
let info: SessionInfo;
export let globalPipePath: string | undefined;
export let workspaceFile: string;

const SESS_PROTOCOL_VERSION = 1;

const sessions = new Map<string, Session>();
const documentSessions = new Map<string, Session>();
const sessionDocumentBound = new vscode.EventEmitter<Uri>();
export const onDidBindSessionDocument = sessionDocumentBound.event;

export function sessionForDocument(uri: Uri): Session | undefined {
    return boundSessionForDocument(uri) ?? activeSession;
}

export function boundSessionForDocument(uri: Uri): Session | undefined {
    return documentSessions.get(uri.toString()) ?? (uri.scheme === 'vscode-notebook-cell'
        ? documentSessions.get(Uri.from({ scheme: uri.scheme, path: uri.path }).toString()) : undefined);
}

export function bindSessionDocument(uri: Uri, session: Session): void {
    const previous = boundSessionForDocument(uri);
    documentSessions.set(uri.toString(), session);
    if (previous !== session) { sessionDocumentBound.fire(uri); }
}

export function unbindSessionDocument(uri: Uri): void { documentSessions.delete(uri.toString()); }

export function unregisterSessionTransport(target: Session): void {
    for (const [uri, owner] of documentSessions) { if (owner === target) { documentSessions.delete(uri); } }
    sessions.delete(target.sessionId);
    if (activeSession === target) { void clearActiveSession(); }
}

function clearActiveSession(): Promise<void> {
    deferWorkspaceRefresh();
    workspaceRefreshPending = false;
    activeSession = undefined;
    workspaceData = { search: [], loaded_namespaces: [], globalenv: {} };
    workingDir = '';
    resetStatusBar();
    rWorkspace?.refresh();
    return setContext('rSessionActive', false);
}

/** Workspace actions must use the process represented by the tree, even after focus changes. */
export async function executeSessionCode(target: Session, code: string): Promise<void> {
    if (sessions.get(target.sessionId) !== target || target.workspaceUnavailable) {
        throw new Error(target.workspaceUnavailable ?? 'This R session is no longer attached. Select an attached session in the Workspace viewer.');
    }
    if (target.execute) { await target.execute(code); return; }
    for (const terminal of window.terminals) {
        const terminalPid = await terminal.processId;
        if (terminalPid && terminalSessions.get(String(terminalPid)) === target) {
            await rTerminal.runTextInTerminal(terminal, code);
            return;
        }
    }
    throw new Error('This R session has no attached terminal. Attach its terminal or open it in an Interactive window.');
}

export function updateSessionWorkspace(target: Session, data: WorkspaceData): void {
    target.workspaceData = data;
    if (activeSession === target) {
        void refreshActiveSession(target);
    }
}

/** Move document routing to a new process; existing data viewers keep their old owner. */
export function replaceSessionTransport(previous: Session, next: Session): void {
    for (const [uri, owner] of documentSessions) { if (owner === previous) { documentSessions.set(uri, next); } }
    sessions.delete(previous.sessionId);
    if (activeSession === previous) { activeSession = next; }
}

export function registerSessionTransport(id: string, host: string, directory: string,
    requester: (data: Record<string, unknown>) => Promise<unknown>): Session {
    const target = sessions.get(id) ?? new Session(id, host, '', '', new net.Socket());
    target.requester = requester;
    target.workingDir = directory;
    sessions.set(id, target);
    return target;
}
const terminalSessions = new Map<string, Session>();
export let activeSession: Session | undefined;
let activeBrowserUri: Uri | undefined;
let workspaceRefreshTimer: NodeJS.Timeout | undefined;
let workspaceRefreshInProgress = false;
let workspaceRefreshPending = false;

interface DataViewColumnDef {
    headerName: string;
    headerTooltip?: string;
    field: string;
    type: string;
    filter?: string | boolean;
    sortable?: boolean;
    cellDataType?: string;
    suppressHeaderMenuButton?: boolean;
}

interface DataViewInitResult {
    columns: DataViewColumnDef[];
    totalRows: number;
}

interface DataViewPageResult {
    rows: Record<string, unknown>[];
    totalRows: number;
    totalUnfiltered: number;
    lastRow: number;
}

interface DataViewRequestMessage {
    message: 'dataview/request';
    action: 'init' | 'page';
    requestId: number;
    startRow?: number;
    endRow?: number;
    sortModel?: unknown[];
    filterModel?: Record<string, unknown>;
}

const dynamicDataViewPanels = new Map<string, vscode.WebviewPanel>();
const dynamicDataViewInstances = new WeakMap<vscode.WebviewPanel, number>();
const listViewGenerations = new WeakMap<Webview, number>();
let dynamicDataViewReloadRevision = 0;

function escapeHtml(text: string): string {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    };
    return text.replace(/[&<>"']/g, c => map[c]);
}

function registerDataViewPanel(
    panel: vscode.WebviewPanel, key: string, viewId: string, sessionId: string | null,
    instance?: number,
): void {
    // The panel's webview getter throws once onDidDispose fires.
    const webview = panel.webview;
    dynamicDataViewPanels.set(key, panel);
    if (instance !== undefined) {
        dynamicDataViewInstances.set(panel, instance);
    }
    panel.onDidDispose(() => {
        listViewGenerations.delete(webview);
        const currentInstance = dynamicDataViewInstances.get(panel);
        dynamicDataViewInstances.delete(panel);
        if (dynamicDataViewPanels.get(key) !== panel) {
            return;
        }
        dynamicDataViewPanels.delete(key);
        // Interactive transcripts retain this handle after the expanded viewer closes.
        if (sessions.get(sessionId ?? '')?.requester) { return; }
        void sessionRequest({
            method: 'dataview_dispose',
            params: { view_id: viewId, instance: currentInstance },
        }, sessionId);
    });
}

function attachDynamicDataViewBridge(panel: vscode.WebviewPanel, viewId: string, sessionId: string | null): void {
    const webview = panel.webview;
    const postResponse = (requestId: number, ok: boolean, result?: unknown, error?: string) => {
        void webview.postMessage({
            message: 'dataview/response',
            requestId,
            ok,
            result,
            error,
        });
    };

    webview.onDidReceiveMessage(async (raw: unknown) => {
        const msg = raw as Partial<DataViewRequestMessage>;
        if (msg.message !== 'dataview/request' || typeof msg.requestId !== 'number') {
            return;
        }

        try {
            if (msg.action === 'init') {
                const result = await sessionRequest({
                    method: 'dataview_init',
                    params: { view_id: viewId },
                }, sessionId) as DataViewInitResult | undefined;
                if (!result || !Array.isArray(result.columns) || typeof result.totalRows !== 'number') {
                    throw new Error('Invalid dataview_init response');
                }
                postResponse(msg.requestId, true, result);
                return;
            }

            if (msg.action === 'page') {
                const result = await sessionRequest({
                    method: 'dataview_page',
                    params: {
                        view_id: viewId,
                        startRow: Number(msg.startRow ?? 0),
                        endRow: Number(msg.endRow ?? 0),
                        sortModel: Array.isArray(msg.sortModel) ? msg.sortModel : [],
                        filterModel: msg.filterModel ?? {},
                    },
                }, sessionId) as DataViewPageResult | undefined;
                if (!result || !Array.isArray(result.rows) ||
                    typeof result.totalRows !== 'number' ||
                    typeof result.totalUnfiltered !== 'number') {
                    throw new Error('Invalid dataview_page response');
                }
                postResponse(msg.requestId, true, result);
                return;
            }

            postResponse(msg.requestId, false, undefined, `Unsupported dataview action: ${String(msg.action)}`);
        } catch (e) {
            postResponse(msg.requestId, false, undefined, e instanceof Error ? e.message : String(e));
        }
    });
}

export function deploySessionWatcher(extensionPath: string): void {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');

    void getGlobalPipePath().then(async (pipePath) => {
        await refreshTerminalDiscoveryFiles(pipePath);
    }).catch(err => {
        console.error('Failed to initialize global session server', err);
    });

}

let pipeClient: IpcSocket | undefined;
export const activeConnections = new Set<IpcSocket>();

function isCurrentSocket(socket: IpcSocket): boolean {
    return !!socket._sessionId && sessions.get(socket._sessionId)?.socket === socket;
}

const pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    socket: IpcSocket;
}>();

const closedTerminals = new WeakSet<vscode.Terminal>();
const terminalDiscoveryOperations = new WeakMap<vscode.Terminal, Promise<void>>();

function queueTerminalDiscoveryOperation(terminal: vscode.Terminal, operation: () => Promise<void>): Promise<void> {
    const previous = terminalDiscoveryOperations.get(terminal) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    terminalDiscoveryOperations.set(terminal, current);
    void current.then(() => {
        if (terminalDiscoveryOperations.get(terminal) === current) {
            terminalDiscoveryOperations.delete(terminal);
        }
    }, () => {
        if (terminalDiscoveryOperations.get(terminal) === current) {
            terminalDiscoveryOperations.delete(terminal);
        }
    });
    return current;
}

let globalSessionServer: net.Server | undefined;
let globalSessionServerStartup: Promise<string> | undefined;
let attachSessionScriptPath: string | undefined;

interface SessionDiscoveryFile {
    version: 1;
    endpoint: string;
    terminalPid?: number;
    // Empty means no JGD renderer; omission by other clients leaves JGD unmanaged.
    jgdSocket?: string;
}

function getSessionDiscoveryDir(): string {
    return path.join(extensionContext.globalStorageUri.fsPath, 'sessions');
}

function isExtensionDiscoveryPath(filePath: string): boolean {
    const discoveryDir = path.resolve(getSessionDiscoveryDir());
    const resolvedPath = path.resolve(filePath);
    return path.dirname(resolvedPath) === discoveryDir && /^[a-f0-9]{32}\.json$/i.test(path.basename(resolvedPath));
}

function terminalDiscoveryPath(terminal: vscode.Terminal): string | undefined {
    const creationOptions = terminal.creationOptions as vscode.TerminalOptions | undefined;
    const candidate = creationOptions?.env?.['SESS_DISCOVERY_FILE'];
    return typeof candidate === 'string' && candidate.length > 0 && isExtensionDiscoveryPath(candidate)
        ? candidate
        : undefined;
}

export function isTerminalClosed(terminal: vscode.Terminal): boolean {
    return closedTerminals.has(terminal);
}

/**
 * Delete the discovery file owned by a terminal that VS Code confirms has ended.
 * Missing exit reasons are intentionally handled by the caller as uncertain because
 * VS Code also closes terminals while preserving them for a window reload.
 */
export async function removeTerminalDiscoveryFile(terminal: vscode.Terminal): Promise<void> {
    closedTerminals.add(terminal);

    await queueTerminalDiscoveryOperation(terminal, async () => {
        let discoveryPath = terminalDiscoveryPath(terminal);
        if (!discoveryPath) {
            const terminalPid = await terminal.processId;
            if (terminalPid !== undefined) {
                discoveryPath = await findDiscoveryFileForTerminal(terminalPid);
            }
        }

        if (discoveryPath) {
            await fs.remove(discoveryPath);
        }
    });
}

export async function createSessionDiscoveryFile(endpoint: string): Promise<string> {
    const discoveryDir = getSessionDiscoveryDir();
    await fs.ensureDir(discoveryDir);
    const filePath = path.join(discoveryDir, `${crypto.randomBytes(16).toString('hex')}.json`);
    await writeSessionDiscoveryFile(filePath, endpoint);
    return filePath;
}

async function writeSessionDiscoveryFile(filePath: string, endpoint: string, terminalPid?: number): Promise<void> {
    if (!isExtensionDiscoveryPath(filePath)) {
        throw new Error('Refusing to write session discovery data outside extension global storage');
    }
    const data: SessionDiscoveryFile = { version: 1, endpoint, jgdSocket: getSessionJgdSocket() };
    if (terminalPid !== undefined) {
        data.terminalPid = terminalPid;
    } else if (await fs.pathExists(filePath)) {
        const existing = await fs.readJson(filePath) as Partial<SessionDiscoveryFile>;
        if (typeof existing.terminalPid === 'number') {
            data.terminalPid = existing.terminalPid;
        }
    }
    await fs.ensureDir(path.dirname(filePath));
    const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
        await fs.writeJson(temporaryPath, data, { mode: 0o600 });
        await setOwnerOnlyPermissions(temporaryPath);
        await fs.rename(temporaryPath, filePath);
        await setOwnerOnlyPermissions(filePath);
    } catch (error) {
        await fs.remove(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function updateSessionDiscoveryFile(filePath: string, endpoint: string, terminalPid?: number): Promise<void> {
    await writeSessionDiscoveryFile(filePath, endpoint, terminalPid);
}

export async function updateTerminalSessionDiscoveryFile(
    terminal: vscode.Terminal,
    filePath: string,
    endpoint: string,
    terminalPid?: number,
): Promise<void> {
    await queueTerminalDiscoveryOperation(terminal, async () => {
        if (!isTerminalClosed(terminal)) {
            await writeSessionDiscoveryFile(filePath, endpoint, terminalPid);
        }
    });
}

async function findDiscoveryFileForTerminal(terminalPid: number): Promise<string | undefined> {
    const discoveryDir = getSessionDiscoveryDir();
    if (!await fs.pathExists(discoveryDir)) {
        return undefined;
    }
    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const file of await fs.readdir(discoveryDir)) {
        if (!file.endsWith('.json')) {
            continue;
        }
        const filePath = path.join(discoveryDir, file);
        if (!isExtensionDiscoveryPath(filePath)) {
            continue;
        }
        try {
            const discovery = await fs.readJson(filePath) as Partial<SessionDiscoveryFile>;
            if (discovery.version === 1 && discovery.terminalPid === terminalPid && typeof discovery.endpoint === 'string') {
                const stat = await fs.stat(filePath);
                candidates.push({ filePath, mtimeMs: stat.mtimeMs });
            }
        } catch (e) {
            console.warn(`[session discovery] Failed to read ${filePath}`, e);
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
    return candidates[0]?.filePath;
}

export async function refreshTerminalDiscoveryFiles(
    pipePath: string,
    terminals: readonly vscode.Terminal[] = vscode.window.terminals,
): Promise<void> {
    for (const term of terminals) {
        if (isTerminalClosed(term)) {
            continue;
        }
        const envPath = terminalDiscoveryPath(term);
        const terminalPid = await term.processId;
        if (!terminalPid || isTerminalClosed(term)) {
            continue;
        }
        let discoveryPath = envPath;
        discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
        if (discoveryPath && !isTerminalClosed(term)) {
            await updateTerminalSessionDiscoveryFile(term, discoveryPath, pipePath, terminalPid);
        }
    }
}

export async function updateTerminalDiscovery(terminal: vscode.Terminal): Promise<void> {
    if (!globalPipePath || isTerminalClosed(terminal)) {
        return;
    }
    const terminalPid = await terminal.processId;
    if (terminalPid === undefined || isTerminalClosed(terminal)) {
        return;
    }
    let discoveryPath = terminalDiscoveryPath(terminal);
    discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
    if (discoveryPath && !isTerminalClosed(terminal)) {
        await updateTerminalSessionDiscoveryFile(terminal, discoveryPath, globalPipePath, terminalPid);
    }
}

async function setOwnerOnlyPermissions(filePath: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    await fs.chmod(filePath, 0o600);
}

function makePipePath(): string {
    const suffix = crypto.randomBytes(8).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\vscode-r-${suffix}`;
    } else {
        return path.join(os.tmpdir(), `vscode-r-${suffix}.sock`);
    }
}

export async function getGlobalPipePath(): Promise<string> {
    if (globalPipePath) {
        return globalPipePath;
    }

    if (!globalSessionServerStartup) {
        globalSessionServerStartup = startGlobalSessionServer().catch((err: unknown) => {
            globalSessionServerStartup = undefined;
            throw err;
        });
    }
    return globalSessionServerStartup;
}

function startGlobalSessionServer(): Promise<string> {
    return new Promise((resolve, reject) => {
        const pipePath = makePipePath();
        let listening = false;
        let settled = false;
        let initialized = false;
        const server = net.createServer((rawSocket) => {
            // Do not accept attach messages until initialization has succeeded.
            if (!initialized) {
                rawSocket.destroy();
                return;
            }
            const socket = rawSocket as IpcSocket;
            socket._pipePath = pipePath;
            console.info('[SessionServer] Client connected via IPC pipe');
            activeConnections.add(socket);

            let readBuffers: Buffer[] = [];
            let readBufferLength = 0;

            const handleLine = (buf: Buffer) => {
                let lineEnd = buf.length;
                if (lineEnd > 0 && buf[lineEnd - 1] === 0x0d) {
                    lineEnd--;
                }
                if (lineEnd === 0) {
                    return;
                }

                const line = buf.toString('utf8', 0, lineEnd);
                void (async () => {
                    try {
                        const message = JSON.parse(line) as Record<string, unknown>;
                        if (message.method !== 'attach' && !isCurrentSocket(socket)) {
                            return;
                        }
                        if (message.id !== undefined && !message.method) {
                            // Response to a request we sent
                            const id = Number(message.id);
                            const pending = pendingRequests.get(id);
                            if (pending?.socket === socket) {
                                pendingRequests.delete(id);
                                if (message.error) {
                                    pending.reject(message.error);
                                } else {
                                    pending.resolve(message.result);
                                }
                            }
                        } else if (message.id === undefined || message.id === null) {
                            await handleNotification(message, socket);
                        } else {
                            await handleRequest(message, socket);
                        }
                    } catch (e) {
                        console.error('[SessionServer] Error handling message', e);
                    }
                })();
            };

            socket.on('data', (data: Buffer) => {
                let start = 0;
                let newline = data.indexOf(0x0a, start);

                while (newline !== -1) {
                    const incoming = data.subarray(start, newline);
                    let buf: Buffer;

                    if (readBuffers.length === 0) {
                        buf = incoming;
                    } else {
                        if (incoming.length > 0) {
                            readBuffers.push(incoming);
                            readBufferLength += incoming.length;
                        }
                        buf = readBuffers.length === 1
                            ? readBuffers[0]
                            : Buffer.concat(readBuffers, readBufferLength);
                        readBuffers = [];
                        readBufferLength = 0;
                    }

                    handleLine(buf);
                    start = newline + 1;
                    newline = data.indexOf(0x0a, start);
                }

                if (start < data.length) {
                    const incoming = data.subarray(start);
                    readBuffers.push(incoming);
                    readBufferLength += incoming.length;
                }
            });

            socket.on('close', () => {
                console.info('[SessionServer] Client disconnected');
                readBuffers = [];
                readBufferLength = 0;
                activeConnections.delete(socket);
                for (const [id, pending] of pendingRequests.entries()) {
                    if (pending.socket === socket) {
                        pendingRequests.delete(id);
                        pending.reject(new Error('IPC socket disconnected'));
                    }
                }
                if (pipeClient === socket) {
                    pipeClient = undefined;
                }
                if (socket._sessionId) {
                    void cleanupSession(socket._sessionId, socket);
                }
            });

            socket.on('error', (err) => {
                console.error('[SessionServer] Socket error', err);
                socket.destroy();
            });
        });

        const failStartup = (err: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            server.close(() => {
                void (async () => {
                    // Never unlink an endpoint whose listen failed (e.g. EADDRINUSE).
                    if (listening && process.platform !== 'win32') {
                        await removePathIfExists(pipePath);
                    }
                    reject(err);
                })();
            });
        };

        server.on('error', (err) => {
            console.error('[SessionServer] Server error', err);
            failStartup(err);
        });

        try {
            server.listen(pipePath, () => {
                listening = true;
                void setOwnerOnlyPermissions(pipePath).then(() => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    initialized = true;
                    globalPipePath = pipePath;
                    globalSessionServer = server;
                    console.info(`[SessionServer] Listening on ${pipePath}`);
                    resolve(pipePath);
                }).catch(failStartup);
            });
        } catch (err) {
            failStartup(err);
        }
    });
}

// Keep managed discovery, the public API, and manual attach on the same renderer.
function getSessionJgdSocket(): string {
    return jgdEnabled()
        ? (globalPlotManager as CommonPlotManager)?.getJgdEnvVars()?.['JGD_SOCKET'] ?? ''
        : '';
}

/** Return the public connection contract for downstream session clients. */
export async function getConnectionInfo(): Promise<RSessionConnectionInfo | undefined> {
    if (!enableSessionWatcher) {
        return undefined;
    }

    const endpoint = await getGlobalPipePath();
    const plotBackend = resolveBackend();
    const jgdSocket = getSessionJgdSocket();
    return {
        protocolVersion: SESS_PROTOCOL_VERSION,
        endpoint,
        plotBackend,
        ...(jgdSocket ? { jgdSocket } : {}),
    };
}

function asRStringLiteral(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getAttachSessionScriptPath(pipePath: string): string {
    const scriptBase = path.basename(pipePath).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'attach_session';
    return path.join(extensionContext.globalStorageUri.fsPath, 'tmp', 'attach', `${scriptBase}.R`);
}

function buildAttachSessionScript(pipePath: string, sessPath: string, installSessScriptPath: string): string {
    const backend = resolveBackend();
    const jgdSocket = getSessionJgdSocket();
    return [
        'local({',
        `  endpoint <- ${asRStringLiteral(pipePath)}`,
        `  sess_src <- ${asRStringLiteral(sessPath)}`,
        `  install_sess_script <- ${asRStringLiteral(installSessScriptPath)}`,
        ...(backend === 'native' ? [] : [
            jgdSocket ? `  Sys.setenv(JGD_SOCKET = ${asRStringLiteral(jgdSocket)})` : '  Sys.unsetenv("JGD_SOCKET")',
        ]),
        `  source(${asRStringLiteral(extensionContext.asAbsolutePath(path.join('R', 'sess_source.R')).replace(/\\/g, '/'))}, local = TRUE)`,
        '  if (sess_install_required(sess_src)) {',
        '    if (!file.exists(install_sess_script)) {',
        '      stop(sprintf("install_sess.R not found: %s", install_sess_script))',
        '    }',
        '    Sys.setenv(VSCODE_R_SESS_PKG_PATH = sess_src)',
        '    on.exit(Sys.unsetenv(c("VSCODE_R_SESS_PKG_PATH", "VSCODE_R_SESS_REPO")), add = TRUE)',
        '    source(install_sess_script, local = TRUE)',
        '  }',
        `  sess::connect(endpoint = endpoint, plot_backend = ${asRStringLiteral(backend)})`,
        '})',
        '',
    ].join('\n');
}

export async function getAttachSessionCommand(): Promise<string> {
    const pipePath = await getGlobalPipePath();
    const sessPath = extensionContext.asAbsolutePath(path.join('dist', 'resources', 'sess')).replace(/\\/g, '/');
    const installSessScriptPath = extensionContext.asAbsolutePath(path.join('R', 'install_sess.R')).replace(/\\/g, '/');
    const scriptPath = getAttachSessionScriptPath(pipePath);
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.writeFile(scriptPath, buildAttachSessionScript(pipePath, sessPath, installSessScriptPath), { encoding: 'utf-8', mode: 0o600 });
    await setOwnerOnlyPermissions(scriptPath);
    attachSessionScriptPath = scriptPath;

    return `source(${asRStringLiteral(scriptPath)})`;
}

async function removePathIfExists(pathLike: string): Promise<void> {
    try {
        if (await fs.pathExists(pathLike)) {
            await fs.remove(pathLike);
        }
    } catch (e) {
        console.warn(`[session cleanup] Failed to remove ${pathLike}`, e);
    }
}

export async function shutdownSessionWatcher(): Promise<void> {
    // Startup publishes the server only after listen and permission setup finish.
    // Wait before capturing it, otherwise it could survive extension shutdown.
    await globalSessionServerStartup?.catch(() => undefined);
    const pipePath = globalPipePath;

    for (const socket of activeConnections) {
        socket.destroy();
    }
    activeConnections.clear();
    pipeClient = undefined;

    if (globalSessionServer) {
        await new Promise<void>((resolve) => {
            try {
                globalSessionServer?.close(() => resolve());
            } catch {
                resolve();
            }
        });
        globalSessionServer = undefined;
    }

    if (attachSessionScriptPath) {
        await removePathIfExists(attachSessionScriptPath);
        attachSessionScriptPath = undefined;
    }

    if (pipePath && pipePath.endsWith('.sock')) {
        await removePathIfExists(pipePath);
    }

    globalPipePath = undefined;
    globalSessionServerStartup = undefined;
}

export async function activateRSession(): Promise<void> {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[activateRSession]');
        const terminal = window.activeTerminal;
        const pidArg = await terminal?.processId;
        if (terminal) {
            if (pidArg) {
                const session = terminalSessions.get(String(pidArg));
                if (session) {
                    console.info(`[activateRSession] Found existing session for PID: ${pidArg}`);
                    await activateSession(session);
                    terminal.show();
                    return;
                }
            }
        }

        // Restore the selected managed terminal before focusing another session.
        const discoveryPath = terminal && (terminalDiscoveryPath(terminal) ||
            (pidArg ? await findDiscoveryFileForTerminal(pidArg) : undefined));
        if (terminal && discoveryPath && !isTerminalClosed(terminal)) {
            const command = await getAttachSessionCommand();
            terminal.sendText(command, true);
            terminal.show();
            return;
        }

        if (activeSession) {
            console.info('[activateRSession] Focusing terminal of the active session');
            for (const term of window.terminals) {
                const termPid = await term.processId;
                if (termPid && terminalSessions.get(String(termPid)) === activeSession) {
                    term.show();
                    return;
                }
            }
        }

        if (config().get<boolean>('alwaysUseActiveTerminal')) {
            if (terminal) {
                const command = await getAttachSessionCommand();
                terminal.sendText(command, true);
                terminal.show();
                return;
            }

            const action = await window.showInformationMessage(
                'No active terminal is available. You can copy the attach command or create a managed R terminal.',
                'Copy Attach Command',
                'Create R Terminal'
            );

            if (action === 'Copy Attach Command') {
                await connectToSession();
                return;
            }
            if (action === 'Create R Terminal') {
                await rTerminal.createRTerm();
            }
            return;
        }

        console.info('[activateRSession] Creating new R terminal');
        await rTerminal.createRTerm();
    } else {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}

export function removeDirectory(dir: string): void {
    console.info(`[removeDirectory] dir: ${dir}`);
    if (fs.existsSync(dir)) {
        console.info('[removeDirectory] dir exists');
        fs.readdirSync(dir)
            .forEach((file) => {
                const curPath = path.join(dir, file);
                console.info(`[removeDirectory] Remove ${curPath}`);
                fs.unlinkSync(curPath);
            });
        console.info(`[removeDirectory] Remove dir ${dir}`);
        fs.rmdirSync(dir);
    }
    console.info('[removeDirectory] Done');
}

export function sessionDirectoryExists(): boolean {
    return (fs.existsSync(sessionDir));
}

export function removeSessionFiles(): void {
    console.info('[removeSessionFiles] ', sessionDir);
    if (sessionDirectoryExists()) {
        removeDirectory(sessionDir);
    }
    console.info('[removeSessionFiles] Done');
}

async function updatePlot() {
    if (!globalPipePath) {return;}
    await globalPlotManager?.showStandardPlot();
}

export function deferWorkspaceRefresh(): void {
    if (workspaceRefreshTimer) {
        clearTimeout(workspaceRefreshTimer);
        workspaceRefreshTimer = undefined;
    }
}

function scheduleWorkspaceRefresh(delayMs: number = 500): void {
    workspaceRefreshPending = true;
    if (workspaceRefreshTimer) {
        clearTimeout(workspaceRefreshTimer);
    }
    workspaceRefreshTimer = setTimeout(() => {
        workspaceRefreshTimer = undefined;
        void runWorkspaceRefresh();
    }, delayMs);
}

async function runWorkspaceRefresh(): Promise<void> {
    if (workspaceRefreshInProgress || !workspaceRefreshPending) {
        return;
    }
    workspaceRefreshPending = false;
    workspaceRefreshInProgress = true;
    try {
        await updateWorkspace();
    } finally {
        workspaceRefreshInProgress = false;
        if (workspaceRefreshPending) {
            scheduleWorkspaceRefresh();
        }
    }
}

export async function updateWorkspace() {
    const requestedSession = activeSession;
    if ((!globalPipePath && !requestedSession?.requester) || !requestedSession || requestedSession.workspaceUnavailable) {return;}
    try {
        const response = await sessionRequest({ method: 'workspace' }, requestedSession);
        if (response && sessions.get(requestedSession.sessionId) === requestedSession) {
            updateSessionWorkspace(requestedSession, response as WorkspaceData);
            console.info('[updateWorkspace] Done');
        }
    } catch (e) {
        console.error(e);
    }
}

export async function showBrowser(url: string, title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showBrowser] uri: ${url}, viewer: ${viewer.toString()}`);
    const uri = Uri.parse(url);
    if (viewer === false) {
        void env.openExternal(uri);
    } else {
        const viewColumn = ViewColumn[String(viewer) as keyof typeof ViewColumn];
        await commands.executeCommand('simpleBrowser.show', url, {
            preserveFocus: true,
            viewColumn: viewColumn,
        });
        activeBrowserUri = uri;
    }
    console.info('[showBrowser] Done');
}

export function refreshBrowser(): void {
    console.log('[refreshBrowser]');
    if (activeBrowserUri) {
        void commands.executeCommand('simpleBrowser.show', activeBrowserUri.toString(true), {
            preserveFocus: true,
        });
    }
}

export function openExternalBrowser(): void {
    console.log('[openExternalBrowser]');
    if (activeBrowserUri) {
        void env.openExternal(activeBrowserUri);
    }
}

export async function showDataView(
    source: string, type: string, title: string, file: string, viewer: string,
    viewId?: string, navigation?: ListViewNavigation,
    sessionId: string | null = activeSession?.sessionId ?? null,
    instance?: number,
): Promise<void> {
    resDir ??= path.join(extensionContext.extensionPath, 'dist', 'resources');
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}, viewId: ${String(viewId ?? '')}`);
    const panelKey = JSON.stringify([sessionId, viewId]);

    if (source === 'table') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(panelKey);
            if (existing) {
                if (instance !== undefined) {
                    dynamicDataViewInstances.set(existing, instance);
                }
                existing.title = title;
                existing.reveal(existing.viewColumn, true);
                const content = await getTableHtml(existing.webview, undefined, title);
                existing.webview.html = `${content}\n<!-- dataview-reload:${++dynamicDataViewReloadRevision} -->`;
                return;
            }
        }

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
        panel.iconPath = new UriIcon('open-preview');
        if (viewId) {
            registerDataViewPanel(panel, panelKey, viewId, sessionId, instance);
            attachDynamicDataViewBridge(panel, viewId, sessionId);
        }
        const content = await getTableHtml(panel.webview, file || undefined, title);
        panel.webview.html = content;
    } else if (source === 'list') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(panelKey);
            if (existing) {
                if (instance !== undefined) {
                    dynamicDataViewInstances.set(existing, instance);
                }
                existing.title = title;
                existing.reveal(existing.viewColumn, true);
                existing.webview.html = getListHtml(
                    existing.webview, title, navigation
                );
                return;
            }
        }

        const panel = window.createWebviewPanel('dataview', title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(extensionContext.asAbsolutePath('images/icons'))],
            });
        panel.iconPath = new UriIcon('preview');
        if (viewId) {
            registerDataViewPanel(panel, panelKey, viewId, sessionId, instance);
            const webview = panel.webview;
            webview.onDidReceiveMessage(async (message: {
                message?: string; index?: number; start?: number; requestId?: number;
                path?: number[]; generation?: number;
            }) => {
                if (message.generation !== listViewGenerations.get(webview)) {
                    return;
                }
                if (!Array.isArray(message.path) || !message.path.every(index => Number.isSafeInteger(index) && index > 0)) {
                    return;
                }
                if (message.message === 'listview/navigate' ||
                    (message.message === 'listview/view' && Number.isSafeInteger(message.index))) {
                    const result = await sessionRequest({
                        method: message.message === 'listview/navigate' ? 'listview_navigate' : 'listview_view',
                        params: { view_id: viewId, index: message.index, path: message.path },
                    }, sessionId) as ListViewNavigation | boolean | undefined;
                    if (message.generation !== listViewGenerations.get(webview)) {
                        return;
                    }
                    const navigation = result && typeof result === 'object' && Array.isArray(result.breadcrumbs)
                        ? result : undefined;
                    if (navigation) {
                        panel.title = navigation.title;
                    }
                    void webview.postMessage({
                        message: 'listview/navigation',
                        generation: message.generation,
                        requestId: message.requestId,
                        navigation,
                        error: result ? undefined : 'Unable to open this item. Check the R session and try again.',
                    });
                } else if (message.message === 'listview/page' && typeof message.start === 'number' &&
                    Number.isInteger(message.start) && typeof message.requestId === 'number') {
                    const page = await sessionRequest({
                        method: 'workspace_children',
                        params: { view_id: viewId, start: message.start, path: message.path },
                    }, sessionId) as { children?: unknown; next_start?: number | null } | undefined;
                    if (message.generation !== listViewGenerations.get(webview)) {
                        return;
                    }
                    void webview.postMessage({
                        message: 'listview/page',
                        generation: message.generation,
                        requestId: message.requestId,
                        ...page,
                        error: Array.isArray(page?.children) ? undefined : 'Unable to load items. Check the R session and try again.',
                    });
                }
            });
        }
        panel.webview.html = getListHtml(
            panel.webview, title, navigation
        );
    } else {
        await commands.executeCommand('vscode.open', Uri.file(file), {
            preserveFocus: true,
            preview: true,
            viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
        });
    }
    console.info('[showDataView] Done');
}

export async function getTableHtml(webview: Webview, file: string | undefined, title: string): Promise<string> {
    const pageSize = config().get<number>('session.data.pageSize', 500);
    if (!file) {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style media="only screen">
    html, body {
        height: 100%;
        width: 100%;
        margin: 0;
        box-sizing: border-box;
        -webkit-overflow-scrolling: touch;
    }

    html {
        position: absolute;
        top: 0;
        left: 0;
        padding: 0;
        overflow: auto;
    }

    body {
        padding: 0;
        overflow: auto;
    }

    [class*="vscode"] div.ag-root-wrapper {
        background-color: var(--vscode-editor-background);
    }

    [class*="vscode"] div.ag-header {
        background-color: var(--vscode-sideBar-background);
    }

    [class*="vscode"] div.ag-header-cell[aria-sort="ascending"], div.ag-header-cell[aria-sort="descending"] {
        color: var(--vscode-textLink-activeForeground);
    }

    [class*="vscode"] div.ag-row {
        color: var(--vscode-editor-foreground);
    }

    [class*="vscode"] .ag-row-hover {
        background-color: var(--vscode-list-hoverBackground) !important;
        color: var(--vscode-list-hoverForeground);
    }

    [class*="vscode"] .ag-row-selected {
        background-color: var(--vscode-editor-selectionBackground) !important;
        color: var(--vscode-editor-selectionForeground) !important;
    }

    [class*="vscode"] div.ag-row-even {
        border: 0px;
        background-color: var(--vscode-editor-background);
    }

    [class*="vscode"] div.ag-row-odd {
        border: 0px;
        background-color: var(--vscode-sideBar-background);
    }

    [class*="vscode"] div.ag-ltr div.ag-has-focus div.ag-cell-focus:not(div.ag-cell-range-selected) {
        border-color: var(--vscode-editorCursor-foreground);
    }

    [class*="vscode"] div.ag-menu {
        background-color: var(--vscode-notifications-background);
        color: var(--vscode-notifications-foreground);
        border-color: var(--vscode-notifications-border);
    }

    [class*="vscode"] div.ag-filter-apply-panel-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 0;
        padding: 5px 10px;
        font-size: 12px;
    }

    [class*="vscode"] div.ag-picker-field-wrapper {
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        border-color: var(--vscode-notificationCenter-border);
    }

    [class*="vscode"] input[class^=ag-] {
        border-color: var(--vscode-notificationCenter-border) !important;
    }

    #gridContainer {
        position: relative;
    }

    #fetchStatus {
        position: absolute;
        top: var(--fetch-status-top, 52px);
        right: 8px;
        z-index: 20;
        display: none;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        font-size: 12px;
        max-width: min(68vw, 560px);
    }

    #fetchStatus.visible {
        display: flex;
    }

    #fetchStatus[data-state="warning"] {
        border-color: var(--vscode-inputValidation-warningBorder);
    }

    #fetchStatus[data-state="error"] {
        border-color: var(--vscode-inputValidation-errorBorder);
    }

    #fetchStatusText {
        word-break: break-word;
    }

    #fetchRetryBtn {
        display: none;
        border: 0;
        padding: 3px 8px;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        white-space: nowrap;
    }

    #fetchStatus.show-retry #fetchRetryBtn {
        display: inline-block;
    }

    #scrollPosition {
        position: absolute;
        top: 52px;
        right: 24px;
        z-index: 21;
        display: none;
        padding: 4px 8px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background-color: var(--vscode-editorWidget-background);
        color: var(--vscode-editorWidget-foreground);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        font-size: 12px;
        pointer-events: none;
        white-space: nowrap;
    }

    #scrollPosition.visible {
        display: block;
    }

    .dataview-na {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        opacity: 0.75;
    }
    ${getDataViewerColumnPanelStyle()}
    ${getDataViewerStyle()}
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
    let requestIdSeq = 1;
    const pending = new Map();
    let gridApi;
    ${getDataViewerColumnPanelScript()}
    ${getDataViewerScript()}
    let activeFetches = 0;
    let longFetchTimer;
    let filteredRows = 0;
    let totalRows = 0;
    let isFiltered = false;
    let verticalScrollbar;
    let scrollbarPositionAttached = false;
    let scrollbarPressed = false;
    const LONG_FETCH_DELAY_MS = 2000;
    const rowNumberFormatter = new Intl.NumberFormat();
    function clearLongFetchTimer() {
        if (longFetchTimer) {
            clearTimeout(longFetchTimer);
            longFetchTimer = undefined;
        }
    }

    function setFetchStatus(state, message, showRetry) {
        const statusEl = document.querySelector('#fetchStatus');
        const textEl = document.querySelector('#fetchStatusText');
        if (!statusEl || !textEl) {
            return;
        }

        if (state === 'hidden') {
            statusEl.classList.remove('visible', 'show-retry');
            statusEl.dataset.state = '';
            textEl.textContent = '';
            return;
        }

        statusEl.dataset.state = state;
        textEl.textContent = message;
        statusEl.classList.add('visible');
        statusEl.classList.toggle('show-retry', Boolean(showRetry));
    }

    function updateFetchStatusPosition() {
        const containerEl = document.querySelector('#gridContainer');
        if (!containerEl) {
            return;
        }

        const headerEl = document.querySelector('#myGrid .ag-header');
        const topOffset = headerEl
            ? Math.max(8, Math.round(headerEl.getBoundingClientRect().bottom -
                containerEl.getBoundingClientRect().top) + 8)
            : 8;
        containerEl.style.setProperty('--fetch-status-top', String(topOffset) + 'px');
    }

    function beginFetch(message) {
        activeFetches += 1;
        if (activeFetches === 1) {
            setFetchStatus('loading', message || 'Fetching data...', false);
            clearLongFetchTimer();
            longFetchTimer = setTimeout(() => {
                if (activeFetches > 0) {
                    setFetchStatus('warning', 'Still waiting for R session response. It may be busy running code.', false);
                }
            }, LONG_FETCH_DELAY_MS);
        }
    }

    function finishFetch(ok, errorMessage) {
        activeFetches = Math.max(0, activeFetches - 1);
        if (activeFetches !== 0) {
            return;
        }

        clearLongFetchTimer();
        if (ok) {
            setFetchStatus('hidden', '', false);
        } else {
            setFetchStatus('error', errorMessage || 'Failed to fetch data from R session.', true);
        }
    }

    function retryCurrentPage() {
        if (!gridApi) {
            return;
        }
        setFetchStatus('loading', 'Retrying data fetch...', false);
        if (typeof gridApi.refreshInfiniteCache === 'function') {
            gridApi.refreshInfiniteCache();
        } else if (typeof gridApi.purgeInfiniteCache === 'function') {
            gridApi.purgeInfiniteCache();
        }
    }

    function updateScrollPosition() {
        if (!scrollbarPressed || !verticalScrollbar || !gridApi) {
            return;
        }

        const positionEl = document.querySelector('#scrollPosition');
        const containerEl = document.querySelector('#gridContainer');
        if (!positionEl || !containerEl || filteredRows < 1) {
            return;
        }

        const maximumScroll =
            verticalScrollbar.scrollHeight - verticalScrollbar.clientHeight;
        const scrollRatio = maximumScroll > 0
            ? Math.max(0, Math.min(1, verticalScrollbar.scrollTop / maximumScroll))
            : 0;

        let pageStart = 0;
        let rowsInView = filteredRows;
        if (${pageSize > 0 ? 'true' : 'false'} &&
            typeof gridApi.paginationGetCurrentPage === 'function' &&
            typeof gridApi.paginationGetPageSize === 'function') {
            pageStart =
                gridApi.paginationGetCurrentPage() * gridApi.paginationGetPageSize();
            pageStart = Math.min(pageStart, Math.max(0, filteredRows - 1));
            rowsInView = Math.min(
                gridApi.paginationGetPageSize(),
                filteredRows - pageStart
            );
        }
        const currentRow = Math.min(
            filteredRows,
            pageStart + Math.round(scrollRatio * Math.max(0, rowsInView - 1)) + 1
        );
        positionEl.textContent =
            rowNumberFormatter.format(currentRow) +
            ' of ' + rowNumberFormatter.format(filteredRows);

        const scrollbarRect = verticalScrollbar.getBoundingClientRect();
        const containerRect = containerEl.getBoundingClientRect();
        const labelHeight = positionEl.offsetHeight;
        const desiredTop = scrollbarRect.top - containerRect.top +
            scrollRatio * Math.max(0, scrollbarRect.height - labelHeight);
        const maximumTop = containerRect.height - labelHeight - 8;
        positionEl.style.top =
            String(Math.max(8, Math.min(desiredTop, maximumTop))) + 'px';
    }

    function attachScrollbarPositionIndicator() {
        if (scrollbarPositionAttached) {
            return;
        }

        verticalScrollbar = document.querySelector(
            '#myGrid .ag-body-vertical-scroll-viewport'
        );
        if (!verticalScrollbar) {
            return;
        }

        scrollbarPositionAttached = true;
        verticalScrollbar.addEventListener('pointerdown', () => {
            scrollbarPressed = true;
            document.querySelector('#scrollPosition')?.classList.add('visible');
            updateScrollPosition();
        });
        verticalScrollbar.addEventListener('scroll', updateScrollPosition, {
            passive: true
        });

        const hidePosition = () => {
            scrollbarPressed = false;
            document.querySelector('#scrollPosition')?.classList.remove('visible');
        };
        window.addEventListener('pointerup', hidePosition);
        window.addEventListener('pointercancel', hidePosition);
    }

    function request(action, payload) {
        const requestId = requestIdSeq++;
        return new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
            try {
                console.log('[dataview] Sending request:', action, 'with payload:', payload);
                vscode.postMessage({
                    message: 'dataview/request',
                    action,
                    requestId,
                    ...payload,
                });
            } catch (e) {
                console.error('[dataview] Failed to send request:', e);
                pending.delete(requestId);
                reject(e);
            }
        });
    }

    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.message !== 'dataview/response') {
            return;
        }
        const entry = pending.get(data.requestId);
        if (!entry) {
            return;
        }
        pending.delete(data.requestId);
        if (data.ok) {
            entry.resolve(data.result);
        } else {
            entry.reject(new Error(data.error || 'Unknown dataview error'));
        }
    });

    function updateTheme() {
        if (gridApi) {
            gridApi.setGridOption('theme', getAgTheme());
        }
        updateFetchStatusPosition();
    }

    async function initialize() {
        beginFetch('Loading data viewer metadata...');
        let init;
        try {
            init = await request('init', {});
            finishFetch(true);
        } catch (e) {
            const initError = e instanceof Error ? e.message : String(e);
            finishFetch(false, 'Failed to initialize data viewer: ' + initError);
            throw e;
        }

        const columns = Array.isArray(init.columns) ? init.columns : [];
        filteredRows = init.totalRows;
        totalRows = init.totalRows;
        if (init.live) {
            const info = document.createElement('span');
            info.textContent = 'Full data';
            info.title = 'This view retains the full object without a copy. Reference edits may appear here. Reopen from the cell to refresh after edits. Sorting and filtering scan the full data.';
            document.querySelector('#viewerToolbar').append(info);
        }
        const bigintFields = prepareViewerColumns(columns);
        updateViewerRowCount(filteredRows, totalRows);
        const rowIndexColumn = columns.find(column => column.field === '0');
        if (rowIndexColumn) {
            rowIndexColumn.headerValueGetter = () => isFiltered
                ? '(' + rowNumberFormatter.format(filteredRows) +
                    '/' + rowNumberFormatter.format(totalRows) + ')' : '';
        }

        const blockSize = ${pageSize > 0 ? pageSize : 500};

        const datasource = {
            getRows: async function(params) {
                beginFetch('Fetching rows from R session...');
                try {
                    const result = await request('page', {
                        startRow: params.startRow,
                        endRow: params.endRow,
                        sortModel: params.sortModel,
                        filterModel: params.filterModel,
                    });
                    filteredRows = result.totalRows;
                    totalRows = result.totalUnfiltered;
                    isFiltered = Object.keys(params.filterModel || {}).length > 0;
                    updateViewerRowCount(filteredRows, totalRows);
                    gridApi?.refreshHeader();
                    updateScrollPosition();
                    const resolvedLastRow = Number.isFinite(result.totalRows) ? result.totalRows : result.lastRow;
                    const rows = prepareViewerRows(result.rows || [], bigintFields);
                    params.successCallback(rows, resolvedLastRow);
                    finishFetch(true);
                } catch (e) {
                    console.error('[dataview] Failed to load page', e);
                    params.failCallback();
                    const pageError = e instanceof Error ? e.message : String(e);
                    finishFetch(false, 'Failed to fetch page: ' + pageError);
                }
            }
        };

        const gridOptions = {
            ...getViewerGridOptions(${pageSize}),
            columnDefs: columns,
            rowModelType: 'infinite',
            datasource: datasource,
            cacheBlockSize: blockSize,
            onPaginationChanged: updateScrollPosition,
            onGridSizeChanged: updateFetchStatusPosition,
            onDisplayedColumnsChanged: updateFetchStatusPosition,
            onFirstDataRendered: function() {
                updateFetchStatusPosition();
                attachScrollbarPositionIndicator();
            }
        };

        const gridDiv = document.querySelector('#myGrid');
        try {
            console.log('[dataview] Creating grid with options:', gridOptions);
            gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
            initializeViewerToolbar();
            console.log('[dataview] Grid created successfully');
            updateFetchStatusPosition();
        } catch (e) {
            console.error('[dataview] Grid creation failed:', e);
            console.error('[dataview] Error stack:', e instanceof Error ? e.stack : 'N/A');
            gridDiv.textContent = 'Error: ' + (e instanceof Error ? e.message : String(e));
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const retryBtn = document.querySelector('#fetchRetryBtn');
        if (retryBtn) {
            retryBtn.addEventListener('click', retryCurrentPage);
        }

        updateTheme();
        initialize().catch((e) => {
            console.error('[dataview] Initialization failed', e);
            const initError = e instanceof Error ? e.message : String(e);
            setFetchStatus('error', 'Initialization failed: ' + initError, true);
        });

        const observer = new MutationObserver(function () {
            updateTheme();
        });
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
            childList: false,
            characterData: false
        });
    });
    </script>
</head>
<body>
    ${getDataViewerToolbarHtml()}
    <div id="gridContainer">
        <div id="myGrid" style="height: 100%;"></div>
        ${getDataViewerColumnPanelHtml()}
        <div id="scrollPosition" role="status" aria-live="polite"></div>
        <div id="fetchStatus" data-state="" role="status" aria-live="polite">
            <span id="fetchStatusText"></span>
            <button id="fetchRetryBtn" type="button">Retry</button>
        </div>
    </div>
</body>
</html>
`;
    }

    const content = await readContent(file, 'utf8');
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style media="only screen">
    html, body {
        height: 100%;
        width: 100%;
        margin: 0;
        box-sizing: border-box;
        -webkit-overflow-scrolling: touch;
    }

    html {
        position: absolute;
        top: 0;
        left: 0;
        padding: 0;
        overflow: auto;
    }

    body {
        padding: 0;
        overflow: auto;
    }

    /* Styling for wrapper and header */

    [class*="vscode"] div.ag-root-wrapper {
        background-color: var(--vscode-editor-background);
    }

    [class*="vscode"] div.ag-header {
        background-color: var(--vscode-sideBar-background);
    }

    [class*="vscode"] div.ag-header-cell[aria-sort="ascending"], div.ag-header-cell[aria-sort="descending"] {
        color: var(--vscode-textLink-activeForeground);
    }

    /* Styling for rows and cells */

    [class*="vscode"] div.ag-row {
        color: var(--vscode-editor-foreground);
    }

    [class*="vscode"] .ag-row-hover {
        background-color: var(--vscode-list-hoverBackground) !important;
        color: var(--vscode-list-hoverForeground);
    }

    [class*="vscode"] .ag-row-selected {
        background-color: var(--vscode-editor-selectionBackground) !important;
        color: var(--vscode-editor-selectionForeground) !important;
    }

    [class*="vscode"] div.ag-row-even {
        border: 0px;
        background-color: var(--vscode-editor-background);
    }

    [class*="vscode"] div.ag-row-odd {
        border: 0px;
        background-color: var(--vscode-sideBar-background);
    }

    [class*="vscode"] div.ag-ltr div.ag-has-focus div.ag-cell-focus:not(div.ag-cell-range-selected) {
        border-color: var(--vscode-editorCursor-foreground);
    }

    /* Styling for the filter pop-up */

    [class*="vscode"] div.ag-menu {
        background-color: var(--vscode-notifications-background);
        color: var(--vscode-notifications-foreground);
        border-color: var(--vscode-notifications-border);
    }

    [class*="vscode"] div.ag-filter-apply-panel-button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 0;
        padding: 5px 10px;
        font-size: 12px;
    }

    [class*="vscode"] div.ag-picker-field-wrapper {
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        border-color: var(--vscode-notificationCenter-border);
    }

    [class*="vscode"] input[class^=ag-] {
        border-color: var(--vscode-notificationCenter-border) !important;
    }

    [class*="vscode"] .text-left {
        text-align: left;
    }

    [class*="vscode"] .text-right {
        text-align: right;
    }
    ${getDataViewerStyle()}
    ${getDataViewerColumnPanelStyle()}
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : {};
    let gridApi;
    ${getDataViewerColumnPanelScript()}
    ${getDataViewerScript()}
    const data = ${String(content).replace(/</g, '\\u003c')};
    const bigintFields = prepareViewerColumns(data.columns);
    function updateTheme() {
        if (gridApi) {
            gridApi.setGridOption('theme', getAgTheme());
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        const gridOptions = {
            ...getViewerGridOptions(${pageSize}),
            columnDefs: data.columns,
            rowData: prepareViewerRows(data.data, bigintFields),
            rowSelection: {
                mode: 'multiRow', checkboxes: false, headerCheckbox: false,
                enableClickSelection: true
            },
            onModelUpdated: event => updateViewerRowCount(event.api.getDisplayedRowCount(), data.data.length)
        };
        const gridDiv = document.querySelector('#myGrid');
        gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
        initializeViewerToolbar();
        updateTheme();
    });
    function onload() {
        updateTheme();
        const observer = new MutationObserver(function (event) {
            updateTheme();
        });
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
            childList: false,
            characterData: false
        });
    }
    </script>
</head>
<body onload='onload()'>
    ${getDataViewerToolbarHtml()}
    <div id="gridContainer">
        <div id="myGrid" style="height: 100%;"></div>
        ${getDataViewerColumnPanelHtml()}
    </div>
</body>
</html>
`;
}

export function getListHtml(
    webview: Webview,
    title: string,
    navigation?: ListViewNavigation
): string {
    const generation = ++dynamicDataViewReloadRevision;
    listViewGenerations.set(webview, generation);
    const icon = new UriIcon('open-preview-codicon');
    const darkIcon = webview.asWebviewUri(icon.dark).toString();
    const lightIcon = webview.asWebviewUri(icon.light).toString();
    const chevronIcon = webview.asWebviewUri(
        Uri.file(extensionContext.asAbsolutePath('images/icons/chevron-right.svg'))
    ).toString();
    const backIcon = webview.asWebviewUri(
        Uri.file(extensionContext.asAbsolutePath('images/icons/arrow-left.svg'))
    ).toString();
    const expandedChevronIcon = webview.asWebviewUri(
        Uri.file(extensionContext.asAbsolutePath('images/icons/chevron-down.svg'))
    ).toString();

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
    body {
        margin: 0;
        height: 100vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        color: var(--vscode-foreground);
        background-color: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
    }
    #list { flex: 1; min-height: 0; overflow: auto; }
    .navigation {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 8px;
        min-height: 28px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-breadcrumb-background, var(--vscode-editor-background));
    }
    #back { gap: 4px; padding: 4px 6px; flex-shrink: 0; border-radius: 3px; }
    #back:disabled { opacity: 0.4; cursor: default; background: transparent; }
    .back-icon, .breadcrumb-separator {
        display: inline-block;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        background-color: currentColor;
    }
    .back-icon { mask: url('${backIcon}') center / 16px 16px no-repeat; }
    .breadcrumb-separator { mask: url('${chevronIcon}') center / 16px 16px no-repeat; }
    #breadcrumbs {
        display: flex;
        align-items: center;
        gap: 2px;
        overflow-x: auto;
        color: var(--vscode-breadcrumb-foreground);
    }
    .breadcrumb { padding: 4px; white-space: nowrap; border-radius: 3px; }
    button.breadcrumb:hover { color: var(--vscode-breadcrumb-focusForeground); }
    .breadcrumb[aria-current] { color: var(--vscode-breadcrumb-activeSelectionForeground); }
    #navigation-status { padding: 0 8px; color: var(--vscode-errorForeground); }
    .item {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 28px;
        padding: 2px 8px;
    }
    .item:hover {
        background-color: var(--vscode-list-hoverBackground);
        color: var(--vscode-list-hoverForeground);
    }
    summary.item { cursor: pointer; list-style: none; }
    summary.item::-webkit-details-marker { display: none; }
    .arrow { width: 16px; height: 16px; flex-shrink: 0; }
    summary > .arrow {
        background-color: var(--vscode-icon-foreground, currentColor);
        mask: url('${chevronIcon}') center / 16px 16px no-repeat;
    }
    details[open] > summary > .arrow { mask-image: url('${expandedChevronIcon}'); }
    .children { margin-left: 24px; }
    button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .label {
        min-width: 140px;
        color: var(--vscode-symbolIcon-fieldForeground);
        white-space: nowrap;
    }
    body.vector .label {
        min-width: 64px;
    }
    body.vector .item {
        gap: 8px;
    }
    .str {
        flex: 1;
        color: var(--vscode-descriptionForeground);
        white-space: pre-wrap;
    }
    button {
        display: flex;
        align-items: center;
        border: 0;
        padding: 2px;
        color: var(--vscode-foreground);
        background: transparent;
        cursor: pointer;
        font: inherit;
    }
    button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
    }
    button img {
        width: 16px;
        height: 16px;
    }
    .load-more {
        margin: 8px;
    }
    .load-more[hidden] {
        display: none;
    }
    .light-icon {
        display: none;
    }
    body.vscode-light .dark-icon {
        display: none;
    }
    body.vscode-light .light-icon {
        display: block;
    }
    </style>
</head>
<body>
    <div class="navigation">
        <button id="back" title="Back" aria-label="Back" disabled><span class="back-icon" aria-hidden="true"></span>Back</button>
        <nav id="breadcrumbs" aria-label="Object path"></nav>
    </div>
    <div id="navigation-status" role="status"></div>
    <div id="list"></div>
    <template id="view-icon"><img class="dark-icon" src="${darkIcon}" alt=""><img class="light-icon" src="${lightIcon}" alt=""></template>
    <script>
    ${getListViewerScript(generation, navigation ?? {
        title, path: [], breadcrumbs: [{ label: title, path: [] }],
    })}
    </script>
</body>
</html>
`;
}

import * as rstudioapi from './rstudioapi';

export async function activateSession(session: Session): Promise<void> {
    activeSession = session;
    const refreshed = refreshActiveSession(session);
    if (!session.workspaceUnavailable) { scheduleWorkspaceRefresh(); }
    await refreshed;
}

async function refreshActiveSession(session: Session): Promise<void> {
    pipeClient = session.socket;
    if (!session.requester) { globalPipePath = session.pipePath; }
    pid = session.pid;
    rVer = session.rVer;
    info = session.info;
    sessionDir = session.sessionDir;
    workingDir = session.workingDir;
    workspaceData = session.workspaceData;

    if (sessionStatusBarItem) {
        const version = rVer.replace(/^R (?:version )?/, '').replace(/\s+\(.*/, '');
        sessionStatusBarItem.text = `R ${version}: ${pid}`;
        sessionStatusBarItem.tooltip = `${info.version || rVer}\nProcess ID: ${pid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to active terminal.`;
        sessionStatusBarItem.show();
    }
    rWorkspace?.refresh();
    await setContext('rSessionActive', !session.workspaceUnavailable);
}

/** Activate a connected session by its stable protocol identity. */
export async function activateSessionById(sessionId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
        return false;
    }
    const target = sessions.get(sessionId);
    if (!enableSessionWatcher && !target?.requester) { return false; }
    if (!target || (!target.requester && (!isCurrentSocket(target.socket) || target.socket.destroyed || !target.socket.writable))) {
        return false;
    }
    await activateSession(target);
    return true;
}

export function resetStatusBar(): void {
    if (sessionStatusBarItem) {
        sessionStatusBarItem.text = 'R: (not attached)';
        sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
    }
}

function isLocalHost(host: string): boolean {
    return host.length > 0 && host.toLocaleLowerCase() === os.hostname().toLocaleLowerCase();
}

async function findLocalTerminalPid(rPid: string): Promise<string | undefined> {
    for (const terminal of window.terminals) {
        const terminalPid = await terminal.processId;
        if (terminalPid !== undefined && String(terminalPid) === rPid) {
            return String(terminalPid);
        }
    }
    return undefined;
}

export async function switchSessionByTerminal(terminal: vscode.Terminal | undefined): Promise<void> {
    const terminalPid = await terminal?.processId;
    const session = terminalPid ? terminalSessions.get(String(terminalPid)) : undefined;
    if (session) {
        await activateSession(session);
    } else {
        resetStatusBar();
    }
}

function sendToSocket(socket: IpcSocket, data: Record<string, unknown>): void {
    if (!socket.destroyed) {
        socket.write(JSON.stringify(data) + '\n');
    }
}

async function handleNotification(message: Record<string, unknown>, socket: IpcSocket) {
    const method = String(message.method);
    const params = (message.params as Record<string, unknown>) || {};

    switch (method) {
        case 'attach': {
            const protocolVersion = params.protocol_version;
            const sessionId = typeof params.session_id === 'string' ? params.session_id.trim() : '';
            const host = typeof params.host === 'string' ? params.host : '';
            if (protocolVersion !== SESS_PROTOCOL_VERSION) {
                const found = protocolVersion === undefined ? 'missing' : String(protocolVersion);
                void window.showErrorMessage(`Cannot attach R session: unsupported sess protocol version ${found}; this extension requires protocol version ${SESS_PROTOCOL_VERSION}.`);
                socket.destroy();
                return;
            }
            if (!sessionId) {
                void window.showErrorMessage('Cannot attach R session: the sess attach handshake has no session_id. Update the sess package and try again.');
                socket.destroy();
                return;
            }
            if (!params.tempdir || !params.wd) {
                void window.showErrorMessage('Cannot attach R session: the sess attach handshake is missing session paths. Update the sess package and try again.');
                socket.destroy();
                return;
            }

            const boundSessionId = socket._sessionId;
            if (boundSessionId) {
                if (boundSessionId !== sessionId) {
                    void window.showErrorMessage(`Cannot attach R session ${sessionId}: this IPC connection is already bound to session ${boundSessionId}. Reconnect using a new IPC connection.`);
                    socket.destroy();
                }
                // An attach notification is only accepted once per socket. Treat a
                // repeated handshake for the same session as an idempotent no-op.
                return;
            }

            const rPid = params.pid === undefined || params.pid === null ? '' : String(params.pid);
            const terminalPid = rPid && isLocalHost(host)
                ? await findLocalTerminalPid(rPid)
                : undefined;
            const selectedTerminal = window.activeTerminal;
            const selectedTerminalPid = terminalPid ? await selectedTerminal?.processId : undefined;
            if (socket.destroyed) {
                return;
            }
            // Another attach notification on this socket may have completed while
            // local terminal association was being resolved above.
            const attachedSessionId = socket._sessionId;
            if (attachedSessionId) {
                if (attachedSessionId !== sessionId) {
                    void window.showErrorMessage(`Cannot attach R session ${sessionId}: this IPC connection is already bound to session ${attachedSessionId}. Reconnect using a new IPC connection.`);
                    socket.destroy();
                }
                return;
            }
            const previous = sessions.get(sessionId);
            if (previous) {
                for (const [key, associated] of terminalSessions.entries()) {
                    if (associated === previous) {
                        terminalSessions.delete(key);
                    }
                }
            }
            const session = new Session(
                sessionId,
                host || 'unknown',
                typeof params.sess_version === 'string' ? params.sess_version : 'unknown',
                socket._pipePath ?? globalPipePath ?? '',
                socket,
            );
            socket._sessionId = sessionId;
            if (terminalPid) {
                socket._terminalPid = Number(terminalPid);
                terminalSessions.set(terminalPid, session);
            }
            sessions.set(sessionId, session);
            if (previous && previous.socket !== socket) {
                previous.socket.destroy();
            }
            session.rVer = String(params.version);
            session.pid = rPid;
            session.info = (params.info as SessionInfo | undefined) ?? { version: session.rVer, command: '', start_time: '' };
            session.sessionDir = String(params.tempdir);
            session.workingDir = String(params.wd);

            // Reload does not trigger a terminal-selection event after every attach.
            // Prefer its connected session when a terminal reconnects in the background.
            const selectedSession = terminalPid && selectedTerminal === window.activeTerminal && selectedTerminalPid
                ? terminalSessions.get(String(selectedTerminalPid))
                : undefined;
            await activateSession(selectedSession && !selectedSession.socket.destroyed ? selectedSession : session);

            console.info(`[startSessionWatcher] attach session ${sessionId} (${host || 'unknown'}:${rPid || 'unknown'}), terminal PID: ${terminalPid ?? 'unassociated'}`);
            purgeAddinPickerItems();
            if (params.plot_url) {
                await globalPlotManager?.showHttpgdPlot(String(params.plot_url));
            }
            scheduleWorkspaceRefresh(0);
            break;
        }

        case 'workspace_updated': {
            if (socket === activeSession?.socket) {
                scheduleWorkspaceRefresh();
            }
            break;
        }
        case 'help': {
            await showHelpNotification(params);
            break;
        }
        case 'httpgd': {
            if (params.url) {
                await globalPlotManager?.showHttpgdPlot(String(params.url));
            }
            break;
        }
        case 'browser':
        case 'page_viewer':
        case 'webview': {
            if (params.url) {
                const url = String(params.url);
                const title = String(params.title ?? (method === 'browser' ? 'Browser' : method === 'page_viewer' ? 'Page Viewer' : 'Viewer'));

                const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                const configKey = method === 'page_viewer' ? 'pageViewer' : (method === 'browser' ? 'browser' : 'viewer');
                const viewerChoice = viewColumnConfig[configKey] ?? 'Active';
                const viewColumn = viewerChoice === 'Disable' ? false : viewerChoice;

                if (url.startsWith('http://') || url.startsWith('https://')) {
                    const isLocalHost = url.match(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i);
                    if (isLocalHost) {
                        const externalUri = await env.asExternalUri(Uri.parse(url));
                        await showBrowser(externalUri.toString(true), title, viewColumn);
                    } else {
                        await showBrowser(url, title, viewColumn);
                    }
                } else {
                    if (url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm')) {
                        await showWebView(url, title, viewColumn);
                    } else {
                        await showDataView('object', 'txt', title, url, String(viewColumn));
                    }
                }
            }
            break;
        }
        case 'dataview': {
            if (params.source && params.type && params.title) {
                const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                const viewer = viewColumnConfig['view'] ?? 'Two';
                if (viewer !== 'Disable') {
                    await showDataView(
                        String(params.source),
                        String(params.type),
                        String(params.title),
                        String(params.file ?? ''),
                        viewer,
                        params.view_id ? String(params.view_id) : undefined,
                        params.navigation as ListViewNavigation | undefined,
                        socket._sessionId ?? null,
                        typeof params.instance === 'number' ? params.instance : undefined,
                    );
                }
            }
            break;
        }
        case 'plot_updated': {
            void updatePlot();
            break;
        }
        case 'restart_r': {
            await restartRTerminal();
            break;
        }
        case 'rstudioapi/send_to_console': {
            await rstudioapi.sendCodeToRTerminal(String(params.code), Boolean(params.execute), Boolean(params.focus));
            break;
        }
        default:
            console.error(`[startSessionWatcher] Unsupported notification method: ${method}`);
    }
}

export async function showHelpNotification(params: Record<string, unknown>): Promise<void> {
    if (!globalRHelp || !params.requestPath) {
        return;
    }

    const viewer = config().get<Record<string, string>>('session.viewers.viewColumn')?.helpPanel ?? 'Two';
    if (viewer !== 'Disable') {
        await globalRHelp.showHelpForPath(String(params.requestPath), viewer);
    }
}

export async function handleEditorRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return handleRequest({ method, params });
}

async function handleRequest(message: Record<string, unknown>, socket?: IpcSocket) {
    if (message.method) {
        const method = String(message.method);
        const params = (message.params as Record<string, unknown>) || {};
        let result: unknown = null;
        let error: unknown = null;

        try {
            switch (method) {
                case 'rstudioapi/active_editor_context':
                    result = rstudioapi.activeEditorContext();
                    break;
                case 'rstudioapi/insert_or_modify_text':
                    await rstudioapi.insertOrModifyText(params.query as RSEditOperation[], params.id as string | null);
                    result = true;
                    break;
                case 'rstudioapi/replace_text_in_current_selection':
                    await rstudioapi.replaceTextInCurrentSelection(String(params.text), params.id as string | null);
                    result = true;
                    break;
                case 'rstudioapi/show_dialog':
                    rstudioapi.showDialog(String(params.message));
                    result = true;
                    break;
                case 'rstudioapi/show_prompt':
                    result = await rstudioapi.showPrompt(String(params.title), String(params.message), params.default as string | undefined);
                    break;
                case 'rstudioapi/ask_for_password':
                    result = await rstudioapi.askForPassword(String(params.prompt));
                    break;
                case 'rstudioapi/navigate_to_file':
                    await rstudioapi.navigateToFile(String(params.file), Number(params.line), Number(params.column));
                    result = true;
                    break;
                case 'rstudioapi/set_selection_ranges':
                    await rstudioapi.setSelections(params.ranges as RSRange[], params.id as string | null);
                    result = true;
                    break;
                case 'rstudioapi/document_save':
                    await rstudioapi.documentSave(params.id as string | null);
                    result = true;
                    break;
                case 'rstudioapi/document_save_all':
                    await rstudioapi.documentSaveAll();
                    result = true;
                    break;
                case 'rstudioapi/get_project_path':
                    result = rstudioapi.projectPath();
                    break;
                case 'rstudioapi/document_context':
                    result = await rstudioapi.documentContext(params.id as string | null);
                    break;
                case 'rstudioapi/document_new':
                    await rstudioapi.documentNew(String(params.text), String(params.type), params.position as number[]);
                    result = true;
                    break;
                case 'rstudioapi/document_close':
                    await rstudioapi.documentClose(params.id as string | null, Boolean(params.save));
                    result = true;
                    break;
                default:
                    throw new Error(`Unsupported method: ${method}`);
            }
        } catch (e) {
            error = { code: -32603, message: String(e) };
        }

        if (!socket) {
            if (error) { throw new Error(JSON.stringify(error)); }
            return result;
        }
        sendToSocket(socket, {
            jsonrpc: '2.0',
            id: message.id,
            result: result,
            error: error
        });
    }
}

export function cleanupTerminalAssociation(terminalPid: string): void {
    terminalSessions.delete(terminalPid);
}

export async function cleanupSession(sessionId: string, closingSocket?: IpcSocket): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || (closingSocket && session.socket !== closingSocket)) {
        return;
    }
    sessions.delete(sessionId);
    for (const [terminalPid, associated] of terminalSessions.entries()) {
        if (associated === session) {
            terminalSessions.delete(terminalPid);
        }
    }
    if (pipeClient === session.socket) {
        pipeClient = undefined;
    }
    if (!session.socket.destroyed && session.socket !== closingSocket) {
        session.socket.destroy();
    }
    if (activeSession === session) {
        await clearActiveSession();
    }
}

export async function sessionRequest(
    data: Record<string, unknown>, target: Session | string | null | undefined = activeSession,
): Promise<unknown> {
    try {
        const owner = typeof target === 'string' ? sessions.get(target) : target;
        if (owner?.requester) { return await owner.requester(data); }
        // An explicitly bound viewer must never fall back to the active session.
        const socket = owner?.socket ?? (target === undefined ? pipeClient : undefined);
        if (!socket || socket.destroyed) {
            throw new Error('IPC socket is not connected');
        }

        return await new Promise((resolve, reject) => {
            const id = data.id !== undefined ? Number(data.id) : Math.floor(Math.random() * 1000000);
            const payload = data.jsonrpc ? data : {
                jsonrpc: '2.0',
                id,
                ...data
            };

            pendingRequests.set(id, { resolve, reject, socket });

            try {
                socket.write(JSON.stringify(payload) + '\n');
            } catch (e) {
                pendingRequests.delete(id);
                reject(e);
            }

            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    reject(new Error('Request timed out'));
                }
            }, 5000);
        });
    } catch (error) {
        if (error instanceof Error) {
            console.log('error message: ', error.message);
        } else {
            console.log('unexpected error: ', error);
        }

        return undefined;
    }
}

export async function connectToSession(): Promise<void> {
    const command = await getAttachSessionCommand();
    void vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`R command copied to clipboard: ${command}`);
}
