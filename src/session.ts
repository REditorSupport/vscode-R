'use strict';

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { pathExists, readJson } from './fileSystem';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { commands, Uri, ViewColumn, Webview, window, env } from 'vscode';

import { restartRTerminal } from './rTerminal';
import { config, readContent, readSessSourceRevision, setContext, UriIcon } from './util';
import * as rTerminal from './rTerminal';
import { getProcessAncestors } from './processTree';
import { TerminalSessionRegistry } from './terminalSessionRegistry';
import { SessionProcessMonitor } from './sessionProcessMonitor';
import { sessionProcessIdentity } from './sessionIdentity';
import { NativeTerminalPidWaitRegistry } from './nativeTerminalPidWait';
import { purgeAddinPickerItems, RSEditOperation, RSRange } from './rstudioapi';

import { extensionContext, rWorkspace, globalRHelp, globalPlotManager, sessionStatusBarItem, enableSessionWatcher } from './extension';
import { resolveBackend, jgdEnabled, CommonPlotManager } from './plotViewer';
import type {
    RExternalTerminalIntegration,
    RSessionActivationOptions,
    RSessionConnectionChange,
    RSessionConnectionInfo,
    RSessionPreparation,
    RSessionPreparationOptions,
    RSessionReference,
} from './api';

import { showWebView } from './webViewer';
import { getListViewerScript, listViewerStyle, ListViewNavigation } from './listViewer';
import { getDataViewerScript, getDataViewerStyle, getDataViewerToolbarHtml } from './dataViewer';
import { disposeJdvHost, getJdvAddress } from './jdvViewer';
import { getFollowScript } from './viewerFollow';
import type { JdvTracking } from './jdvAdapter';
import { getDataViewerColumnPanelHtml, getDataViewerColumnPanelScript, getDataViewerColumnPanelStyle } from './dataViewerColumnPanel';
import { createViewerSessionContext, formatSessionLabel, getViewerSessionScript, ViewerSessionContext, ViewerSessionSource } from './viewerSession';
import { SessConsentChoice, SessConsentService } from './sessConsent';
import {
    assessTerminalStartup,
    parseTerminalStartupRecord,
    TerminalStartupRecord,
    TerminalStartupStatus,
} from './terminalStartup';

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
    _server?: net.Server;
}

export class Session {
    private exited = false;
    public get processExited(): boolean { return this.exited; }
    public set processExited(value: boolean) {
        this.exited = value;
        if (value) { sessionProcessMonitor.markExited(this); }
    }
    public label?: string;
    public workspaceUnavailable?: string;
    public execute?: (code: string) => Promise<void>;
    public rPath?: string;
    public libraryPaths?: string[];
    public requester?: (data: Record<string, unknown>) => Promise<unknown>;
    public connectionId?: string;
    public attachmentId?: string;
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

const SESS_PROTOCOL_VERSION = 2;

const sessions = new Map<string, Session>();
const sessionConnectionEmitter = new vscode.EventEmitter<RSessionConnectionChange>();
export const onDidChangeSessionConnection = sessionConnectionEmitter.event;
const pendingConnectionChanges: RSessionConnectionChange[] = [];
let dispatchingConnectionChanges = false;

function createSessionReference(target: Session): RSessionReference | undefined {
    if (!target.connectionId) { return undefined; }
    return Object.freeze({
        sessionId: target.sessionId,
        connectionId: target.connectionId,
        ...(target.attachmentId ? { attachmentId: target.attachmentId } : {}),
    });
}

function enqueueSessionConnectionChanges(changes: readonly RSessionConnectionChange[]): void {
    for (const change of changes) {
        pendingConnectionChanges.push(Object.freeze({
            kind: change.kind,
            session: Object.freeze({ ...change.session }),
        }));
    }
    if (dispatchingConnectionChanges) { return; }
    dispatchingConnectionChanges = true;
    try {
        while (pendingConnectionChanges.length) {
            const change = pendingConnectionChanges.shift()!;
            try { sessionConnectionEmitter.fire(change); }
            catch (error) { console.error('[SessionConnection] Listener failed', error); }
        }
    } finally {
        dispatchingConnectionChanges = false;
    }
}

function invalidateSessionConnection(target: Session): RSessionConnectionChange | undefined {
    const reference = createSessionReference(target);
    target.connectionId = undefined;
    target.attachmentId = undefined;
    return reference ? Object.freeze({ kind: 'disconnected', session: reference }) : undefined;
}

export function getSessionReference(sessionId: string): RSessionReference | undefined {
    const target = sessions.get(sessionId);
    if (!target || target.requester || !target.connectionId || target.socket._sessionId !== sessionId
        || !isLiveSessionSocket(target.socket)) { return undefined; }
    return createSessionReference(target);
}

const sessionProcessMonitor = new SessionProcessMonitor<ViewerSessionSource>(isLocalHost);
// Only the newest handshake for a stable ID may commit after terminal discovery.
interface PendingSessionAttachment {
    readonly socket: IpcSocket;
    readonly controller: AbortController;
}
const pendingSessionAttachments = new Map<string, PendingSessionAttachment>();
const terminalRegistry = new TerminalSessionRegistry<Session, vscode.Terminal>(
    target => sessions.get(target.sessionId) === target && isConnectedSession(target),
    terminal => !terminal.exitStatus && window.terminals.includes(terminal),
);
const nativeTerminalPidWaits = new NativeTerminalPidWaitRegistry<vscode.Terminal>();
const pendingManualNativePidWaits = new WeakMap<vscode.Terminal, AbortController>();
interface TerminalIntegrationRun {
    readonly cancellation: vscode.CancellationTokenSource;
    cancel(): void;
}
interface TerminalIntegrationRegistration {
    readonly terminal: vscode.Terminal;
    readonly integration: RExternalTerminalIntegration;
    readonly closeSubscription: vscode.Disposable;
    active?: TerminalIntegrationRun;
}
const terminalIntegrations = new Map<vscode.Terminal, TerminalIntegrationRegistration>();
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
    terminalRegistry.releaseSession(target);
    const current = sessions.get(target.sessionId) === target;
    if (current) { sessions.delete(target.sessionId); }
    const disconnected = current ? invalidateSessionConnection(target) : undefined;
    if (activeSession === target) { void clearActiveSession(); }
    if (disconnected) { enqueueSessionConnectionChanges([disconnected]); }
}

function clearActiveSession(): Promise<void> {
    sessionSelectionRevision++;
    deferWorkspaceRefresh();
    workspaceRefreshPending = false;
    activeSession = undefined;
    workspaceData = { search: [], loaded_namespaces: [], globalenv: {} };
    workingDir = '';
    resetStatusBar();
    rWorkspace?.refresh();
    return setContext('rSessionActive', false);
}

function isConnectedSession(target: Session): boolean {
    return Boolean(target.requester) || (Boolean(target.connectionId) && isLiveSessionSocket(target.socket)
        && isCurrentSocket(target.socket));
}

function assertExecutableSession(target: Session): void {
    if (sessions.get(target.sessionId) !== target || !isConnectedSession(target) || target.workspaceUnavailable) {
        throw new Error(target.workspaceUnavailable ?? 'This R session is no longer attached. Select an attached session in the Workspace viewer.');
    }
}

/** Workspace actions must use the process represented by the tree, even after focus changes. */
export async function executeSessionCode(target: Session, code: string): Promise<void> {
    assertExecutableSession(target);
    if (target.execute) { await target.execute(code); return; }
    const association = terminalRegistry.forSession(target);
    if (association) {
        await rTerminal.runTextInTerminal(association.terminal, code, true, () => {
            assertExecutableSession(target);
            if (!terminalRegistry.isCurrent(association)) {
                throw new Error('This R session no longer owns its attached terminal. Activate it with its terminal again.');
            }
        });
        return;
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
    terminalRegistry.releaseSession(previous);
    const current = sessions.get(previous.sessionId) === previous;
    if (current) { sessions.delete(previous.sessionId); }
    const disconnected = current ? invalidateSessionConnection(previous) : undefined;
    if (activeSession === previous) { sessionSelectionRevision++; activeSession = next; }
    if (disconnected) { enqueueSessionConnectionChanges([disconnected]); }
}

export function registerSessionTransport(id: string, host: string, directory: string,
    requester: (data: Record<string, unknown>) => Promise<unknown>): Session {
    const previous = sessions.get(id);
    const target = previous?.connectionId
        ? new Session(id, host, '', '', new net.Socket())
        : previous ?? new Session(id, host, '', '', new net.Socket());
    target.requester = requester;
    target.workingDir = directory;
    sessions.set(id, target);
    if (previous && previous !== target) {
        for (const [uri, owner] of documentSessions) {
            if (owner === previous) { documentSessions.set(uri, target); }
        }
        terminalRegistry.releaseSession(previous);
        const disconnected = invalidateSessionConnection(previous);
        if (activeSession === previous) { sessionSelectionRevision++; activeSession = target; }
        if (!previous.socket.destroyed) { previous.socket.destroy(); }
        if (disconnected) { enqueueSessionConnectionChanges([disconnected]); }
    }
    return target;
}
const SESS_SETUP_TIMEOUT = 600000;
const TERMINAL_ATTACH_TIMEOUT = 30000;

/** Read the bounded status sidecar written by the R startup helper. */
async function readTerminalStartupRecord(filePath: string, token: string): Promise<TerminalStartupRecord | undefined> {
    let file: fs.promises.FileHandle | undefined;
    try {
        file = await fsp.open(filePath, 'r');
        const buffer = Buffer.alloc(513);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 512) { return undefined; }
        return parseTerminalStartupRecord(buffer.toString('utf8', 0, bytesRead), token);
    } catch {
        return undefined;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

/**
 * Wait for this R process's setup attempt and its matching attached owner.
 * A new manual-attach attempt may satisfy a fresh wait, but can never release
 * input held by a wait that already observed a different attempt.
 */
export function waitForTerminalReady(terminal: vscode.Terminal, timeout = 30000, startupFilePath?: string,
    startupToken?: string): Promise<boolean> {
    return new Promise(resolve => {
        let settled = false;
        let observedAttemptId: string | undefined;
        let observedState: TerminalStartupStatus | undefined;
        let latestRecord: TerminalStartupRecord | undefined;
        let startupTimer: NodeJS.Timeout | undefined;
        let pendingTimer: NodeJS.Timeout | undefined;
        let attachTimer: NodeJS.Timeout | undefined;
        let pollTimer: NodeJS.Timeout | undefined;
        let checkingRecord = false;

        const finish = (ready: boolean) => {
            if (settled) { return; }
            settled = true;
            if (startupTimer) { clearTimeout(startupTimer); }
            if (pendingTimer) { clearTimeout(pendingTimer); }
            if (attachTimer) { clearTimeout(attachTimer); }
            if (pollTimer) { clearTimeout(pollTimer); }
            attached.dispose();
            closed.dispose();
            resolve(ready);
        };
        const isClosed = () => terminalRegistry.isClosed(terminal) || terminal.exitStatus !== undefined;
        const checkOwner = () => {
            if (settled) { return; }
            if (isClosed()) { finish(false); }
            else if (observedState === 'failed') { finish(false); }
            else if (!startupFilePath && terminalRegistry.ownerOf(terminal)) { finish(true); }
            else if (observedState === 'ready' && latestRecord) {
                const owner = terminalRegistry.ownerOf(terminal);
                if (assessTerminalStartup(observedAttemptId, latestRecord, owner?.pid, owner?.pipePath).readyForOwner) {
                    finish(true);
                }
            }
        };
        const setRecord = (record: TerminalStartupRecord | undefined) => {
            if (settled) { return; }
            const owner = terminalRegistry.ownerOf(terminal);
            const decision = assessTerminalStartup(observedAttemptId, record, owner?.pid, owner?.pipePath);
            const observation = decision.observation;
            if (observation === 'unknown') {
                // A read that cannot identify the current status must not leave an
                // older ready snapshot available to a later owner event.
                latestRecord = undefined;
                return;
            }
            if (observation === 'attempt-changed') {
                finish(false);
                return;
            }
            if (!record) { return; }
            latestRecord = record;
            if (observedAttemptId === undefined) { observedAttemptId = decision.attemptId; }
            if (observation === 'failed') {
                observedState = 'failed';
                finish(false);
            } else if (observation === 'pending') {
                if (observedState !== 'pending') {
                    observedState = 'pending';
                    if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
                    pendingTimer = setTimeout(() => finish(false), SESS_SETUP_TIMEOUT);
                }
            } else if (observation === 'ready') {
                if (observedState !== 'ready') {
                    observedState = 'ready';
                    if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
                    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = undefined; }
                    attachTimer = setTimeout(() => finish(false), Math.min(timeout, TERMINAL_ATTACH_TIMEOUT));
                }
                if (decision.readyForOwner) { finish(true); }
                else { checkOwner(); }
            }
        };
        const schedulePoll = (delay = 100) => {
            if (settled) { return; }
            if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
            pollTimer = setTimeout(() => {
                pollTimer = undefined;
                beginRead();
            }, delay);
        };
        const readCurrentRecord = async () => {
            if (settled || !startupFilePath || !startupToken || checkingRecord) { return; }
            checkingRecord = true;
            const ownerSnapshotIsCurrent = terminalRegistry.snapshot(terminal);
            let record: TerminalStartupRecord | undefined;
            try {
                record = await readTerminalStartupRecord(startupFilePath, startupToken);
            } finally {
                checkingRecord = false;
            }
            if (settled) { return; }
            if (!ownerSnapshotIsCurrent()) {
                // Ownership changed during the file read. Retry against the
                // current association before accepting any ready record.
                latestRecord = undefined;
                schedulePoll(0);
                return;
            }
            setRecord(record);
            if (!settled) { checkOwner(); }
            schedulePoll();
        };
        const beginRead = () => {
            void readCurrentRecord().catch(() => {
                checkingRecord = false;
                if (!settled) { latestRecord = undefined; checkOwner(); schedulePoll(); }
            });
        };
        const check = () => {
            if (settled) { return; }
            if (isClosed()) { finish(false); return; }
            if (!startupFilePath || !startupToken) { checkOwner(); return; }
            beginRead();
        };
        const attached = terminalRegistry.onDidChange(changed => { if (changed === terminal) { check(); } });
        const closed = window.onDidCloseTerminal(changed => { if (changed === terminal) { finish(false); } });

        // Missing or invalid state keeps the ordinary attachment timeout.
        startupTimer = setTimeout(() => finish(false), timeout);
        // Preserve the historical immediate path for terminals without profile setup.
        if (!startupFilePath) { checkOwner(); }
        if (startupFilePath && startupToken) {
            beginRead();
        }
        check();
    });
}
export let activeSession: Session | undefined;
// Older terminal lookups must not overwrite a newer selection or activation.
let sessionSelectionRevision = 0;
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
    documentGeneration: number;
    startRow?: number;
    endRow?: number;
    sortModel?: unknown[];
    filterModel?: Record<string, unknown>;
}

const dynamicDataViewPanels = new Map<string, vscode.WebviewPanel>();
const dynamicDataViewStateGenerations = new WeakMap<vscode.WebviewPanel, number>();
const documentGenerations = new WeakMap<Webview, number>();
let documentGenerationRevision = 0;

/** The generation of the HTML document currently loaded in a viewer webview. */
export function getDocumentGeneration(webview: Webview): number | undefined {
    return documentGenerations.get(webview);
}

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
    stateGeneration?: number,
): void {
    // The panel's webview getter throws once onDidDispose fires.
    const webview = panel.webview;
    dynamicDataViewPanels.set(key, panel);
    if (stateGeneration !== undefined) {
        dynamicDataViewStateGenerations.set(panel, stateGeneration);
    }
    panel.onDidDispose(() => {
        documentGenerations.delete(webview);
        const currentStateGeneration = dynamicDataViewStateGenerations.get(panel);
        dynamicDataViewStateGenerations.delete(panel);
        if (dynamicDataViewPanels.get(key) !== panel) {
            return;
        }
        dynamicDataViewPanels.delete(key);
        // Interactive transcripts retain this handle after the expanded viewer closes.
        if (currentStateGeneration === undefined && sessions.get(sessionId ?? '')?.requester) { return; }
        void sessionRequest({
            method: 'dataview_dispose',
            params: { view_id: viewId, state_generation: currentStateGeneration },
        }, sessionId);
    });
}

function attachDynamicDataViewBridge(panel: vscode.WebviewPanel, viewId: string, sessionId: string | null): void {
    const webview = panel.webview;
    const postResponse = (
        documentGeneration: number, requestId: number, ok: boolean, result?: unknown, error?: string
    ) => {
        if (documentGeneration !== documentGenerations.get(webview)) {
            return;
        }
        void webview.postMessage({
            message: 'dataview/response',
            documentGeneration,
            requestId,
            ok,
            result,
            error,
        });
    };

    webview.onDidReceiveMessage(async (raw: unknown) => {
        const msg = raw as Partial<DataViewRequestMessage>;
        if (msg.message !== 'dataview/request' || typeof msg.requestId !== 'number' ||
            typeof msg.documentGeneration !== 'number' ||
            msg.documentGeneration !== documentGenerations.get(webview)) {
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
                postResponse(msg.documentGeneration, msg.requestId, true, result);
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
                postResponse(msg.documentGeneration, msg.requestId, true, result);
                return;
            }

            postResponse(msg.documentGeneration, msg.requestId, false, undefined, `Unsupported dataview action: ${String(msg.action)}`);
        } catch (e) {
            postResponse(msg.documentGeneration, msg.requestId, false, undefined, e instanceof Error ? e.message : String(e));
        }
    });
}

export function deploySessionWatcher(extensionPath: string): void {
    if (attachmentLifecycleStopping) {
        // A new activation must not inherit endpoints being torn down by the prior host lifecycle.
        globalSessionServer = undefined;
        globalSessionServerStartup = undefined;
        globalPipePath = undefined;
        attachConsentService = undefined;
        attachConsentDirectory = undefined;
        attachConsentStartup = undefined;
        attachSessionScriptPath = undefined;
    }
    attachmentLifecycleGeneration++;
    attachmentLifecycleStopping = false;
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
    const target = socket._sessionId ? sessions.get(socket._sessionId) : undefined;
    return Boolean(target?.connectionId && target.socket === socket && isLiveSessionSocket(socket));
}

function isLiveSessionSocket(socket: IpcSocket): boolean {
    return Boolean(globalSessionServer && !attachmentLifecycleStopping && socket._server === globalSessionServer
        && !socket.destroyed && socket.writable);
}

const pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    socket: IpcSocket;
}>();

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
let attachConsentDirectory: string | undefined;
let attachConsentService: SessConsentService | undefined;
let attachConsentStartup: Promise<string> | undefined;
let attachmentLifecycleGeneration = 0;
let attachmentLifecycleStopping = false;
let attachScriptPublication: Promise<void> = Promise.resolve();
const preparedAttachmentScripts = new Set<string>();
const pendingAttachmentPreparations = new Set<Promise<unknown>>();
const SESS_INSTALL_PROMPT_DISMISSED_REVISION = 'sessInstallPromptDismissedRevision';

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
    return terminalRegistry.isClosed(terminal);
}

function isLiveTerminal(terminal: vscode.Terminal): boolean {
    return terminalRegistry.isLive(terminal);
}

/** Called for every terminal close, including extension-owned pseudoterminals. */
export function cleanupTerminalBinding(terminal: vscode.Terminal): void {
    nativeTerminalPidWaits.invalidate(terminal);
    pendingManualNativePidWaits.get(terminal)?.abort();
    terminalRegistry.closeTerminal(terminal);
    removeTerminalIntegration(terminal);
}

function removeTerminalIntegration(terminal: vscode.Terminal): void {
    removeTerminalIntegrationRegistration(terminalIntegrations.get(terminal));
}

function removeTerminalIntegrationRegistration(registration: TerminalIntegrationRegistration | undefined): void {
    if (!registration) { return; }
    if (terminalIntegrations.get(registration.terminal) !== registration) { return; }
    // Remove ownership before canceling: cancellation listeners may synchronously
    // attempt a new registration or start another attach operation.
    terminalIntegrations.delete(registration.terminal);
    registration.closeSubscription.dispose();
    if (window.activeTerminal === registration.terminal) { sessionSelectionRevision++; }
    registration.active?.cancel();
}

function revokeTerminalIntegrationSnapshot(registrations: readonly TerminalIntegrationRegistration[]): void {
    for (const registration of registrations) {
        if (terminalIntegrations.get(registration.terminal) === registration) {
            terminalIntegrations.delete(registration.terminal);
        }
    }
    for (const registration of registrations) {
        registration.closeSubscription.dispose();
    }
    if (registrations.some(registration => window.activeTerminal === registration.terminal)) {
        sessionSelectionRevision++;
    }
    for (const registration of registrations) {
        registration.active?.cancel();
    }
}

export function registerTerminalIntegration(
    terminal: vscode.Terminal,
    integration: RExternalTerminalIntegration,
): vscode.Disposable {
    if (attachmentLifecycleStopping) {
        throw new Error('Cannot register a terminal integration while the session watcher is shutting down.');
    }
    if (!terminal || !terminalRegistry.isLive(terminal)) {
        throw new Error('Cannot register an integration for a closed or unavailable terminal.');
    }
    if (terminalIntegrations.has(terminal)) {
        throw new Error('A terminal integration is already registered for this terminal.');
    }
    if (!integration || typeof integration.attach !== 'function') {
        throw new TypeError('A terminal integration must provide an attach(token) function.');
    }
    const registration: TerminalIntegrationRegistration = {
        terminal,
        integration,
        closeSubscription: window.onDidCloseTerminal(changed => {
            if (changed === terminal) { cleanupTerminalBinding(terminal); }
        }),
    };
    terminalIntegrations.set(terminal, registration);
    nativeTerminalPidWaits.invalidate(terminal);
    // Invalidate an earlier native PID/command path that may still be awaiting I/O.
    if (window.activeTerminal === terminal) { sessionSelectionRevision++; }
    return { dispose: () => removeTerminalIntegrationRegistration(registration) };
}

/**
 * Delete the discovery file owned by a terminal that VS Code confirms has ended.
 * Missing exit reasons are intentionally handled by the caller as uncertain because
 * VS Code also closes terminals while preserving them for a window reload.
 */
export async function removeTerminalDiscoveryFile(terminal: vscode.Terminal): Promise<void> {
    terminalRegistry.closeTerminal(terminal);

    await queueTerminalDiscoveryOperation(terminal, async () => {
        let discoveryPath = terminalDiscoveryPath(terminal);
        if (!discoveryPath) {
            const terminalPid = await terminal.processId;
            if (terminalPid !== undefined) {
                discoveryPath = await findDiscoveryFileForTerminal(terminalPid);
            }
        }

        if (discoveryPath) {
            await Promise.all([
                fsp.rm(discoveryPath, { recursive: true, force: true }),
                fsp.rm(`${discoveryPath}.startup`, { force: true }),
            ]);
        }
    });
}

export async function createSessionDiscoveryFile(endpoint: string): Promise<string> {
    const discoveryDir = getSessionDiscoveryDir();
    await fsp.mkdir(discoveryDir, { recursive: true });
    const filePath = path.join(discoveryDir, `${crypto.randomBytes(16).toString('hex')}.json`);
    try {
        await writeSessionDiscoveryFile(filePath, endpoint);
        return filePath;
    } catch (error) {
        await fsp.rm(filePath, { recursive: true, force: true }).catch(cleanupError => {
            console.error('Failed to clean incomplete session discovery file', cleanupError);
        });
        throw error;
    }
}

async function writeSessionDiscoveryFile(
    filePath: string,
    endpoint: string,
    terminalPid?: number,
    shouldPublish: () => boolean = () => true,
): Promise<void> {
    if (!isExtensionDiscoveryPath(filePath)) {
        throw new Error('Refusing to write session discovery data outside extension global storage');
    }
    if (!shouldPublish()) { return; }
    const data: SessionDiscoveryFile = { version: 1, endpoint, jgdSocket: getSessionJgdSocket() };
    if (terminalPid !== undefined) {
        data.terminalPid = terminalPid;
    } else if (await pathExists(filePath)) {
        const existing = await readJson(filePath) as Partial<SessionDiscoveryFile>;
        if (typeof existing.terminalPid === 'number') {
            data.terminalPid = existing.terminalPid;
        }
        if (!shouldPublish()) { return; }
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let published = false;
    try {
        await fsp.writeFile(temporaryPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
        await setOwnerOnlyPermissions(temporaryPath);
        if (!shouldPublish()) { return; }
        await fsp.rename(temporaryPath, filePath);
        published = true;
    } finally {
        if (!published) { await fsp.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined); }
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
    isCurrent: () => boolean = () => true,
): Promise<void> {
    await queueTerminalDiscoveryOperation(terminal, async () => {
        if (!isTerminalClosed(terminal) && isCurrent()) {
            await writeSessionDiscoveryFile(filePath, endpoint, terminalPid, isCurrent);
        }
    });
}

async function findDiscoveryFileForTerminal(terminalPid: number): Promise<string | undefined> {
    const discoveryDir = getSessionDiscoveryDir();
    if (!await pathExists(discoveryDir)) {
        return undefined;
    }
    const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const file of await fsp.readdir(discoveryDir)) {
        if (!file.endsWith('.json')) {
            continue;
        }
        const filePath = path.join(discoveryDir, file);
        if (!isExtensionDiscoveryPath(filePath)) {
            continue;
        }
        try {
            const discovery = await readJson(filePath) as Partial<SessionDiscoveryFile>;
            if (discovery.version === 1 && discovery.terminalPid === terminalPid && typeof discovery.endpoint === 'string') {
                const stat = await fsp.stat(filePath);
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
    const generation = attachmentLifecycleGeneration;
    if (attachmentLifecycleStopping) { return; }
    for (const term of terminals) {
        if (generation !== attachmentLifecycleGeneration || attachmentLifecycleStopping) { return; }
        if (!isNativeTerminalEligible(term)) {
            continue;
        }
        const envPath = terminalDiscoveryPath(term);
        const pidWait = await nativeTerminalPidWaits.waitFor(term, () => term.processId, {
            isEligible: () => isNativeTerminalEligible(term),
        });
        if (pidWait.kind === 'invalidated') {
            if (pidWait.reason === 'lifecycle') { return; }
            continue;
        }
        const terminalPid = pidWait.value;
        const isCurrent = () => generation === attachmentLifecycleGeneration
            && !attachmentLifecycleStopping && pidWait.isCurrent() && isNativeTerminalEligible(term);
        if (!terminalPid || !isCurrent()) {
            continue;
        }
        let discoveryPath = envPath;
        discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
        if (discoveryPath && isCurrent()) {
            await updateTerminalSessionDiscoveryFile(term, discoveryPath, pipePath, terminalPid, isCurrent);
        }
    }
}

export async function updateTerminalDiscovery(terminal: vscode.Terminal): Promise<void> {
    const generation = attachmentLifecycleGeneration;
    const endpoint = globalPipePath;
    if (!endpoint || attachmentLifecycleStopping || !isNativeTerminalEligible(terminal)) {
        return;
    }
    const pidWait = await nativeTerminalPidWaits.waitFor(terminal, () => terminal.processId, {
        isEligible: () => isNativeTerminalEligible(terminal),
    });
    if (pidWait.kind === 'invalidated') {
        return;
    }
    const terminalPid = pidWait.value;
    const isCurrent = () => generation === attachmentLifecycleGeneration && !attachmentLifecycleStopping
        && endpoint === globalPipePath && pidWait.isCurrent() && isNativeTerminalEligible(terminal);
    if (terminalPid === undefined || !isCurrent()) { return; }
    let discoveryPath = terminalDiscoveryPath(terminal);
    discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
    if (discoveryPath && isCurrent()) {
        await updateTerminalSessionDiscoveryFile(terminal, discoveryPath, endpoint, terminalPid, isCurrent);
    }
}

async function setOwnerOnlyPermissions(filePath: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }

    await fsp.chmod(filePath, 0o600);
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
    const generation = attachmentLifecycleGeneration;
    if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher is shutting down.'); }
    if (globalPipePath) {
        return globalPipePath;
    }

    if (!globalSessionServerStartup) {
        const startup = startGlobalSessionServer(generation).catch((err: unknown) => {
            if (globalSessionServerStartup === startup) { globalSessionServerStartup = undefined; }
            throw err;
        });
        globalSessionServerStartup = startup;
    }
    const endpoint = await globalSessionServerStartup;
    if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher shut down while starting its IPC server.'); }
    return endpoint;
}

function startGlobalSessionServer(generation: number): Promise<string> {
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
            socket._server = server;
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
                for (const [id, pending] of pendingSessionAttachments) {
                    if (pending.socket === socket) {
                        pendingSessionAttachments.delete(id);
                        pending.controller.abort();
                    }
                }
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
                    if (!isAttachmentLifecycleCurrent(generation)) {
                        failStartup(new Error('The session watcher shut down while starting its IPC server.'));
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
    let escaped = '';
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (character === '\\') { escaped += '\\\\'; }
        else if (character === '"') { escaped += '\\"'; }
        else if (character === '\n') { escaped += '\\n'; }
        else if (character === '\r') { escaped += '\\r'; }
        else if (character === '\t') { escaped += '\\t'; }
        else if (code < 0x20 || code === 0x7f) { escaped += `\\${code.toString(8).padStart(3, '0')}`; }
        else { escaped += character; }
    }
    return `"${escaped}"`;
}

/** Whether the data viewer should follow the variable passed to View(); on unless disabled. */
export function trackVariablesSetting(resource?: vscode.Uri): boolean {
    return config(resource).get<boolean>('session.viewers.trackVariables') !== false;
}

function getAttachSessionScriptPath(pipePath: string): string {
    const scriptBase = path.basename(pipePath).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'attach_session';
    return path.join(extensionContext.globalStorageUri.fsPath, 'tmp', 'attach', `${scriptBase}.R`);
}

function buildAttachSessionScript(pipePath: string, sessPath: string, consentDirectory: string,
    attachment?: { attachmentId: string; autoActivate: boolean }): string {
    const backend = resolveBackend();
    const jgdSocket = getSessionJgdSocket();
    return [
        'local({',
        '  tryCatch({',
        '    attached <- local({',
        `  endpoint <- ${asRStringLiteral(pipePath)}`,
        `  sess_src <- ${asRStringLiteral(sessPath)}`,
        `  managed_root <- ${asRStringLiteral(path.join(extensionContext.globalStorageUri.fsPath, 'sess').replace(/\\/g, '/'))}`,
        `  consent_dir <- ${asRStringLiteral(consentDirectory.replace(/\\/g, '/'))}`,
        `  source_helper <- ${asRStringLiteral(extensionContext.asAbsolutePath(path.join('R', 'sess_source.R')).replace(/\\/g, '/'))}`,
        `  installer_helper <- ${asRStringLiteral(extensionContext.asAbsolutePath(path.join('R', 'sess-package-install.R')).replace(/\\/g, '/'))}`,
        `  startup_helper <- ${asRStringLiteral(extensionContext.asAbsolutePath(path.join('R', 'terminal-startup.R')).replace(/\\/g, '/'))}`,
        `  attach_helper <- ${asRStringLiteral(extensionContext.asAbsolutePath(path.join('R', 'attach_sess.R')).replace(/\\/g, '/'))}`,
        ...(backend === 'native' ? [] : [
            jgdSocket ? `  Sys.setenv(JGD_SOCKET = ${asRStringLiteral(jgdSocket)})` : '  Sys.unsetenv("JGD_SOCKET")',
        ]),
        '  source(startup_helper, local = TRUE)',
        '  source(attach_helper, local = TRUE)',
        `  vscode_r_attach_sess(endpoint, sess_src, managed_root, consent_dir, source_helper, installer_helper, ${asRStringLiteral(backend)}, use_rstudioapi = ${config().get<boolean>('session.emulateRStudioAPI') ? 'TRUE' : 'FALSE'}, track_variables = ${trackVariablesSetting() ? 'TRUE' : 'FALSE'}${attachment ? `, attachment_id = ${asRStringLiteral(attachment.attachmentId)}, auto_activate = ${attachment.autoActivate ? 'TRUE' : 'FALSE'}` : ''})`,
        '    })',
        '    invisible(isTRUE(attached))',
        '  }, error = function(error) {',
        '    message("vscode-R could not prepare the session watcher: ", conditionMessage(error))',
        '    invisible(FALSE)',
        '  }, interrupt = function(error) {',
        '    message("vscode-R session watcher preparation was interrupted; you can continue using this R session.")',
        '    invisible(FALSE)',
        '  })',
        '})',
        '',
    ].join('\n');
}

function isAttachmentLifecycleCurrent(generation: number): boolean {
    return !attachmentLifecycleStopping && generation === attachmentLifecycleGeneration;
}

async function ensureAttachSessConsentService(generation = attachmentLifecycleGeneration): Promise<string> {
    if (!isAttachmentLifecycleCurrent(generation)) {
        throw new Error('The session watcher is shutting down.');
    }
    if (attachConsentStartup) { return attachConsentStartup; }
    if (attachConsentService && attachConsentDirectory) { return attachConsentDirectory; }

    const startup = (async (): Promise<string> => {
        const directory = path.join(extensionContext.globalStorageUri.fsPath, 'tmp', 'attach', 'consent', crypto.randomBytes(16).toString('hex'));
        const sessDescription = await readContent(
            extensionContext.asAbsolutePath(path.join('dist', 'resources', 'sess', 'DESCRIPTION')), 'utf8');
        const sourceRevision = readSessSourceRevision(sessDescription);
        if (!sourceRevision) {
            throw new Error('The bundled sess package has no valid source revision.');
        }
        const service = new SessConsentService({
            directory,
            expectedRevision: sourceRevision,
            isEnabled: () => config().get<boolean>('sessionWatcher') === true,
            getDismissedRevision: () => {
                const value = extensionContext.globalState.get<unknown>(SESS_INSTALL_PROMPT_DISMISSED_REVISION);
                return typeof value === 'string' ? value : undefined;
            },
            rememberDismissedRevision: async revision => {
                await Promise.resolve(extensionContext.globalState.update(SESS_INSTALL_PROMPT_DISMISSED_REVISION, revision));
            },
            prompt: async request => {
                const mismatch = request.reason === 'mismatch';
                const message = mismatch
                    ? 'The installed sess does not match this build of vscode-R. Install the bundled copy in a vscode-R-managed library? Your existing sess installation will not be modified. “Don’t ask again” applies to this bundled sess revision.'
                    : 'vscode-R needs bundled sess to attach the session watcher. Install it in a vscode-R-managed library? Your existing sess installation will not be modified. “Don’t ask again” applies to this bundled sess revision.';
                const choice = await window.showWarningMessage(
                    message, 'Install bundled sess', 'Not now', "Don't ask again");
                const choices: Record<string, SessConsentChoice> = {
                    'Install bundled sess': 'install',
                    'Not now': 'notNow',
                    "Don't ask again": 'dontAskAgain',
                };
                return choices[choice ?? ''] ?? 'dismiss';
            },
        });
        try {
            await service.start();
            if (!isAttachmentLifecycleCurrent(generation)) {
                await service.stop();
                await removePathIfExists(directory);
                throw new Error('The session watcher shut down while preparing sess consent.');
            }
            attachConsentDirectory = directory;
            attachConsentService = service;
            return directory;
        } catch (error) {
            await service.stop();
            await removePathIfExists(directory);
            throw error;
        }
    })();
    attachConsentStartup = startup;
    try {
        return await startup;
    } catch (error) {
        if (attachConsentStartup === startup) { attachConsentStartup = undefined; }
        throw error;
    }
}

export async function getSessConsentDirectory(): Promise<string> {
    return ensureAttachSessConsentService();
}

function validateAttachmentEndpoint(endpoint: unknown): asserts endpoint is string {
    if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.includes('\0')) {
        throw new TypeError('A non-empty local sess IPC endpoint is required.');
    }
    const localNamedPipe = /^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/i.test(endpoint);
    const valid = process.platform === 'win32'
        ? localNamedPipe
        : path.isAbsolute(endpoint);
    if (!valid) {
        throw new TypeError('The sess IPC endpoint must be a local absolute path or Windows named pipe.');
    }
}

function makeAttachmentScriptPath(): string {
    return path.join(extensionContext.globalStorageUri.fsPath, 'tmp', 'attach', `consumer-${crypto.randomBytes(16).toString('hex')}.R`);
}

/** Prepare the managed sess bootstrap for an R process owned by a downstream consumer. */
async function prepareAttachmentCore(options?: RSessionPreparationOptions): Promise<RSessionPreparation | undefined> {
    if (!enableSessionWatcher) { return undefined; }
    if (options?.autoActivate !== undefined && typeof options.autoActivate !== 'boolean') {
        throw new TypeError('autoActivate must be a boolean.');
    }
    const connection = options?.connection;
    if (connection && connection.transport !== 'sess') {
        throw new TypeError('Only the sess transport is supported.');
    }
    const generation = attachmentLifecycleGeneration;
    if (!isAttachmentLifecycleCurrent(generation)) {
        throw new Error('The session watcher is shutting down.');
    }
    const endpoint = connection ? connection.endpoint : await getGlobalPipePath();
    validateAttachmentEndpoint(endpoint);
    const sessPath = extensionContext.asAbsolutePath(path.join('dist', 'resources', 'sess')).replace(/\\/g, '/');
    const consentDirectory = await ensureAttachSessConsentService(generation);
    if (!isAttachmentLifecycleCurrent(generation)) {
        throw new Error('The session watcher shut down while preparing sess attachment.');
    }
    const attachmentId = crypto.randomBytes(16).toString('hex');
    const autoActivate = options?.autoActivate ?? true;
    const scriptPath = makeAttachmentScriptPath();
    await fsp.mkdir(path.dirname(scriptPath), { recursive: true });
    const temporaryPath = `${scriptPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(temporaryPath, buildAttachSessionScript(endpoint, sessPath, consentDirectory, { attachmentId, autoActivate }), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        await setOwnerOnlyPermissions(temporaryPath);
        if (!isAttachmentLifecycleCurrent(generation)) {
            throw new Error('The session watcher shut down while publishing sess attachment.');
        }
        await fsp.rename(temporaryPath, scriptPath);
        if (!isAttachmentLifecycleCurrent(generation)) {
            await removePathIfExists(scriptPath);
            throw new Error('The session watcher shut down while publishing sess attachment.');
        }
        preparedAttachmentScripts.add(scriptPath);
        let disposed = false;
        return Object.freeze({
            attachmentId,
            scriptPath,
            command: `source(${asRStringLiteral(scriptPath)})`,
            dispose: () => {
                if (disposed) { return; }
                disposed = true;
                preparedAttachmentScripts.delete(scriptPath);
                const cleanup = removePathIfExists(scriptPath);
                pendingAttachmentPreparations.add(cleanup);
                void cleanup.finally(() => pendingAttachmentPreparations.delete(cleanup)).catch(() => undefined);
            },
        });
    } catch (error) {
        await removePathIfExists(temporaryPath);
        await removePathIfExists(scriptPath);
        throw error;
    }
}

export function prepareAttachment(options?: RSessionPreparationOptions): Promise<RSessionPreparation | undefined> {
    const preparation = prepareAttachmentCore(options);
    pendingAttachmentPreparations.add(preparation);
    void preparation.finally(() => pendingAttachmentPreparations.delete(preparation)).catch(() => undefined);
    return preparation;
}

async function getAttachSessionCommandCore(): Promise<string> {
    const generation = attachmentLifecycleGeneration;
    if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher is shutting down.'); }
    const pipePath = await getGlobalPipePath();
    const sessPath = extensionContext.asAbsolutePath(path.join('dist', 'resources', 'sess')).replace(/\\/g, '/');
    const consentDirectory = await ensureAttachSessConsentService(generation);
    if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher is shutting down.'); }
    const scriptPath = getAttachSessionScriptPath(pipePath);
    await fsp.mkdir(path.dirname(scriptPath), { recursive: true });
    const publish = attachScriptPublication.catch(() => undefined).then(async () => {
        if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher is shutting down.'); }
        const temporaryPath = `${scriptPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        let published = false;
        try {
            await fsp.writeFile(temporaryPath, buildAttachSessionScript(pipePath, sessPath, consentDirectory), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
            await setOwnerOnlyPermissions(temporaryPath);
            if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher is shutting down.'); }
            await fsp.rename(temporaryPath, scriptPath);
            published = true;
            if (!isAttachmentLifecycleCurrent(generation)) { throw new Error('The session watcher shut down while publishing attach command.'); }
            // Keep this check and ownership registration synchronous so shutdown cannot miss the script.
            attachSessionScriptPath = scriptPath;
        } catch (error) {
            await removePathIfExists(temporaryPath);
            if (published && !isAttachmentLifecycleCurrent(generation)) { await removePathIfExists(scriptPath); }
            throw error;
        }
    });
    attachScriptPublication = publish;
    await publish;
    if (!isAttachmentLifecycleCurrent(generation)) {
        throw new Error('The session watcher shut down before returning the attach command.');
    }

    return `source(${asRStringLiteral(scriptPath)})`;
}

export function getAttachSessionCommand(): Promise<string> {
    const operation = getAttachSessionCommandCore();
    pendingAttachmentPreparations.add(operation);
    void operation.finally(() => pendingAttachmentPreparations.delete(operation)).catch(() => undefined);
    return operation;
}

async function removePathIfExists(pathLike: string): Promise<void> {
    try {
        if (await pathExists(pathLike)) {
            await fsp.rm(pathLike, { recursive: true, force: true });
        }
    } catch (e) {
        console.warn(`[session cleanup] Failed to remove ${pathLike}`, e);
    }
}

export async function shutdownSessionWatcher(): Promise<void> {
    nativeTerminalPidWaits.invalidateAll();
    attachmentLifecycleGeneration++;
    attachmentLifecycleStopping = true;
    const terminalIntegrationSnapshot = [...terminalIntegrations.values()];
    const shutdownGeneration = attachmentLifecycleGeneration;
    const consentStartup = attachConsentStartup;
    const consentService = attachConsentService;
    const consentDirectory = attachConsentDirectory;
    const serverStartup = globalSessionServerStartup;
    const pipePathAtShutdown = globalPipePath;
    const serverAtShutdown = globalSessionServer;
    const manualScriptPath = attachSessionScriptPath;
    const preparationScripts = [...preparedAttachmentScripts];
    const pendingOperations = [...pendingAttachmentPreparations];
    const sessionsAtShutdown = serverAtShutdown
        ? [...sessions.values()].filter(target => target.socket._server === serverAtShutdown)
        : [];
    const shutdownChanges: RSessionConnectionChange[] = [];
    let clearActive = false;
    for (const target of sessionsAtShutdown) {
        if (sessions.get(target.sessionId) !== target) { continue; }
        sessions.delete(target.sessionId);
        terminalRegistry.releaseSession(target);
        const disconnected = invalidateSessionConnection(target);
        if (disconnected) { shutdownChanges.push(disconnected); }
        if (activeSession === target) { clearActive = true; }
    }
    if (clearActive) { void clearActiveSession(); }
    for (const [sessionId, pending] of pendingSessionAttachments) {
        if (pending.socket._server === serverAtShutdown) {
            pendingSessionAttachments.delete(sessionId);
            pending.controller.abort();
        }
    }
    // Queue removal of the fixed manual-attach path before a redeployed lifecycle
    // can publish a replacement at the same path.
    const manualCleanup = attachScriptPublication.catch(() => undefined).then(async () => {
        if (manualScriptPath) { await removePathIfExists(manualScriptPath); }
    });
    attachScriptPublication = manualCleanup;
    // Snapshot and revoke before notifying; listeners may redeploy synchronously.
    sessionSelectionRevision++;
    revokeTerminalIntegrationSnapshot(terminalIntegrationSnapshot);
    enqueueSessionConnectionChanges(shutdownChanges);
    await Promise.allSettled(pendingOperations);
    await manualCleanup.catch(() => undefined);
    await consentStartup?.catch(() => undefined);
    await consentService?.stop();
    if (attachConsentService === consentService) { attachConsentService = undefined; }
    if (consentDirectory) {
        await removePathIfExists(consentDirectory);
        if (attachConsentDirectory === consentDirectory) { attachConsentDirectory = undefined; }
    }
    if (attachConsentStartup === consentStartup) { attachConsentStartup = undefined; }
    // Await the startup snapshot so a server published by it can be closed below.
    await serverStartup?.catch(() => undefined);
    const pipePath = pipePathAtShutdown;
    const server = serverAtShutdown;

    const oldSockets = server ? [...activeConnections].filter(socket => socket._server === server) : [];
    for (const socket of oldSockets) {
        socket.destroy();
        for (const [sessionId, pending] of pendingSessionAttachments) {
            if (pending.socket === socket) {
                pendingSessionAttachments.delete(sessionId);
                pending.controller.abort();
            }
        }
    }
    if (pipeClient && pipeClient._server === server) { pipeClient = undefined; }

    if (server) {
        await new Promise<void>((resolve) => {
            try {
                server.close(() => resolve());
            } catch {
                resolve();
            }
        });
        if (globalSessionServer === server) { globalSessionServer = undefined; }
    }

    for (const scriptPath of preparationScripts) {
        await removePathIfExists(scriptPath);
        preparedAttachmentScripts.delete(scriptPath);
    }

    if (pipePath && pipePath.endsWith('.sock')) {
        await removePathIfExists(pipePath);
    }

    if (attachmentLifecycleGeneration === shutdownGeneration) {
        if (globalPipePath === pipePath) { globalPipePath = undefined; }
        if (globalSessionServerStartup === serverStartup) { globalSessionServerStartup = undefined; }
        if (attachSessionScriptPath === manualScriptPath) { attachSessionScriptPath = undefined; }
        attachScriptPublication = Promise.resolve();
    }
}

export async function activateRSession(): Promise<void> {
    const lifecycleGeneration = attachmentLifecycleGeneration;
    if (!config().get<boolean>('sessionWatcher')) {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
        return;
    }
    const terminal = window.activeTerminal;
    const focusOwner = (): Promise<void> | undefined => {
        const owner = terminalRegistry.ownerOf(terminal);
        if (!terminal || !owner) { return undefined; }
        const activating = activateSession(owner);
        const activationRevision = sessionSelectionRevision;
        return activating.then(() => {
            if (activationRevision === sessionSelectionRevision && terminalRegistry.ownerOf(terminal) === owner) {
                terminal.show();
            }
        });
    };
    const registration = terminal ? terminalIntegrations.get(terminal) : undefined;
    if (registration?.active) {
        void window.showInformationMessage('An R session attach is already in progress for this terminal.');
        return;
    }
    if (terminal) { pendingManualNativePidWaits.get(terminal)?.abort(); }
    const focused = focusOwner();
    if (focused) { await focused; return; }

    if (terminal) {
        if (registration) {
            if (!isLiveTerminal(terminal) || window.activeTerminal !== terminal) { return; }
            // Supersede native attach operations that may still be waiting for PID or command I/O.
            sessionSelectionRevision++;
            const integrationSelectionRevision = sessionSelectionRevision;
            const cancellation = new vscode.CancellationTokenSource();
            let focusSubscription: vscode.Disposable = { dispose: () => undefined };
            const run: TerminalIntegrationRun = {
                cancellation,
                cancel: () => {
                    focusSubscription.dispose();
                    cancellation.cancel();
                },
            };
            registration.active = run;
            focusSubscription = window.onDidChangeActiveTerminal(changed => {
                if (changed !== terminal) { run.cancel(); }
            });
            const isCurrentIntegration = () => terminalIntegrations.get(terminal) === registration
                && registration.active === run
                && !cancellation.token.isCancellationRequested
                && isLiveTerminal(terminal)
                && window.activeTerminal === terminal;
            try {
                if (!isCurrentIntegration()) { return; }
                const attached = await registration.integration.attach(cancellation.token);
                if (!isCurrentIntegration()) { return; }
                if (attached !== true) { return; }
                const owner = terminalRegistry.ownerOf(terminal);
                if (!owner) {
                    void window.showErrorMessage('The external R terminal reported a successful attach but has no current session binding.');
                    return;
                }
                if (sessionSelectionRevision !== integrationSelectionRevision && activeSession !== owner) { return; }
                const activation = activeSession === owner ? Promise.resolve() : activateSession(owner);
                const activationRevision = sessionSelectionRevision;
                await activation;
                if (sessionSelectionRevision !== activationRevision) { return; }
                if (!isCurrentIntegration() || terminalRegistry.ownerOf(terminal) !== owner) { return; }
                terminal.show();
            } catch (error) {
                if (isCurrentIntegration()) {
                    const detail = error instanceof Error ? error.message : String(error);
                    void window.showErrorMessage(`Failed to attach the R session in this external terminal: ${detail}`);
                }
            } finally {
                focusSubscription.dispose();
                cancellation.dispose();
                if (registration.active === run) { registration.active = undefined; }
            }
            return;
        }
    }

    const selectionRevision = ++sessionSelectionRevision;
    let nativePidWaitIsCurrent = () => true;
    const isCurrent = () => lifecycleGeneration === attachmentLifecycleGeneration
        && !attachmentLifecycleStopping
        && selectionRevision === sessionSelectionRevision && terminal === window.activeTerminal
        && nativePidWaitIsCurrent()
        && (!terminal || (!isTerminalClosed(terminal) && !terminal.exitStatus));

    let discoveryPath = terminal && terminalDiscoveryPath(terminal);
    if (terminal && !discoveryPath) {
        const controller = new AbortController();
        pendingManualNativePidWaits.set(terminal, controller);
        const focusSubscription = window.onDidChangeActiveTerminal(changed => {
            if (changed !== terminal) { controller.abort(); }
        });
        let terminalPid: number | undefined;
        try {
            if (!isCurrent()) { return; }
            const pidWait = await nativeTerminalPidWaits.waitFor(terminal, () => terminal.processId, {
                signal: controller.signal,
                isEligible: () => isNativeTerminalEligible(terminal),
            });
            if (pidWait.kind === 'invalidated' || !pidWait.isCurrent() || !isCurrent()) { return; }
            nativePidWaitIsCurrent = pidWait.isCurrent;
            terminalPid = pidWait.value;
        } finally {
            focusSubscription.dispose();
            if (pendingManualNativePidWaits.get(terminal) === controller) {
                pendingManualNativePidWaits.delete(terminal);
            }
        }
        if (!isCurrent()) { return; }
        const focused = focusOwner();
        if (focused) { await focused; return; }
        discoveryPath = terminalPid ? await findDiscoveryFileForTerminal(terminalPid) : undefined;
        if (!isCurrent()) { return; }
    }
    const sendAttachCommand = async (): Promise<void> => {
        const command = await getAttachSessionCommand();
        if (!isCurrent()) { return; }
        const focused = focusOwner();
        if (focused) { await focused; return; }
        if (terminal && isLiveTerminal(terminal) && !terminalIntegrations.has(terminal)) {
            terminal.sendText(command, true);
            terminal.show();
        }
    };
    if (!isCurrent()) { return; }
    const recovered = focusOwner();
    if (recovered) { await recovered; return; }
    if (terminal && discoveryPath) { await sendAttachCommand(); return; }

    // Focus the same association that execution and readiness recognize.
    const active = activeSession && terminalRegistry.forSession(activeSession);
    if (active) { active.terminal.show(); return; }

    if (config().get<boolean>('alwaysUseActiveTerminal')) {
        if (terminal) { await sendAttachCommand(); return; }
        const action = await window.showInformationMessage(
            'No active terminal is available. You can copy the attach command or create a managed R terminal.',
            'Copy Attach Command', 'Create R Terminal'
        );
        if (!isCurrent()) { return; }
        if (action === 'Copy Attach Command') { await connectToSession(); }
        else if (action === 'Create R Terminal') { await rTerminal.createRTerm(); }
        return;
    }
    await rTerminal.createRTerm();
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
    stateGeneration?: number,
): Promise<void> {
    resDir ??= path.join(extensionContext.extensionPath, 'dist', 'resources');
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}, viewId: ${String(viewId ?? '')}`);
    const panelKey = JSON.stringify([sessionId, viewId]);

    if (source === 'table') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(panelKey);
            if (existing) {
                if (stateGeneration !== undefined) {
                    dynamicDataViewStateGenerations.set(existing, stateGeneration);
                }
                existing.title = title;
                existing.reveal(existing.viewColumn, true);
                existing.webview.html = await getTableHtml(existing.webview, undefined, title, sessionId);
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
        attachViewerSessionBridge(panel, sessionId);
        if (viewId) {
            registerDataViewPanel(panel, panelKey, viewId, sessionId, stateGeneration);
            attachDynamicDataViewBridge(panel, viewId, sessionId);
        }
        const content = await getTableHtml(panel.webview, file || undefined, title, sessionId);
        panel.webview.html = content;
    } else if (source === 'list') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(panelKey);
            if (existing) {
                if (stateGeneration !== undefined) {
                    dynamicDataViewStateGenerations.set(existing, stateGeneration);
                }
                existing.title = title;
                existing.reveal(existing.viewColumn, true);
                existing.webview.html = getListHtml(
                    existing.webview, title, navigation, sessionId
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
                localResourceRoots: [Uri.file(resDir)],
            });
        panel.iconPath = new UriIcon('preview');
        attachViewerSessionBridge(panel, sessionId);
        if (viewId) {
            registerDataViewPanel(panel, panelKey, viewId, sessionId, stateGeneration);
            const webview = panel.webview;
            webview.onDidReceiveMessage(async (message: {
                message?: string; index?: number; start?: number; requestId?: number;
                path?: number[]; documentGeneration?: number;
            }) => {
                if (message.documentGeneration !== documentGenerations.get(webview)) {
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
                    if (message.documentGeneration !== documentGenerations.get(webview)) {
                        return;
                    }
                    const navigation = result && typeof result === 'object' && Array.isArray(result.breadcrumbs)
                        ? result : undefined;
                    if (navigation) {
                        panel.title = navigation.title;
                    }
                    void webview.postMessage({
                        message: 'listview/navigation',
                        documentGeneration: message.documentGeneration,
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
                    if (message.documentGeneration !== documentGenerations.get(webview)) {
                        return;
                    }
                    void webview.postMessage({
                        message: 'listview/page',
                        documentGeneration: message.documentGeneration,
                        requestId: message.requestId,
                        ...page,
                        error: Array.isArray(page?.children) ? undefined : 'Unable to load items. Check the R session and try again.',
                    });
                }
            });
        }
        panel.webview.html = getListHtml(
            panel.webview, title, navigation, sessionId
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

function getViewerSessionHtml(sessionId: string | null): string {
    return getViewerSessionContext(sessionId)?.getHtml() ?? '';
}

export function attachViewerSessionBridge(panel: vscode.WebviewPanel, sessionId: string | null): void {
    getViewerSessionContext(sessionId)?.attach(panel);
}

export function getViewerSessionContext(sessionId: string | null, saved?: ViewerSessionSource): ViewerSessionContext | undefined {
    const attached = sessions.get(sessionId ?? '');
    // A saved Viewer belongs to its original process, never a replacement.
    const owner = saved && (saved.processExited || !attached || sessionProcessIdentity(attached) !== sessionProcessIdentity(saved))
        ? saved : attached;
    return owner ? createViewerSessionContext(owner, sessionProcessMonitor) : undefined;
}

export async function getTableHtml(
    webview: Webview, file: string | undefined, title: string, sessionId: string | null = null,
    refreshable = false,
    tracking?: JdvTracking,
): Promise<string> {
    const sessionHtml = getViewerSessionHtml(sessionId);
    const codicons = webview.asWebviewUri(Uri.file(path.join(resDir, 'codicon.css'))).toString();
    const pageSize = config().get<number>('session.data.pageSize', 500);
    if (!file) {
        const documentGeneration = ++documentGenerationRevision;
        documentGenerations.set(webview, documentGeneration);
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${codicons}">
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
    const documentGeneration = ${documentGeneration};
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
                    documentGeneration,
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
        if (!data || data.message !== 'dataview/response' ||
            data.documentGeneration !== documentGeneration) {
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
            document.querySelector('#viewerControls').append(info);
        }
        if (init.sequential) {
            const info = document.createElement('span');
            info.textContent = 'Arrow stream';
            info.title = 'Rows are read from the Arrow stream as you scroll. The total is unknown until the stream ends. Sorting and filtering are not available.';
            document.querySelector('#viewerControls').append(info);
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
                    filteredRows = Number.isFinite(result.totalRows) ? result.totalRows : result.loadedRows;
                    totalRows = Number.isFinite(result.totalUnfiltered) ? result.totalUnfiltered : result.loadedRows;
                    isFiltered = Object.keys(params.filterModel || {}).length > 0;
                    updateViewerRowCount(filteredRows, totalRows);
                    if (init.sequential && !Number.isFinite(result.totalRows)) {
                        document.querySelector('#viewerRowCount').textContent =
                            rowNumberFormatter.format(result.loadedRows) + '+ rows loaded';
                    }
                    if (init.sequential && result.notice) {
                        document.querySelector('#viewerRowCount').title = result.notice;
                    }
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
            if (init.sequential) {
                // Arrow streams are read forward only; jdv offers no sorting or filtering.
                document.querySelector('#viewerFilters').disabled = true;
            }
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

        window.addEventListener('message', (event) => {
            const data = event.data;
            if (data && data.message === 'viewer/openFailed' &&
                data.documentGeneration === documentGeneration) {
                setFetchStatus('error', data.error || 'Unable to open this cell.', false);
            }
        });

        const refreshBtn = document.querySelector('#viewerRefresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                refreshBtn.disabled = true;
                setFetchStatus('loading', 'Refreshing...', false);
                vscode.postMessage({ message: 'dataview/refresh', documentGeneration });
            });
            // A successful refresh replaces this document, so only failures arrive.
            window.addEventListener('message', (event) => {
                const data = event.data;
                if (data && data.message === 'viewer/refreshFailed' &&
                    data.documentGeneration === documentGeneration) {
                    refreshBtn.disabled = false;
                    setFetchStatus('error', data.error || 'Unable to refresh.', false);
                }
            });
        }

        ${tracking ? getFollowScript(tracking, 'viewerFollow',
            '',
            "setFetchStatus('error', message.error || 'Unable to change following.', false);") : ''}

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
    ${getDataViewerToolbarHtml(sessionHtml, refreshable, tracking !== undefined)}
    <div id="gridContainer">
        <div id="myGrid" style="height: 100%;"></div>
        ${getDataViewerColumnPanelHtml()}
        <div id="scrollPosition" role="status" aria-live="polite"></div>
        <div id="fetchStatus" data-state="" role="status" aria-live="polite">
            <span id="fetchStatusText"></span>
            <button id="fetchRetryBtn" type="button">Retry</button>
        </div>
    </div>
    <script>${getViewerSessionScript()}</script>
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
    <link rel="stylesheet" href="${codicons}">
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
    ${getDataViewerToolbarHtml(sessionHtml)}
    <div id="gridContainer">
        <div id="myGrid" style="height: 100%;"></div>
        ${getDataViewerColumnPanelHtml()}
    </div>
    <script>${getViewerSessionScript()}</script>
</body>
</html>
`;
}

export function getListHtml(
    webview: Webview,
    title: string,
    navigation?: ListViewNavigation,
    sessionId: string | null = null,
    refreshable = false,
    tracking?: JdvTracking,
): string {
    const documentGeneration = ++documentGenerationRevision;
    documentGenerations.set(webview, documentGeneration);
    const codicons = webview.asWebviewUri(
        Uri.file(path.join(resDir, 'codicon.css'))
    ).toString();

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${codicons}">
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
    ${listViewerStyle}
    </style>
</head>
<body class="r-list-viewer">
    <div class="navigation">
        <button id="back" class="back" title="Back" aria-label="Back" disabled><span class="codicon codicon-arrow-left" aria-hidden="true"></span>Back</button>
        <nav id="breadcrumbs" class="breadcrumbs" aria-label="Object path"></nav>
        <button id="reset" class="reset" title="Reset to initial view" aria-label="Reset to initial view"><span class="codicon codicon-discard" aria-hidden="true"></span>Reset</button>
        ${refreshable ? '<button id="refresh" class="refresh" title="Rebuild this view from the current value of the R object" aria-label="Refresh"><span class="codicon codicon-refresh" aria-hidden="true"></span>Refresh</button>' : ''}
        ${tracking ? '<button id="follow" class="follow" aria-pressed="false" aria-label="Follow"><span class="codicon codicon-eye" aria-hidden="true"></span>Follow</button>' : ''}
        ${getViewerSessionHtml(sessionId)}
    </div>
    <div id="navigation-status" class="navigation-status" role="status"></div>
    <div id="list" class="list"></div>
    <script>
    ${getListViewerScript(documentGeneration, navigation ?? {
        title, path: [], breadcrumbs: [{ label: title, path: [] }],
    }, refreshable, tracking)}
    ${getViewerSessionScript()}
    </script>
</body>
</html>
`;
}

import * as rstudioapi from './rstudioapi';

export async function activateSession(session: Session): Promise<void> {
    sessionSelectionRevision++;
    activeSession = session;
    const refreshed = refreshActiveSession(session);
    if (!session.workspaceUnavailable) { scheduleWorkspaceRefresh(); }
    await refreshed;
}

/** Reconcile the selected connection before considering automatic attach selection. */
function activateAttachedSession(
    session: Session, previous: Session | undefined,
    selectionRevision: number, selectedTerminal: vscode.Terminal | undefined,
): Promise<void> {
    // Replacing the selected connection preserves the user's logical session choice,
    // even if that same session was reselected while discovery was pending.
    if (previous && activeSession === previous) { return activateSession(session); }

    // Automatic selection may not override a newer choice of a different session.
    if (selectionRevision !== sessionSelectionRevision || selectedTerminal !== window.activeTerminal) {
        return Promise.resolve();
    }
    const selected = terminalRegistry.associationFor(selectedTerminal);
    const hasNativeTerminal = terminalRegistry.forSession(session)?.kind === 'native';
    const shouldPreserveSelectedTerminal = hasNativeTerminal || selected?.kind === 'explicit';
    const preferred = shouldPreserveSelectedTerminal ? selected?.session : undefined;
    return activateSession(preferred ?? session);
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
        sessionStatusBarItem.text = formatSessionLabel(rVer, pid);
        sessionStatusBarItem.tooltip = `${info.version || rVer}\nProcess ID: ${pid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to active terminal.`;
        sessionStatusBarItem.show();
    }
    rWorkspace?.refresh();
    await setContext('rSessionActive', !session.workspaceUnavailable);
}

/** Activate a connected session by its stable protocol identity. */
export async function activateSessionById(sessionId: string, options?: RSessionActivationOptions): Promise<boolean> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
        return false;
    }
    const target = sessions.get(sessionId);
    if (!enableSessionWatcher && !target?.requester) { return false; }
    if (!target || !isConnectedSession(target)
        || (options?.connectionId !== undefined
            && (target.requester || !target.connectionId || target.connectionId !== options.connectionId))
        || (options?.select !== undefined && typeof options.select !== 'boolean')) {
        return false;
    }
    const connectionId = target.connectionId;
    const terminal = options?.terminal;
    if (terminal && !terminalRegistry.bindExplicit(terminal, target)) { return false; }
    const isStillCurrent = () => sessions.get(sessionId) === target && isConnectedSession(target)
        && target.connectionId === connectionId && (!terminal || terminalRegistry.ownerOf(terminal) === target);
    if (options?.select === false) {
        return isStillCurrent();
    }
    await activateSession(target);
    return isStillCurrent();
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

interface NativeTerminalCandidate {
    terminal: vscode.Terminal;
    pid: string;
    isCurrent: () => boolean;
}

function isNativeTerminalEligible(terminal: vscode.Terminal): boolean {
    return isLiveTerminal(terminal) && !terminalIntegrations.has(terminal);
}

async function findLocalTerminal(rPid: string, signal?: AbortSignal): Promise<NativeTerminalCandidate | undefined> {
    const candidates = new Map<number, NativeTerminalCandidate>();
    for (const terminal of window.terminals) {
        if (signal?.aborted) { return undefined; }
        if (!isNativeTerminalEligible(terminal)) { continue; }
        const isCurrent = terminalRegistry.snapshot(terminal);
        const pidWait = await nativeTerminalPidWaits.waitFor(terminal, () => terminal.processId, {
            signal, isEligible: () => isNativeTerminalEligible(terminal),
        });
        if (pidWait.kind === 'invalidated') {
            if (pidWait.reason !== 'terminal') { return undefined; }
            continue;
        }
        const terminalPid = pidWait.value;
        if (terminalPid === undefined || !pidWait.isCurrent() || !isCurrent()) { continue; }
        const candidate = {
            terminal,
            pid: String(terminalPid),
            isCurrent: () => pidWait.isCurrent() && isCurrent() && isNativeTerminalEligible(terminal),
        };
        if (candidate.pid === rPid) { return candidate; }
        candidates.set(terminalPid, candidate);
    }
    if (!candidates.size) { return undefined; }
    // Prefer the nearest terminal ancestor; never associate a sibling process.
    const ancestors = await getProcessAncestors(Number(rPid));
    const attachedRPids = new Set([...sessions.values()]
        .filter(session => isLocalHost(session.host) && !session.socket.destroyed)
        .map(session => session.pid));
    for (const pid of ancestors) {
        // A connected R owns its descendants; they must not take over its console.
        if (attachedRPids.has(String(pid))) { return undefined; }
        const candidate = candidates.get(pid);
        if (candidate?.isCurrent()) { return candidate; }
    }
    return undefined;
}

export async function switchSessionByTerminal(terminal: vscode.Terminal | undefined): Promise<void> {
    sessionSelectionRevision++;
    const owner = terminalRegistry.ownerOf(terminal);
    if (owner) { await activateSession(owner); }
    else { resetStatusBar(); }
}

function sendToSocket(socket: IpcSocket, data: Record<string, unknown>): void {
    if (!socket.destroyed) {
        socket.write(JSON.stringify(data) + '\n');
    }
}

async function handleNotification(message: Record<string, unknown>, socket: IpcSocket) {
    if (typeof message.method !== 'string') {
        return;
    }
    const method = message.method;
    const params = (message.params as Record<string, unknown>) || {};

    switch (method) {
        case 'attach': {
            if (!isLiveSessionSocket(socket)) { socket.destroy(); return; }
            const protocolVersion = params.protocol_version;
            const sessionId = typeof params.session_id === 'string' ? params.session_id.trim() : '';
            const host = typeof params.host === 'string' ? params.host : '';
            const attachmentId = params.attachment_id === undefined || params.attachment_id === null
                ? undefined : params.attachment_id;
            const autoActivateValue = params.auto_activate;
            if (attachmentId !== undefined && (typeof attachmentId !== 'string'
                || !/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId))) {
                void window.showErrorMessage('Cannot attach R session: invalid attachment_id metadata; expected 1–128 ASCII letters, digits, underscores, or hyphens.');
                socket.destroy();
                return;
            }
            if (autoActivateValue !== undefined && typeof autoActivateValue !== 'boolean') {
                void window.showErrorMessage('Cannot attach R session: invalid auto_activate metadata; expected a boolean.');
                socket.destroy();
                return;
            }
            if (autoActivateValue === false && attachmentId === undefined) {
                void window.showErrorMessage('Cannot attach R session: auto_activate=false requires a valid attachment_id. Update the external console and try again.');
                socket.destroy();
                return;
            }
            const autoActivate = autoActivateValue !== false;
            if (protocolVersion !== SESS_PROTOCOL_VERSION) {
                const found = protocolVersion === undefined ? 'missing' : JSON.stringify(protocolVersion);
                void window.showErrorMessage(`Cannot attach R session: unsupported sess protocol version ${found}; this extension requires protocol version ${SESS_PROTOCOL_VERSION}.`);
                socket.destroy();
                return;
            }
            if (!sessionId) {
                void window.showErrorMessage('Cannot attach R session: the sess attach handshake has no session_id. Update the sess package and try again.');
                socket.destroy();
                return;
            }
            if (typeof params.tempdir !== 'string' || !params.tempdir || typeof params.wd !== 'string' || !params.wd) {
                void window.showErrorMessage('Cannot attach R session: the sess attach handshake has missing or invalid session paths. Update the sess package and try again.');
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

            const rPid = typeof params.pid === 'string' || typeof params.pid === 'number' ? String(params.pid) : '';
            pendingSessionAttachments.get(sessionId)?.controller.abort();
            const pendingAttachment: PendingSessionAttachment = { socket, controller: new AbortController() };
            pendingSessionAttachments.set(sessionId, pendingAttachment);
            const selectionRevision = sessionSelectionRevision;
            const selectedTerminal = window.activeTerminal;
            const discardPendingAttachment = (): void => {
                if (pendingSessionAttachments.get(sessionId) !== pendingAttachment) { return; }
                pendingSessionAttachments.delete(sessionId);
                pendingAttachment.controller.abort();
                if (!socket._sessionId) { socket.destroy(); }
            };
            let candidate: NativeTerminalCandidate | undefined;
            try {
                candidate = autoActivate && rPid && isLocalHost(host)
                    ? await findLocalTerminal(rPid, pendingAttachment.controller.signal) : undefined;
            } catch (error) {
                discardPendingAttachment();
                throw error;
            }
            if (!isLiveSessionSocket(socket)) {
                discardPendingAttachment();
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
            const currentPendingAttachment = pendingSessionAttachments.get(sessionId);
            if (currentPendingAttachment !== pendingAttachment) {
                // A newer handshake can reuse the same socket. Only destroy a
                // different obsolete socket; never close the newer handshake's socket.
                if (currentPendingAttachment?.socket !== socket) { socket.destroy(); }
                return;
            }
            pendingSessionAttachments.delete(sessionId);
            if (!isLiveSessionSocket(socket)) { socket.destroy(); return; }
            const native = candidate?.isCurrent() ? candidate : undefined;
            const previous = sessions.get(sessionId);
            if (previous) {
                terminalRegistry.releaseSession(previous);
            }
            const session = new Session(
                sessionId,
                host || 'unknown',
                typeof params.sess_version === 'string' ? params.sess_version : 'unknown',
                socket._pipePath ?? globalPipePath ?? '',
                socket,
            );
            session.connectionId = crypto.randomBytes(16).toString('hex');
            session.attachmentId = attachmentId;
            socket._sessionId = sessionId;
            sessions.set(sessionId, session);
            const changes: RSessionConnectionChange[] = [];
            const disconnected = previous ? invalidateSessionConnection(previous) : undefined;
            if (disconnected) { changes.push(disconnected); }
            if (previous && previous.socket !== socket) {
                previous.socket.destroy();
            }
            session.rVer = String(params.version);
            session.pid = rPid;
            session.info = (params.info as SessionInfo | undefined) ?? { version: session.rVer, command: '', start_time: '' };
            session.sessionDir = params.tempdir;
            session.workingDir = params.wd;

            const terminalPid = native && terminalRegistry.attachNative(native.terminal, session) ? native.pid : undefined;
            if (terminalPid) { socket._terminalPid = Number(terminalPid); }

            const canUseLegacyUiEffects = autoActivate
                && selectionRevision === sessionSelectionRevision
                && selectedTerminal === window.activeTerminal;
            let activation: Promise<void> = Promise.resolve();
            if (previous && activeSession === previous) {
                activation = activateSession(session);
            } else if (autoActivate) {
                activation = activateAttachedSession(session, previous, selectionRevision, selectedTerminal);
            }
            // Capture after the synchronous activation decision but before notifying
            // listeners, so a reentrant user/listener selection cancels stale effects.
            const committedSelectionRevision = sessionSelectionRevision;
            const connected = createSessionReference(session);
            if (connected) { changes.push(Object.freeze({ kind: 'connected', session: connected })); }
            enqueueSessionConnectionChanges(changes);

            console.info(`[startSessionWatcher] attach session ${sessionId} (${host || 'unknown'}:${rPid || 'unknown'}), terminal PID: ${terminalPid ?? 'unassociated'}`);
            purgeAddinPickerItems();
            await activation;
            const mayApplyUiEffects = () => activeSession === session
                || (canUseLegacyUiEffects && sessionSelectionRevision === committedSelectionRevision);
            if (!isLiveSessionSocket(socket) || !isCurrentSocket(socket) || !mayApplyUiEffects()) { return; }
            if (typeof params.plot_url === 'string' && params.plot_url) {
                await globalPlotManager?.showHttpgdPlot(params.plot_url);
            }
            if (isLiveSessionSocket(socket) && isCurrentSocket(socket) && mayApplyUiEffects()) { scheduleWorkspaceRefresh(0); }
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
            if (typeof params.url === 'string' && params.url) {
                await globalPlotManager?.showHttpgdPlot(params.url);
            }
            break;
        }
        case 'browser':
        case 'page_viewer':
        case 'webview': {
            if (typeof params.url === 'string' && params.url) {
                const url = params.url;
                const title = typeof params.title === 'string' ? params.title : (method === 'browser' ? 'Browser' : method === 'page_viewer' ? 'Page Viewer' : 'Viewer');

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
                        // Standalone HTML can arrive through page_viewer (e.g. profvis)
                        // or browseURL as well as viewer; all belong to the source session.
                        await showWebView(url, title, viewColumn,
                            getViewerSessionContext(socket._sessionId ?? null));
                    } else {
                        await showDataView('object', 'txt', title, url, String(viewColumn));
                    }
                }
            }
            break;
        }
        case 'dataview': {
            // R's deparse() can return several title lines. Preserve the
            // comma-separated title previously produced by String(array).
            const title = typeof params.title === 'string' ? params.title
                : Array.isArray(params.title) && params.title.every((line: unknown) => typeof line === 'string')
                    ? params.title.join(',') : undefined;
            if (typeof params.source === 'string' && params.source
                && typeof params.type === 'string' && params.type
                && title
                && (params.file === undefined || params.file === null || typeof params.file === 'string')
                && (params.view_id === undefined || params.view_id === null || typeof params.view_id === 'string')) {
                const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                const viewer = viewColumnConfig['view'] ?? 'Two';
                if (viewer !== 'Disable') {
                    await showDataView(
                        params.source,
                        params.type,
                        title,
                        params.file ?? '',
                        viewer,
                        params.view_id || undefined,
                        params.navigation as ListViewNavigation | undefined,
                        socket._sessionId ?? null,
                        typeof params.state_generation === 'number' ? params.state_generation : undefined,
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
    if (!globalRHelp || typeof params.requestPath !== 'string' || !params.requestPath) {
        return;
    }

    const viewer = config().get<Record<string, string>>('session.viewers.viewColumn')?.helpPanel ?? 'Two';
    if (viewer !== 'Disable') {
        await globalRHelp.showHelpForPath(params.requestPath, viewer);
    }
}

export async function handleEditorRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return handleRequest({ method, params });
}

async function handleRequest(message: Record<string, unknown>, socket?: IpcSocket) {
    if (typeof message.method === 'string' && message.method) {
        const method = message.method;
        const params = (message.params as Record<string, unknown>) || {};
        let result: unknown = null;
        let error: unknown = null;

        try {
            switch (method) {
                case 'jdv/address': {
                    // The per-session jdv transport; sess connects jdv to it when View() is used.
                    const owner = sessions.get(socket?._sessionId ?? '');
                    if (!owner) { throw new Error('The jdv transport requires an attached session'); }
                    result = { address: await getJdvAddress(owner.sessionId) };
                    break;
                }
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

export async function cleanupSession(sessionId: string, closingSocket?: IpcSocket): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || (closingSocket && session.socket !== closingSocket)) {
        return;
    }
    sessions.delete(sessionId);
    disposeJdvHost(sessionId);
    terminalRegistry.releaseSession(session);
    const disconnected = invalidateSessionConnection(session);
    if (pipeClient === session.socket) {
        pipeClient = undefined;
    }
    if (!session.socket.destroyed && session.socket !== closingSocket) {
        session.socket.destroy();
    }
    const clearActive = activeSession === session ? clearActiveSession() : undefined;
    if (disconnected) { enqueueSessionConnectionChanges([disconnected]); }
    await clearActive;
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
    if (!config().get<boolean>('sessionWatcher')) {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
        return;
    }
    const command = await getAttachSessionCommand();
    void vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`R command copied to clipboard: ${command}`);
}
