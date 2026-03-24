'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';
import { commands, Uri, ViewColumn, Webview, window, workspace, env } from 'vscode';

import { restartRTerminal } from './rTerminal';
import { config, readContent, setContext, UriIcon } from './util';
import * as rTerminal from './rTerminal';
import { purgeAddinPickerItems, RSEditOperation, RSRange } from './rstudioapi';

import { homeExtDir, rWorkspace, globalRHelp, globalPlotManager, sessionStatusBarItem } from './extension';
import { rHostService, rGuestService, isLiveShare, isHost, isGuestSession, guestResDir, shareBrowser, openVirtualDoc } from './liveShare';

import { showWebView } from './webViewer';

import WebSocket from 'ws';

export interface SessionInfo {
    version: string;
    command: string;
    start_time: string;
}

interface ExtWebSocket extends WebSocket {
    _terminalPid?: number;
    _port?: number;
    _token?: string;
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

export interface SessionServer {
    host: string;
    port: number;
    token: string;
}

export class Session {
    public server: SessionServer;
    public ws: WebSocket;
    public pid: string;
    public rVer: string;
    public info: SessionInfo;
    public sessionDir: string;
    public workingDir: string;
    public workspaceData: WorkspaceData;

    constructor(server: SessionServer, ws: WebSocket) {
        this.server = server;
        this.ws = ws;
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
export let server: SessionServer | undefined;
export let workspaceFile: string;

const sessions = new Map<string, Session>();
export let activeSession: Session | undefined;
let activeBrowserUri: Uri | undefined;

export function deploySessionWatcher(extensionPath: string): void {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');

    // Initialize the WebSocket server when the extension activates
    void getGlobalSessionServer().catch(err => {
        console.error('Failed to initialize global session server', err);
    });

    writeSettings();
    workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('r')) {
            writeSettings();
        }
    });
}

import * as crypto from 'crypto';

let wsClient: ExtWebSocket | undefined;
export const activeConnections = new Set<ExtWebSocket>();

const pendingRequests = new Map<number, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>();

let globalSessionServer: { port: number, token: string } | undefined;

export async function getGlobalSessionServer(): Promise<{ port: number, token: string }> {
    if (globalSessionServer) {
        return globalSessionServer;
    }

    return new Promise((resolve, reject) => {
        const token = crypto.randomBytes(16).toString('hex');
        const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });

        wss.on('listening', () => {
            const address = wss.address();
            if (typeof address === 'object' && address !== null) {
                globalSessionServer = { port: address.port, token };
                console.info(`[SessionServer] Listening on ws://127.0.0.1:${address.port}?token=${token}`);
                
                // Initialize the old global server object for compatibility
                server = { host: '127.0.0.1', port: address.port, token };
                resolve(globalSessionServer);
            } else {
                reject(new Error('Failed to get WebSocket server address'));
            }
        });

        wss.on('connection', (ws: ExtWebSocket, req) => {
            const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
            const clientToken = url.searchParams.get('token');

            if (clientToken !== token) {
                console.warn('[SessionServer] Connection rejected: invalid token');
                ws.close();
                return;
            }

            console.info('[SessionServer] Client connected');
            activeConnections.add(ws);
            wsClient = ws;

            ws.on('message', (data: WebSocket.Data) => {
                void (async () => {
                    try {
                        const message = JSON.parse(data.toString()) as Record<string, unknown>;
                        if (message.id !== undefined && !message.method) {
                            // Response to a client request
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
                        } else if (!message.id) {
                            // Notification from server
                            await handleNotification(message, ws);
                        } else {
                            // Request from server
                            await handleRequest(message, ws);
                        }
                    } catch (e) {
                        console.error('[SessionServer] Error handling message', e);
                    }
                })();
            });

            ws.on('close', () => {
                console.info('[SessionServer] Client disconnected');
                activeConnections.delete(ws);
                if (wsClient === ws) {
                    wsClient = undefined;
                }
            });
        });

        wss.on('error', (err) => {
            console.error('[SessionServer] Server error', err);
            reject(err);
        });
    });
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
    if (!server) {return;}
    await globalPlotManager?.showStandardPlot();
}

export async function updateWorkspace() {
    if (!server) {return;}
    try {
        const response = await sessionRequest(server, { method: 'workspace' });
        if (response) {
            workspaceData = response as WorkspaceData;
            if (activeSession) {
                activeSession.workspaceData = workspaceData;
            }
            void rWorkspace?.refresh();
            console.info('[updateWorkspace] Done');
            if (isLiveShare()) {
                rHostService?.notifyWorkspace(workspaceData);
            }
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
        if (isHost()) {
            await shareBrowser(url, title);
        }
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

export async function showDataView(source: string, type: string, title: string, file: string, viewer: string): Promise<void> {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}`);

    if (isGuestSession) {
        resDir = guestResDir;
    }

    if (source === 'table') {
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
        const content = await getTableHtml(panel.webview, file, title);
        panel.iconPath = new UriIcon('open-preview');
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
        if (isGuestSession) {
            const fileContent = await rGuestService?.requestFileContent(file, 'utf8');
            if (fileContent) {
                await openVirtualDoc(file, fileContent, true, true, ViewColumn[viewer as keyof typeof ViewColumn]);
            }
        } else {
            await commands.executeCommand('vscode.open', Uri.file(file), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
            });
        }
    }
    console.info('[showDataView] Done');
}

export async function getTableHtml(webview: Webview, file: string, title: string): Promise<string> {
    resDir = isGuestSession ? guestResDir : resDir;
    const pageSize = config().get<number>('session.data.pageSize', 500);
    const content = await readContent(file, 'utf8');
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
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
    <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-grid.min.css'))))}" rel="stylesheet">
    <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-theme-balham.min.css'))))}" rel="stylesheet">
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
    const data = ${String(content)};
    const gridOptions = {
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
        enableCellTextSelection: true,
        ensureDomOrder: true,
        tooltipShowDelay: 100,
        onFirstDataRendered: onFirstDataRendered
    };
    function onFirstDataRendered(params) {
        gridOptions.columnApi.autoSizeAllColumns(false);
    }
    function updateTheme() {
        const gridDiv = document.querySelector('#myGrid');
        if (document.body.classList.contains('vscode-light')) {
            gridDiv.className = 'ag-theme-balham';
        } else {
            gridDiv.className = 'ag-theme-balham-dark';
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        gridOptions.columnDefs.forEach(function(column) {
            if (column.type === 'dateColumn') {
                column.filterParams = dateFilterParams;
            }
        });
        const gridDiv = document.querySelector('#myGrid');
        new agGrid.Grid(gridDiv, gridOptions);
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
    resDir = isGuestSession ? guestResDir : resDir;
    const content = await readContent(file, 'utf8');

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
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
    wsClient = session.ws as ExtWebSocket;
    server = session.server;
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

async function handleNotification(message: Record<string, unknown>, ws: ExtWebSocket) {
    const method = String(message.method);
    const params = (message.params as Record<string, unknown>) || {};

    switch (method) {
        case 'attach': {
            if (!params.tempdir || !params.wd) {return;}
            const rPid = String(params.pid);
            const terminalPid = ws._terminalPid ? String(ws._terminalPid) : rPid;
            
            let session = sessions.get(terminalPid);
            if (!session) {
                session = new Session({ host: '127.0.0.1', port: ws._port || 0, token: ws._token || '' }, ws);
                sessions.set(terminalPid, session);
                // Also map R PID if it's different
                if (rPid !== terminalPid) {
                    sessions.set(rPid, session);
                }
            }
            session.rVer = String(params.version);
            session.pid = rPid;
            session.info = params.info as SessionInfo;
            session.sessionDir = String(params.tempdir);
            session.workingDir = String(params.wd);

            // Switch active session
            await activateSession(session);

            console.info(`[startSessionWatcher] attach R PID: ${rPid}, terminal PID: ${terminalPid}`);
            purgeAddinPickerItems();
            if (params.plot_url) {
                await globalPlotManager?.showHttpgdPlot(String(params.plot_url));
            }
            void updateWorkspace(); // Initial workspace fetch
            void watchProcess(rPid).then((v: string) => { void cleanupSession(v); });
            break;
        }

        // case 'detach': {
        //     if (params.pid) {
        //         await cleanupSession(String(params.pid));
        //     }
        //     break;
        // }
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
        case 'webview': {
            if (params.url) {
                const url = String(params.url);

                const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                const viewerChoice = viewColumnConfig['viewer'] ?? 'Active';
                const viewColumn = viewerChoice === 'Disable' ? false : viewerChoice;

                if (url.startsWith('http://') || url.startsWith('https://')) {
                    const isLocalHost = url.match(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i);
                    if (isLocalHost) {
                        const externalUri = await env.asExternalUri(Uri.parse(url));
                        await showBrowser(externalUri.toString(true), url, viewColumn);
                    } else {
                        await showBrowser(url, url, viewColumn);
                    }
                } else {
                    if (url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm')) {
                        await showWebView(url, 'Viewer', viewColumn);
                    } else {
                        await showDataView('object', 'txt', 'Data Viewer', url, String(viewColumn));
                    }
                }
            }
            break;
        }
        case 'dataview': {
            if (params.source && params.type && params.file && params.title && params.viewer !== undefined) {
                await showDataView(String(params.source), String(params.type), String(params.title), String(params.file), String(params.viewer));
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

async function handleRequest(message: Record<string, unknown>, ws: ExtWebSocket) {
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
        
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: result,
                error: error
            }));
        }
    }
}

export async function cleanupSession(pidArg: string): Promise<void> {
    const session = sessions.get(pidArg);
    if (session) {
        // Find all keys in sessions that point to this session and remove them
        const keysToRemove: string[] = [];
        for (const [k, v] of sessions.entries()) {
            if (v === session) {
                keysToRemove.push(k);
            }
        }
        keysToRemove.forEach(k => sessions.delete(k));
        // Terminate the WebSocket
        session.ws.terminate();
    }
    if (activeSession === session || pid === pidArg) {
        resetStatusBar();
        server = undefined;
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

export async function sessionRequest(server: SessionServer, data: Record<string, unknown>): Promise<unknown> {
    try {
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
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
                wsClient?.send(JSON.stringify(payload));
            } catch (e) {
                pendingRequests.delete(id);
                reject(e);
            }
            
            // Timeout after 5 seconds
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
    const { port, token } = await getGlobalSessionServer();
    const url = `ws://127.0.0.1:${port}?token=${token}`;
    void vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(`R Session URL copied to clipboard: ${url}\n\nIn your R console, run: sess::sess_app(port=${port}, token="${token}")`);
}
