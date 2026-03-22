'use strict';

import * as fs from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';
import { commands, Uri, ViewColumn, Webview, window, workspace, env } from 'vscode';

import { restartRTerminal, createRTerm } from './rTerminal';
import { config, readContent, setContext, UriIcon } from './util';
import { purgeAddinPickerItems, RSEditOperation, RSRange } from './rstudioapi';

import { homeExtDir, rWorkspace, globalRHelp, globalPlotManager, extensionContext, sessionStatusBarItem } from './extension';
import { rHostService, rGuestService, isLiveShare, isHost, isGuestSession, guestResDir, shareBrowser, openVirtualDoc } from './liveShare';

import { showWebView } from './webViewer';

import * as net from 'net';

export interface SessionInfo {
    version: string;
    command: string;
    start_time: string;
}

class StreamSocket extends net.Socket {
    public static readonly CONNECTING = 0;
    public static readonly OPEN = 1;
    public static readonly CLOSING = 2;
    public static readonly CLOSED = 3;

    public sessionReadyState: number = StreamSocket.CLOSED;
    private buffer: Buffer = Buffer.alloc(0);
    private expectedLength: number = -1;

    public _terminalPid?: number;
    public _port?: number;
    public _path?: string;
    public _token?: string;

    constructor(pathOrPort: string | number) {
        super();
        this.sessionReadyState = StreamSocket.CONNECTING;
        if (typeof pathOrPort === 'string') {
            this.connect(pathOrPort);
        } else {
            this.connect(pathOrPort, '127.0.0.1');
        }

        this.on('connect', () => {
            this.sessionReadyState = StreamSocket.OPEN;
            this.emit('open');
        });

        this.on('data', (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processBuffer();
        });

        this.on('close', () => {
            this.sessionReadyState = StreamSocket.CLOSED;
        });

        this.on('error', (_err) => {
            this.sessionReadyState = StreamSocket.CLOSED;
        });
    }

    private processBuffer() {
        while (this.buffer.length >= 4 || (this.expectedLength !== -1 && this.buffer.length >= this.expectedLength)) {
            if (this.expectedLength === -1) {
                if (this.buffer.length >= 4) {
                    this.expectedLength = this.buffer.readInt32BE(0);
                    this.buffer = this.buffer.subarray(4);
                } else {
                    break;
                }
            }

            if (this.expectedLength !== -1 && this.buffer.length >= this.expectedLength) {
                const payload = this.buffer.subarray(0, this.expectedLength);
                this.buffer = this.buffer.subarray(this.expectedLength);
                this.expectedLength = -1;
                this.emit('message', payload.toString());
            } else {
                break;
            }
        }
    }

    public send(msg: string) {
        const payload = Buffer.from(msg);
        const header = Buffer.alloc(4);
        header.writeInt32BE(payload.length, 0);
        this.write(Buffer.concat([header, payload]));
    }
    
    public terminate() {
        this.destroy();
    }
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
    port?: number;
    path?: string;
    token: string;
}

export class Session {
    public server: SessionServer;
    public ws: StreamSocket;
    public pid: string;
    public rVer: string;
    public info: SessionInfo;
    public sessionDir: string;
    public workingDir: string;
    public workspaceData: WorkspaceData;

    constructor(server: SessionServer, ws: StreamSocket) {
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

    const initPath = path.join(extensionPath, 'R', 'session', 'init.R');
    const linkPath = path.join(homeExtDir(), 'init.R');
    fs.writeFileSync(linkPath, `local(source("${initPath.replace(/\\/g, '\\\\')}", chdir = TRUE, local = TRUE))\n`);

    writeSettings();
    workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('r')) {
            writeSettings();
        }
    });
}

let wsClient: StreamSocket | undefined;
const activeConnections = new Map<string, StreamSocket>();

const pendingRequests = new Map<number, { resolve: (value: unknown) => void, reject: (reason?: unknown) => void }>();

export function startSessionWatcher(portOrPath: number | string, token: string, terminalPid?: number): void {
    const key = String(portOrPath);
    if (activeConnections.has(key)) {
        console.info(`[startSessionWatcher] Already connected to ${key}`);
        const ws = activeConnections.get(key);
        if (ws?.sessionReadyState === StreamSocket.OPEN) {
            wsClient = ws;
            if (terminalPid) {
                ws._terminalPid = terminalPid;
            }
            server = typeof portOrPath === 'number' ? { host: '127.0.0.1', port: portOrPath, token } : { host: 'localhost', path: portOrPath, token };
            return;
        } else {
            activeConnections.delete(key);
        }
    }
    
    console.info(`[startSessionWatcher] Connecting to ${key}`);
    
    // Initialize server object immediately so requests can proceed
    server = typeof portOrPath === 'number' ? { host: '127.0.0.1', port: portOrPath, token } : { host: 'localhost', path: portOrPath, token };

    let retries = 0;
    let hasConnected = false;

    const connect = () => {
        const ws = new StreamSocket(portOrPath);
        
        ws.on('open', () => {
            hasConnected = true;
            console.info('[startSessionWatcher] Connected');
            wsClient = ws;
            if (typeof portOrPath === 'number') {
                ws._port = portOrPath;
            } else {
                ws._path = portOrPath;
            }
            ws._token = token;
            if (terminalPid) {
                ws._terminalPid = terminalPid;
            }
            activeConnections.set(key, ws);
            retries = 0;
        });
        
        ws.on('message', (data: string) => {
            void (async () => {
                try {
                    const message = JSON.parse(data) as Record<string, unknown>;
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
                    console.error('[startSessionWatcher] Error handling message', e);
                }
            })();
        });
        
        ws.on('close', () => {
            if (hasConnected) {
                console.info('[startSessionWatcher] Disconnected');
            }
            if (activeConnections.get(key) === ws) {
                activeConnections.delete(key);
                if (wsClient === ws) {
                    wsClient = undefined;
                }
            }
        });
        
        ws.on('error', () => {
            if (retries < 20 && !activeConnections.has(key)) {
                retries++;
                setTimeout(connect, 500);
            } else if (retries >= 20 && !hasConnected) {
                console.error(`[startSessionWatcher] Failed to connect to ${key} after 10 seconds.`);
            }
        });
    };
    
    connect();
}

export function saveSessionState(pid: number, port: number, token: string): void {
    const sessionsMap = extensionContext.workspaceState.get<Record<string, { port: number, token: string }>>('r.sessions', {});
    sessionsMap[String(pid)] = { port, token };
    void extensionContext.workspaceState.update('r.sessions', sessionsMap);
}

export function clearSessionState(pid: number): void {
    const sessionsMap = extensionContext.workspaceState.get<Record<string, { port: number, token: string }>>('r.sessions', {});
    delete sessionsMap[String(pid)];
    void extensionContext.workspaceState.update('r.sessions', sessionsMap);
}

export function discoverSessions(): void {
    const persistedSessions = extensionContext.workspaceState.get<Record<string, { port: number, token: string }>>('r.sessions', {});
    
    void (async () => {
        // Scan existing terminals
        for (const terminal of window.terminals) {
            const pidArg = await terminal.processId;
            if (pidArg && persistedSessions[String(pidArg)]) {
                const sessionData = persistedSessions[String(pidArg)];
                console.info(`[discoverSessions] Found R session for PID ${pidArg} in workspaceState: ws://127.0.0.1:${sessionData.port}?token=${sessionData.token}`);
                startSessionWatcher(sessionData.port, sessionData.token);
            }
        }
    })();
}

export async function activateRSession(): Promise<void> {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[activateRSession]');
        const terminal = window.activeTerminal;
        if (terminal) {
            const pidArg = await terminal.processId;
            if (pidArg) {
                // 1. Check if we already have a session for this PID
                const session = sessions.get(String(pidArg));
                if (session) {
                    console.info(`[activateRSession] Found existing session for PID: ${pidArg}`);
                    await activateSession(session);
                    terminal.show();
                    return;
                }

                // 2. Check if we have an active connection that hasn't "attached" yet
                for (const ws of activeConnections.values()) {
                    if (ws._terminalPid === pidArg) {
                        console.info(`[activateRSession] Already connecting/connected for PID: ${pidArg}`);
                        terminal.show();
                        return; // Already connecting/connected
                    }
                }

                // 3. Check if we have persisted state for this PID
                const persistedSessions = extensionContext.workspaceState.get<Record<string, { port: number, token: string }>>('r.sessions', {});
                if (persistedSessions[String(pidArg)]) {
                    console.info(`[activateRSession] Found persisted session for PID: ${pidArg}`);
                    const sessionData = persistedSessions[String(pidArg)];
                    startSessionWatcher(sessionData.port, sessionData.token, pidArg);
                    terminal.show();
                    return;
                }
            }
        }

        // If we reached here, either there's no active terminal or it's not managed.
        // We focus the terminal of the active session if it exists.
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

        // Otherwise, create a new R terminal
        console.info('[activateRSession] Creating new R terminal');
        await createRTerm();
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
    wsClient = session.ws;
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

export function updateSessionTerminalId(portOrPath: number | string, terminalPid: number): void {
    const key = String(portOrPath);
    const ws = activeConnections.get(key);
    if (ws) {
        ws._terminalPid = terminalPid;
    }
}

async function handleNotification(message: Record<string, unknown>, ws: StreamSocket) {
    const method = String(message.method);
    const params = (message.params as Record<string, unknown>) || {};

    switch (method) {
        case 'attach': {
            if (!params.tempdir || !params.wd) {return;}
            const rPid = String(params.pid);
            const terminalPid = ws._terminalPid ? String(ws._terminalPid) : rPid;
            
            let session = sessions.get(terminalPid);
            if (!session) {
                const serverInfo: SessionServer = ws._port ? { host: '127.0.0.1', port: ws._port, token: ws._token || '' } : { host: 'localhost', path: ws._path, token: ws._token || '' };
                session = new Session(serverInfo, ws);
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

async function handleRequest(message: Record<string, unknown>, ws: StreamSocket) {
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
        
        if (ws.sessionReadyState === StreamSocket.OPEN) {
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
    clearSessionState(Number(pidArg));
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
        if (!wsClient || wsClient.sessionReadyState !== StreamSocket.OPEN) {
            throw new Error('IPC stream is not connected');
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

interface SessionTerminalLink extends vscode.TerminalLink {
    port?: number;
    path?: string;
    token: string;
}

export function setupTerminalLinkProvider(): vscode.Disposable {
    // One-click Link Provider (Stable API)
    return vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context: vscode.TerminalLinkContext) => {
            const regex = /\[sess\] Listening on: (ipc:\/\/(.*)|tcp:\/\/127\.0\.0\.1:(\d+))/g;
            const links: SessionTerminalLink[] = [];
            let match;
            while ((match = regex.exec(context.line)) !== null) {
                const url = match[1];
                const ipcPath = match[2];
                const port = match[3] ? Number(match[3]) : undefined;
                const key = ipcPath || String(port);
                if (!activeConnections.has(key)) {
                    links.push({
                        startIndex: match.index + match[0].indexOf(url),
                        length: url.length,
                        tooltip: 'Click to attach R session',
                        port: port,
                        path: ipcPath,
                        token: '' // Tokens are no longer used for IPC
                    });
                }
            }
            return links;
        },
        handleTerminalLink: async (link: SessionTerminalLink) => {
            if (link.path) {
                startSessionWatcher(link.path, link.token);
            } else if (link.port) {
                startSessionWatcher(link.port, link.token);
            }
        }
    });
}

export async function connectToSession(urlValue?: string): Promise<void> {
    const url = await vscode.window.showInputBox({
        value: urlValue,
        prompt: 'Enter the R session WebSocket URL',
        placeHolder: 'ws://127.0.0.1:PORT?token=TOKEN',
        ignoreFocusOut: true
    });
    if (url) {
        const regex = /ws:\/\/127\.0\.0\.1:(\d+)\?token=([a-z0-9]{32})/;
        const match = regex.exec(url);
        if (match) {
            const port = Number(match[1]);
            const token = match[2];
            const terminal = vscode.window.activeTerminal;
            const pidArg = await terminal?.processId;
            startSessionWatcher(port, token, pidArg);
        } else {
            void vscode.window.showErrorMessage('Invalid R session URL format.');
        }
    }
}
