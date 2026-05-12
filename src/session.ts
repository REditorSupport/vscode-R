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

import { extensionContext, homeExtDir, rWorkspace, globalRHelp, globalPlotManager, sessionStatusBarItem, tmpDir } from './extension';

import { showWebView } from './webViewer';

export interface SessionInfo {
    version: string;
    command: string;
    start_time: string;
}

export interface GlobalEnv {
    [key: string]: {
        class: string[];
        type: string;
        length: number;
        str: string;
        size?: number;
        dim?: number[],
        names?: string[],
        slots?: string[]
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
}

export class Session {
    public pipePath: string;
    public socket: IpcSocket;
    public pid: string;
    public rVer: string;
    public info: SessionInfo;
    public sessionDir: string;
    public workingDir: string;
    public workspaceData: WorkspaceData;

    constructor(pipePath: string, socket: IpcSocket) {
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
export let activeSession: Session | undefined;
let activeBrowserUri: Uri | undefined;

interface DataViewColumnDef {
    headerName: string;
    field: string;
    cellClass: string;
    type: string;
}

interface DataViewInitResult {
    columns: DataViewColumnDef[];
    totalRows: number;
}

interface DataViewPageResult {
    rows: Record<string, string>[];
    totalRows: number;
    lastRow: number;
}

interface DataViewRequestMessage {
    message: 'dataview/request';
    action: 'init' | 'page' | 'dispose';
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

function formatDataViewPanelTitle(baseTitle: string, totalRows: number): string {
    return `${baseTitle} (rows: ${totalRows.toLocaleString()})`;
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
                if (!result || typeof result.totalRows !== 'number') {
                    throw new Error('Invalid dataview_init response: missing or invalid totalRows');
                }
                if (Number.isFinite(result.totalRows)) {
                    panel.title = formatDataViewPanelTitle(baseTitle, result.totalRows);
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
                }) as DataViewPageResult | undefined;
                if (!result || typeof result.totalRows !== 'number') {
                    throw new Error('Invalid dataview_page response: missing or invalid totalRows');
                }
                if (Number.isFinite(result.totalRows)) {
                    panel.title = formatDataViewPanelTitle(baseTitle, result.totalRows);
                }
                postResponse(msg.requestId, true, result);
                return;
            }

            if (msg.action === 'dispose') {
                await sessionRequest({
                    method: 'dataview_dispose',
                    params: { view_id: viewId },
                });
                if (dynamicDataViewPanels.get(viewId) === panel) {
                    dynamicDataViewPanels.delete(viewId);
                }
                postResponse(msg.requestId, true, true);
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
        await pruneSessionFiles();
        await updateActiveTerminalFiles(pipePath);
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

const pendingRequests = new Map<number, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>();

// Per-socket read buffers for NDJSON framing
const readBuffers = new Map<IpcSocket, string>();

let globalSessionServer: net.Server | undefined;
let attachSessionScriptPath: string | undefined;

function isPidRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function pruneSessionFiles() {
    const homeDir = os.homedir();
    const sessionsDir = path.join(homeDir, '.vscode-R', 'sessions');
    if (!await fs.pathExists(sessionsDir)) {
        return;
    }
    const files = await fs.readdir(sessionsDir);
    for (const file of files) {
        if (file.endsWith('.json')) {
            const pidStr = path.basename(file, '.json');
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
                if (!isPidRunning(pid)) {
                    try {
                        await fs.remove(path.join(sessionsDir, file));
                    } catch (e) {
                        console.error(`Failed to remove stale session file ${file}`, e);
                    }
                }
            }
        }
    }
}

export async function writeSessionFile(pid: string, pipePath: string) {
    const homeDir = os.homedir();
    const sessionsDir = path.join(homeDir, '.vscode-R', 'sessions');
    await fs.ensureDir(sessionsDir);
    const filePath = path.join(sessionsDir, `${pid}.json`);
    await fs.writeJson(filePath, { pipe: pipePath });
    await setOwnerOnlyPermissions(filePath);
}

async function updateActiveTerminalFiles(pipePath: string) {
    const terminals = vscode.window.terminals;
    for (const term of terminals) {
        if (term.name === 'R Interactive') {
            const pid = await term.processId;
            if (pid) {
                await writeSessionFile(pid.toString(), pipePath);
            }
        }
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
            pipeClient = socket;
            readBuffers.set(socket, '');

            socket.on('data', (data: Buffer) => {
                const incoming = data.toString('utf8');
                const buf = (readBuffers.get(socket) ?? '') + incoming;
                const lines = buf.split('\n');
                // Last element is a potentially incomplete line — keep in buffer
                readBuffers.set(socket, lines[lines.length - 1]);

                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (!line) {
                        continue;
                    }
                    void (async () => {
                        try {
                            const message = JSON.parse(line) as Record<string, unknown>;
                            if (message.id !== undefined && !message.method) {
                                // Response to a request we sent
                                const id = Number(message.id);
                                const pending = pendingRequests.get(id);
                                if (pending) {
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
                }
            });

            socket.on('close', () => {
                console.info('[SessionServer] Client disconnected');
                readBuffers.delete(socket);
                activeConnections.delete(socket);
                if (pipeClient === socket) {
                    pipeClient = undefined;
                }
            });

            socket.on('error', (err) => {
                console.error('[SessionServer] Socket error', err);
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
    if (pipePath.endsWith('.sock')) {
        return pipePath.replace(/\.sock$/, '.R');
    }
    const scriptBase = path.basename(pipePath).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'attach_session';
    return path.join(tmpDir(), `${scriptBase}.R`);
}

function buildAttachSessionScript(pipePath: string, sessPath: string, installSessScriptPath: string): string {
    return [
        'local({',
        `  pipe_path <- ${asRStringLiteral(pipePath)}`,
        `  sess_src <- ${asRStringLiteral(sessPath)}`,
        `  install_sess_script <- ${asRStringLiteral(installSessScriptPath)}`,
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
        '  sess::connect(pipe_path = pipe_path)',
        '})',
        '',
    ].join('\n');
}

export async function getAttachSessionCommand(): Promise<string> {
    const pipePath = await getGlobalPipePath();
    const sessPath = extensionContext.asAbsolutePath('sess').replace(/\\/g, '/');
    const installSessScriptPath = extensionContext.asAbsolutePath(path.join('R', 'install_sess.R')).replace(/\\/g, '/');
    const scriptPath = getAttachSessionScriptPath(pipePath);
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
    readBuffers.clear();

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
        await removePathIfExists(pipePath.replace(/\.sock$/, '.R'));
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
                const session = sessions.get(String(pidArg));
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
                if (termPid && sessions.get(String(termPid)) === activeSession) {
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

export async function updateWorkspace() {
    if (!globalPipePath) {return;}
    try {
        const response = await sessionRequest({ method: 'workspace' });
        if (response) {
            workspaceData = response as WorkspaceData;
            if (activeSession) {
                activeSession.workspaceData = workspaceData;
            }
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

export async function showDataView(source: string, type: string, title: string, file: string, viewer: string, viewId?: string, totalRows?: number): Promise<void> {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}, viewId: ${String(viewId ?? '')}`);
    const panelTitle = totalRows !== undefined && Number.isFinite(totalRows)
        ? formatDataViewPanelTitle(title, totalRows)
        : title;

    if (source === 'table') {
        if (viewId) {
            const existing = dynamicDataViewPanels.get(viewId);
            if (existing) {
                existing.title = panelTitle;
                existing.reveal(ViewColumn[viewer as keyof typeof ViewColumn], true);
                const content = await getTableHtml(existing.webview, undefined, title);
                existing.webview.html = `${content}\n<!-- dataview-reload:${++dynamicDataViewReloadRevision} -->`;
                return;
            }
        }

        const panel = window.createWebviewPanel('dataview', panelTitle,
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

    [class*="vscode"] .text-left {
        text-align: left;
    }

    [class*="vscode"] .text-right {
        text-align: right;
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
    </style>
    <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid-community.min.noStyle.js'))))}"></script>
    <script>
    const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
    let requestIdSeq = 1;
    const pending = new Map();
    let gridApi;
    let activeFetches = 0;
    let longFetchTimer;
    const LONG_FETCH_DELAY_MS = 2000;

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
        
        columns.forEach((column) => {
            if (column.type === 'dateColumn') {
                column.filter = 'agDateColumnFilter';
                column.filterParams = dateFilterParams;
            } else if (column.type === 'datetimeColumn') {
                column.filter = 'agDateColumnFilter';
                column.filterParams = {
                    ...dateFilterParams,
                    buttons: ['reset', 'apply']
                };
            } else if (column.type === 'numberColumn') {
                column.filter = 'agNumberColumnFilter';
                column.filterParams = {
                    ...column.filterParams,
                    buttons: ['reset', 'apply']
                };
            } else if (column.type === 'setColumn') {
                // agSetColumnFilter requires ag-grid-enterprise in v35.
                // Keep community build compatible by using text filter and
                // relying on server-side filtering in sess.
                column.filter = 'agTextColumnFilter';
                column.filterParams = {
                    ...column.filterParams,
                    buttons: ['reset', 'apply']
                };
            }
            // Remove column type field - v35 doesn't use it
            delete column.type;
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
                    const resolvedLastRow = Number.isFinite(result.totalRows) ? result.totalRows : result.lastRow;
                    params.successCallback(result.rows || [], resolvedLastRow);
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
            onFirstDataRendered: function(params) {
                if (params.columnApi) {
                    params.columnApi.autoSizeAllColumns(false);
                }
                updateFetchStatusPosition();
            }
        };

        const gridDiv = document.querySelector('#myGrid');
        try {
            console.log('[dataview] Creating grid with options:', gridOptions);
            gridApi = window.agGrid.createGrid(gridDiv, gridOptions);
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

    if (sessionStatusBarItem) {
        sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
        sessionStatusBarItem.tooltip = `${info.version}\nProcess ID: ${pid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to active terminal.`;
        sessionStatusBarItem.show();
    }
    await setContext('rSessionActive', true);
    rWorkspace?.refresh();
}

export function resetStatusBar(): void {
    if (sessionStatusBarItem) {
        sessionStatusBarItem.text = 'R: (not attached)';
        sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
    }
}

export async function switchSessionByTerminal(terminal: vscode.Terminal | undefined): Promise<void> {
    const terminalPid = await terminal?.processId;
    const session = terminalPid ? sessions.get(String(terminalPid)) : undefined;
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
            if (!params.tempdir || !params.wd) {return;}
            const rPid = String(params.pid);
            const terminalPid = socket._terminalPid ? String(socket._terminalPid) : rPid;

            let session = sessions.get(terminalPid);
            if (!session) {
                session = new Session(socket._pipePath ?? globalPipePath ?? '', socket);
                sessions.set(terminalPid, session);
                if (rPid !== terminalPid) {
                    sessions.set(rPid, session);
                }
            }
            session.rVer = String(params.version);
            session.pid = rPid;
            session.info = params.info as SessionInfo;
            session.sessionDir = String(params.tempdir);
            session.workingDir = String(params.wd);

            await activateSession(session);

            console.info(`[startSessionWatcher] attach R PID: ${rPid}, terminal PID: ${terminalPid}`);
            purgeAddinPickerItems();
            if (params.plot_url) {
                await globalPlotManager?.showHttpgdPlot(String(params.plot_url));
            }
            void updateWorkspace();
            void watchProcess(rPid).then((v: string) => { void cleanupSession(v); });
            break;
        }

        case 'workspace_updated': {
            void updateWorkspace();
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
                        typeof params.total_rows === 'number' ? params.total_rows : undefined,
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

export async function cleanupSession(pidArg: string): Promise<void> {
    const session = sessions.get(pidArg);
    if (session) {
        const keysToRemove: string[] = [];
        for (const [k, v] of sessions.entries()) {
            if (v === session) {
                keysToRemove.push(k);
            }
        }
        keysToRemove.forEach(k => sessions.delete(k));
        session.socket.destroy();
    }
    if (activeSession === session || pid === pidArg) {
        resetStatusBar();
        globalPipePath = undefined;
        activeSession = undefined;
        workspaceData.globalenv = {};
        workspaceData.loaded_namespaces = [];
        workspaceData.search = [];
        rWorkspace?.refresh();
        removeSessionFiles();
        await setContext('rSessionActive', false);
    }
}

async function watchProcess(pid: string): Promise<string> {
    function pidIsRunning(pid: number) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return false;
        }
    }

    const pidArg = Number(pid);

    let res = true;
    do {
        res = pidIsRunning(pidArg);
        await new Promise(resolve => {
            setTimeout(resolve, 1000);
        });

    } while (res);
    return pid;
}

export async function sessionRequest(data: Record<string, unknown>): Promise<unknown> {
    try {
        if (!pipeClient || pipeClient.destroyed) {
            throw new Error('IPC socket is not connected');
        }

        return await new Promise((resolve, reject) => {
            const id = data.id !== undefined ? Number(data.id) : Math.floor(Math.random() * 1000000);
            const payload = data.jsonrpc ? data : {
                jsonrpc: '2.0',
                id,
                ...data
            };

            pendingRequests.set(id, { resolve, reject });

            try {
                pipeClient?.write(JSON.stringify(payload) + '\n');
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
