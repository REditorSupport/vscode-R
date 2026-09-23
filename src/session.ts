'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { commands, Uri, ViewColumn, Webview, window, workspace, env } from 'vscode';

import { restartRTerminal } from './rTerminal';
import { config, readContent, setContext, UriIcon } from './util';
import * as rTerminal from './rTerminal';
import { purgeAddinPickerItems, RSEditOperation, RSRange } from './rstudioapi';

import { extensionContext, homeExtDir, rWorkspace, globalRHelp, globalPlotManager, sessionStatusBarItem } from './extension';
import { resolveBackend, CommonPlotManager } from './plotViewer';

import { showWebView } from './webViewer';
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

const sessions = new Map<string, Session>();
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

function attachDynamicDataViewBridge(panel: vscode.WebviewPanel, viewId: string, baseTitle: string): void {
    const postResponse = (requestId: number, ok: boolean, result?: unknown, error?: string) => {
        void panel.webview.postMessage({
            message: 'dataview/response',
            requestId,
            ok,
            result,
            error,
        });
    };

    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
        const msg = raw as Partial<DataViewRequestMessage>;
        if (msg.message !== 'dataview/request' || typeof msg.requestId !== 'number') {
            return;
        }

        try {
            if (msg.action === 'init') {
                const result = await sessionRequest({
                    method: 'dataview_init',
                    params: { view_id: viewId },
                }) as DataViewInitResult | undefined;
                if (!result || !Array.isArray(result.columns) || typeof result.totalRows !== 'number') {
                    throw new Error('Invalid dataview_init response');
                }
                panel.title = baseTitle;
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
                }) as DataViewPageResult | undefined;
                if (!result || !Array.isArray(result.rows) ||
                    typeof result.totalRows !== 'number' ||
                    typeof result.totalUnfiltered !== 'number') {
                    throw new Error('Invalid dataview_page response');
                }
                panel.title = baseTitle;
                postResponse(msg.requestId, true, result);
                return;
            }

            postResponse(msg.requestId, false, undefined, `Unsupported dataview action: ${String(msg.action)}`);
        } catch (e) {
            postResponse(msg.requestId, false, undefined, e instanceof Error ? e.message : String(e));
        }
    });

    panel.onDidDispose(() => {
        if (dynamicDataViewPanels.get(viewId) !== panel) {
            return;
        }
        dynamicDataViewPanels.delete(viewId);
        void sessionRequest({
            method: 'dataview_dispose',
            params: { view_id: viewId },
        });
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

    writeSettings();
    workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('r')) {
            writeSettings();
        }
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

let globalSessionServer: net.Server | undefined;
let attachSessionScriptPath: string | undefined;

interface SessionDiscoveryFile {
    version: 1;
    endpoint: string;
    terminalPid?: number;
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
    const data: SessionDiscoveryFile = { version: 1, endpoint };
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
        const envPath = terminalDiscoveryPath(term);
        if (!envPath && term.name !== 'R Interactive') {
            continue;
        }
        const terminalPid = await term.processId;
        if (!terminalPid) {
            continue;
        }
        let discoveryPath = envPath;
        discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
        if (discoveryPath) {
            await updateSessionDiscoveryFile(discoveryPath, pipePath, terminalPid);
        }
    }
}

export async function updateTerminalDiscovery(terminal: vscode.Terminal): Promise<void> {
    if (!globalPipePath) {
        return;
    }
    const terminalPid = await terminal.processId;
    if (terminalPid === undefined) {
        return;
    }
    let discoveryPath = terminalDiscoveryPath(terminal);
    if (!discoveryPath && terminal.name !== 'R Interactive') {
        return;
    }
    discoveryPath ??= await findDiscoveryFileForTerminal(terminalPid);
    if (discoveryPath) {
        await updateSessionDiscoveryFile(discoveryPath, globalPipePath, terminalPid);
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

    return new Promise((resolve, reject) => {
        const pipePath = makePipePath();
        const server = net.createServer((rawSocket) => {
            const socket = rawSocket as IpcSocket;
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

        server.on('error', (err) => {
            console.error('[SessionServer] Server error', err);
            reject(err);
        });

        server.listen(pipePath, () => {
            void setOwnerOnlyPermissions(pipePath).then(() => {
                globalPipePath = pipePath;
                globalSessionServer = server;
                console.info(`[SessionServer] Listening on ${pipePath}`);
                resolve(pipePath);
            }).catch(reject);
        });
    });
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
    const useHttpgd = backend === 'httpgd' || backend === 'auto' ? 'TRUE' : 'FALSE';
    const useJgd = backend === 'jgd' || backend === 'auto' ? 'TRUE' : 'FALSE';
    const jgdSocket = (backend === 'jgd' || backend === 'auto')
        ? (globalPlotManager as CommonPlotManager)?.getJgdEnvVars()?.['JGD_SOCKET'] ?? ''
        : '';
    return [
        'local({',
        `  endpoint <- ${asRStringLiteral(pipePath)}`,
        `  sess_src <- ${asRStringLiteral(sessPath)}`,
        `  install_sess_script <- ${asRStringLiteral(installSessScriptPath)}`,
        ...(jgdSocket ? [`  Sys.setenv(JGD_SOCKET = ${asRStringLiteral(jgdSocket)})`] : []),
        '  bundled_version <- tryCatch(read.dcf(file.path(sess_src, "DESCRIPTION"))[1, "Version"], error = function(e) NA_character_)',
        '  installed_version <- suppressWarnings(tryCatch(as.character(utils::packageVersion("sess")), error = function(e) NA_character_))',
        '  needs_install <- is.na(installed_version) || (!is.na(bundled_version) && utils::compareVersion(installed_version, bundled_version) < 0)',
        '  if (needs_install) {',
        '    if (!file.exists(install_sess_script)) {',
        '      stop(sprintf("install_sess.R not found: %s", install_sess_script))',
        '    }',
        '    Sys.setenv(VSCODE_R_SESS_PKG_PATH = sess_src)',
        '    on.exit(Sys.unsetenv(c("VSCODE_R_SESS_PKG_PATH", "VSCODE_R_SESS_REPO")), add = TRUE)',
        '    source(install_sess_script, local = TRUE)',
        '  }',
        `  sess::connect(endpoint = endpoint, use_httpgd = ${useHttpgd}, use_jgd = ${useJgd})`,
        '})',
        '',
    ].join('\n');
}

export async function getAttachSessionCommand(): Promise<string> {
    const pipePath = await getGlobalPipePath();
    const sessPath = extensionContext.asAbsolutePath('sess').replace(/\\/g, '/');
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
}

export async function activateRSession(): Promise<void> {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[activateRSession]');
        const terminal = window.activeTerminal;
        if (terminal) {
            const pidArg = await terminal.processId;
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

function writeSettings() {
    const settingPath = path.join(homeExtDir(), 'settings.json');
    fs.writeFileSync(settingPath, JSON.stringify(config()));
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
    if (!globalPipePath || !requestedSession) {return;}
    try {
        const response = await sessionRequest({ method: 'workspace' });
        if (response && activeSession === requestedSession) {
            workspaceData = response as WorkspaceData;
            requestedSession.workspaceData = workspaceData;
            void rWorkspace?.refresh();
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

export async function showDataView(source: string, type: string, title: string, file: string, viewer: string, viewId?: string): Promise<void> {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}, viewId: ${String(viewId ?? '')}`);

    if (source === 'table') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(viewId);
            if (existing) {
                existing.title = title;
                existing.reveal(ViewColumn[viewer as keyof typeof ViewColumn], true);
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
            dynamicDataViewPanels.set(viewId, panel);
            attachDynamicDataViewBridge(panel, viewId, title);
        }
        const content = await getTableHtml(panel.webview, file || undefined, title);
        panel.webview.html = content;
    } else if (source === 'list') {
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
        const content = await getListHtml(panel.webview, file, title);
        panel.iconPath = new UriIcon('open-preview');
        panel.webview.html = content;
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
        height: 100%;
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
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
    let requestIdSeq = 1;
    const pending = new Map();
    let gridApi;
    ${getDataViewerColumnPanelScript()}
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
    const emptyCellRenderer = () => '';
    const naCellRenderer = () => {
        const element = document.createElement('span');
        element.className = 'dataview-na';
        element.textContent = 'NA';
        return element;
    };

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

        let headerHeight = 0;
        if (gridApi && typeof gridApi.getSizesForCurrentTheme === 'function') {
            const sizes = gridApi.getSizesForCurrentTheme();
            if (sizes && Number.isFinite(sizes.headerHeight)) {
                headerHeight = Number(sizes.headerHeight);
            }
        }

        if (!headerHeight) {
            const headerEl = document.querySelector('#myGrid .ag-header');
            if (headerEl) {
                headerHeight = headerEl.getBoundingClientRect().height;
            }
        }

        const topOffset = Math.max(8, Math.round(headerHeight) + 8);
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

    const dateFilterParams = {
        browserDatePicker: true,
    };

    function getAgTheme() {
        if (document.body.classList.contains('vscode-light')) {
            return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeLight);
        }
        return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeDark);
    }

    function updateTheme() {
        if (gridApi) {
            gridApi.setGridOption('theme', getAgTheme());
        }
        updateFetchStatusPosition();
    }

    async function initialize() {
        console.log('[dataview] agGrid object:', window.agGrid);
        console.log('[dataview] agGrid.Grid:', typeof window.agGrid.Grid);

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
        const bigintFields = [];
        
        columns.forEach((column) => {
            column.cellRendererSelector = params => {
                if (params.data == null) {
                    return { component: emptyCellRenderer };
                }
                return params.value == null
                    ? { component: naCellRenderer }
                    : undefined;
            };
            if (column.field === '0') {
                column.headerValueGetter = () =>
                    isFiltered
                        ? '(' + rowNumberFormatter.format(filteredRows) +
                            '/' + rowNumberFormatter.format(totalRows) + ')'
                        : '';
            }
            if (column.type === 'dateColumn' || column.type === 'datetimeColumn') {
                column.cellDataType =
                    column.type === 'dateColumn' ? 'dateString' : 'dateTimeString';
                column.filter = 'agDateColumnFilter';
                column.filterParams = dateFilterParams;
                column.width = 200;
            } else if (column.type === 'bigintColumn') {
                column.cellDataType = 'bigint';
                column.filter = 'agBigIntColumnFilter';
                bigintFields.push(column.field);
            }
            if (column.type !== 'numericColumn') {
                delete column.type;
            }
        });

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
                    gridApi?.refreshHeader();
                    updateScrollPosition();
                    const resolvedLastRow = Number.isFinite(result.totalRows) ? result.totalRows : result.lastRow;
                    const rows = result.rows || [];
                    rows.forEach((row) => {
                        bigintFields.forEach((field) => {
                            if (row[field] != null) {
                                row[field] = BigInt(row[field]);
                            }
                        });
                    });
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
            theme: getAgTheme(),
            defaultColDef: {
                sortable: true,
                resizable: true,
                filter: true,
                width: 100,
                minWidth: 50,
                filterParams: {
                    buttons: ['reset', 'apply']
                }
            },
            columnDefs: columns,
            rowModelType: 'infinite',
            datasource: datasource,
            cacheBlockSize: blockSize,
            pagination: ${pageSize > 0 ? 'true' : 'false'},
            paginationPageSize: blockSize,
            paginationPageSizeSelector: [20, 50, 100, blockSize],
            enableCellTextSelection: true,
            ensureDomOrder: true,
            tooltipShowDelay: 100,
            onPaginationChanged: updateScrollPosition,
            onFirstDataRendered: function(params) {
                params.api.autoSizeAllColumns(false);
                updateFetchStatusPosition();
                attachScrollbarPositionIndicator();
            }
        };

        const gridDiv = document.querySelector('#myGrid');
        try {
            console.log('[dataview] Creating grid with options:', gridOptions);
            gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
            initializeColumnPanel();
            console.log('[dataview] Grid created successfully');
            updateFetchStatusPosition();
        } catch (e) {
            console.error('[dataview] Grid creation failed:', e);
            console.error('[dataview] Error stack:', e instanceof Error ? e.stack : 'N/A');
            gridDiv.innerHTML = '<div style="padding: 20px; color: red;">Error: ' + (e instanceof Error ? e.message : String(e)) + '</div>';
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
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>
    const dateFilterParams = {
        browserDatePicker: true,
        comparator: function (filterLocalDateAtMidnight, cellValue) {
            var dateAsString = cellValue;
            if (dateAsString == null) return -1;
            var dateParts = dateAsString.split('-');
            var cellDate = new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2].substr(0, 2)));
            if (filterLocalDateAtMidnight.getTime() == cellDate.getTime()) {
                return 0;
            }
            if (cellDate < filterLocalDateAtMidnight) {
                return -1;
            }
            if (cellDate > filterLocalDateAtMidnight) {
                return 1;
            }
        }
    };
    let gridApi;
    function getAgTheme() {
        if (document.body.classList.contains('vscode-light')) {
            return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeLight);
        }
        return window.agGrid.themeBalham.withPart(window.agGrid.colorSchemeDark);
    }
    const data = ${String(content)};
    const gridOptions = {
        theme: getAgTheme(),
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            width: 100,
            minWidth: 50,
            filterParams: {
                buttons: ['reset', 'apply']
            }
        },
        columnDefs: data.columns,
        rowData: data.data,
        rowSelection: 'multiple',
        pagination: ${pageSize > 0 ? 'true' : 'false'},
        paginationPageSize: ${pageSize},
        paginationPageSizeSelector: [20, 50, 100, ${pageSize}],
        enableCellTextSelection: true,
        ensureDomOrder: true,
        tooltipShowDelay: 100,
        onFirstDataRendered: onFirstDataRendered
    };
    function onFirstDataRendered(params) {
        gridOptions.columnApi.autoSizeAllColumns(false);
    }
    function updateTheme() {
        if (gridApi) {
            gridApi.setGridOption('theme', getAgTheme());
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        gridOptions.columnDefs.forEach(function(column) {
            if (column.type === 'dateColumn') {
                column.filter = 'agDateColumnFilter';
                column.filterParams = dateFilterParams;
            }
            delete column.type;
        });
        const gridDiv = document.querySelector('#myGrid');
        gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
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
    <div id="myGrid" style="height: 100%;"></div>
</body>
</html>
`;
}

export async function getListHtml(webview: Webview, file: string, title: string): Promise<string> {
    const content = await readContent(file, 'utf8');

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.min.js'))))}"></script>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.json-viewer.js'))))}"></script>
    <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.json-viewer.css'))))}" rel="stylesheet">
    <style type="text/css">
    body {
        color: var(--vscode-editor-foreground);
        background-color: var(--vscode-editor-background);
    }

    .json-document {
        padding: 0 0;
    }

    pre#json-renderer {
        font-family: var(--vscode-editor-font-family);
        border: 0;
    }

    ul.json-dict, ol.json-array {
        color: var(--vscode-symbolIcon-fieldForeground);
        border-left: 1px dotted var(--vscode-editorLineNumber-foreground);
    }

    .json-literal {
        color: var(--vscode-symbolIcon-variableForeground);
    }

    .json-string {
        color: var(--vscode-symbolIcon-stringForeground);
    }

    a.json-toggle:before {
        color: var(--vscode-button-secondaryBackground);
    }

    a.json-toggle:hover:before {
        color: var(--vscode-button-secondaryHoverBackground);
    }

    a.json-placeholder {
        color: var(--vscode-input-placeholderForeground);
    }
    </style>
    <script>
    var data = ${String(content)};
    $(document).ready(function() {
      var options = {
        collapsed: false,
        rootCollapsable: false,
        withQuotes: false,
        withLinks: true
      };
      $("#json-renderer").jsonViewer(data, options);
    });
    </script>
</head>
<body>
    <pre id="json-renderer"></pre>
</body>
</html>
`;
}

import * as rstudioapi from './rstudioapi';

export async function activateSession(session: Session): Promise<void> {
    activeSession = session;
    pipeClient = session.socket;
    globalPipePath = session.pipePath;
    pid = session.pid;
    rVer = session.rVer;
    info = session.info;
    sessionDir = session.sessionDir;
    workingDir = session.workingDir;
    workspaceData = session.workspaceData;

    if (sessionStatusBarItem) {
        sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
        sessionStatusBarItem.tooltip = `${info.version}\nProcess ID: ${pid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to active terminal.`;
        sessionStatusBarItem.show();
    }
    await setContext('rSessionActive', true);
    rWorkspace?.refresh();
    scheduleWorkspaceRefresh();
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
            if (protocolVersion !== 1) {
                const found = protocolVersion === undefined ? 'missing' : String(protocolVersion);
                void window.showErrorMessage(`Cannot attach R session: unsupported sess protocol version ${found}; this extension requires protocol version 1.`);
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

            await activateSession(session);

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
            if (globalRHelp && params.requestPath) {
                await globalRHelp.showHelpForPath(String(params.requestPath), params.viewer);
            }
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

async function handleRequest(message: Record<string, unknown>, socket: IpcSocket) {
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
        deferWorkspaceRefresh();
        workspaceRefreshPending = false;
        resetStatusBar();
        activeSession = undefined;
        workspaceData.globalenv = {};
        workspaceData.loaded_namespaces = [];
        workspaceData.search = [];
        rWorkspace?.refresh();
        await setContext('rSessionActive', false);
    }
}

export async function sessionRequest(data: Record<string, unknown>): Promise<unknown> {
    try {
        const socket = pipeClient;
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

// Kept for backward compatibility - callers in rTerminal.ts use this
export async function getGlobalSessionServer(): Promise<{ port: number, token: string }> {
    await getGlobalPipePath();
    return { port: 0, token: '' };
}
