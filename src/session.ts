'use strict';

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Agent } from 'http';
import fetch from 'node-fetch';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace, env, WebviewPanelOnDidChangeViewStateEvent, WebviewPanel } from 'vscode';

import { runTextInTerm, restartRTerminal } from './rTerminal';
import { FSWatcher } from 'fs-extra';
import { config, readContent, setContext, UriIcon } from './util';
import { purgeAddinPickerItems } from './rstudioapi';

import { IRequest } from './liveShare/shareSession';
import { homeExtDir, rWorkspace, globalRHelp, globalHttpgdManager, extensionContext, sessionStatusBarItem } from './extension';
import { UUID, rHostService, rGuestService, isLiveShare, isHost, isGuestSession, closeBrowser, guestResDir, shareBrowser, openVirtualDoc, shareWorkspace } from './liveShare';

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

export let workspaceData: WorkspaceData;
let resDir: string;
export let requestFile: string;
export let requestLockFile: string;
let requestTimeStamp: number;
let responseTimeStamp: number;
export let sessionDir: string;
export let workingDir: string;
let rVer: string;
let pid: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let info: any;
const httpAgent = new Agent({ keepAlive: true });
export let server: SessionServer | undefined;
export let workspaceFile: string;
let workspaceLockFile: string;
let workspaceTimeStamp: number;
let plotFile: string;
let plotLockFile: string;
let plotTimeStamp: number;
let workspaceWatcher: FSWatcher;
let plotWatcher: FSWatcher;
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

import * as WebSocket from 'ws';

let wsClient: WebSocket.WebSocket | undefined;

export function startSessionWatcher(port: number, token: string): void {
    console.info(`[startSessionWatcher] Connecting to ws://127.0.0.1:${port}?token=${token}`);
    
    let retries = 0;
    const connect = () => {
        const url = `ws://127.0.0.1:${port}?token=${token}`;
        const ws = new WebSocket.WebSocket(url);
        
        ws.on('open', () => {
            console.info('[startSessionWatcher] Connected');
            wsClient = ws;
            server = { host: '127.0.0.1', port, token };
            retries = 0;
        });
        
        ws.on('message', (data: WebSocket.Data) => {
            void (async () => {
                try {
                    const message = JSON.parse(data.toString()) as Record<string, unknown>;
                    if (!message.id) {
                        await handleNotification(message);
                    } else {
                        await handleRequest(message, ws);
                    }                } catch (e) {
                    console.error('[startSessionWatcher] Error handling message', e);
                }
            })();
        });
        
        ws.on('close', () => {
            console.info('[startSessionWatcher] Disconnected');
            wsClient = undefined;
        });
        
        ws.on('error', (err: Error) => {
            if (retries < 10 && !wsClient) {
                retries++;
                setTimeout(connect, 500);
            }
        });
    };
    
    connect();
}

export function attachActive(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActive]');
        void runTextInTerm('if (requireNamespace("sess", quietly = TRUE)) sess::sess_app()');
        if (isLiveShare() && shareWorkspace) {
            rHostService?.notifyRequest(requestFile, true);
        }
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

function updateSessionWatcher() {
    console.info(`[updateSessionWatcher] PID: ${pid}`);
    console.info('[updateSessionWatcher] Done');
}

async function updatePlot() {
    if (!server) {return;}
    try {
        const response = await sessionRequest(server, { jsonrpc: '2.0', id: 1, method: 'plot_latest' });
        if (response && (response as Record<string, unknown>).data) {
            const plotFile = path.join(sessionDir, 'plot.png');
            fs.writeFileSync(plotFile, Buffer.from((response as Record<string, unknown>).data as string, 'base64'));
            void commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[(config().get<string>('session.viewers.viewColumn.plot') || 'Two') as keyof typeof ViewColumn],
            });
            console.info('[updatePlot] Done');
            if (isLiveShare()) {
                void rHostService?.notifyPlot(plotFile);
            }
        }
    } catch (e) {
        console.error(e);
    }
}

export async function updateWorkspace() {
    if (!server) {return;}
    try {
        const response = await sessionRequest(server, { jsonrpc: '2.0', id: 1, method: 'workspace' });
        if (response) {
            workspaceData = response as WorkspaceData;
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

export async function showWebView(file: string, title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showWebView] file: ${file}, viewer: ${viewer.toString()}`);
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
    } else {
        const dir = path.dirname(file);
        const webviewDir = extensionContext.asAbsolutePath('html/session/webview/');
        const panel = window.createWebviewPanel('webview', title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(dir), Uri.file(webviewDir)],
            });
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = await getWebviewHtml(panel.webview, file, title, dir, webviewDir);
    }
    console.info('[showWebView] Done');
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

export async function getWebviewHtml(webview: Webview, file: string, title: string, dir: string, webviewDir: string): Promise<string> {
    const observerPath = Uri.file(path.join(webviewDir, 'observer.js'));
    const body = (await readContent(file, 'utf8') || '').toString()
        .replace(/<(\w+)(.*)\s+(href|src)="(?!\w+:)/g,
            `<$1 $2 $3="${String(webview.asWebviewUri(Uri.file(dir)))}/`);

    // define the content security policy for the webview
    // * whilst it is recommended to be strict as possible,
    // * there are several packages that require unsafe requests
    const CSP = `
        upgrade-insecure-requests;
        default-src https: data: filesystem:;
        style-src https: data: filesystem: 'unsafe-inline';
        script-src https: data: filesystem: 'unsafe-inline' 'unsafe-eval';
        worker-src https: data: filesystem: blob:;
    `;

    return `
    <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="${CSP}">
                <title>${title}</title>
                <style>
                    body {
                        color: black;
                    }
                </style>
            </head>
            <body>
                <span id="webview-content">
                    ${body}
                </span>
            </body>
            <script src="${String(webview.asWebviewUri(observerPath))}"></script>
        </html>`;
}

function isFromWorkspace(dir: string) {
    if (workspace.workspaceFolders === undefined) {
        let rel = path.relative(os.homedir(), dir);
        if (rel === '') {
            return true;
        }
        rel = path.relative(fs.realpathSync(os.homedir()), dir);
        if (rel === '') {
            return true;
        }
    } else {
        for (const folder of workspace.workspaceFolders) {
            let rel = path.relative(folder.uri.fsPath, dir);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                return true;
            }
            rel = path.relative(fs.realpathSync(folder.uri.fsPath), dir);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                return true;
            }
        }
    }

    return false;
}

export async function writeResponse(responseData: Record<string, unknown>, responseSessionDir: string): Promise<void> {
    // Deprecated
}

export async function writeSuccessResponse(responseSessionDir: string): Promise<void> {
    // Deprecated
}

import * as rstudioapi from './rstudioapi';

async function handleNotification(message: Record<string, unknown>) {
    const method = String(message.method);
    const params = (message.params as Record<string, unknown>) || {};
    
    console.info(`[handleNotification] method: ${method}, params: ${JSON.stringify(params)}`);

    switch (method) {
        case 'attach': {
            if (!params.tempdir || !params.wd) {return;}
            rVer = String(params.version);
            pid = String(params.pid);
            info = params.info;
            sessionDir = path.join(String(params.tempdir), 'vscode-R');
            workingDir = String(params.wd);
            console.info(`[startSessionWatcher] attach PID: ${pid}`);
            if (sessionStatusBarItem) {
                sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions
                sessionStatusBarItem.tooltip = `${info?.version}\nProcess ID: ${pid}\nCommand: ${info?.command}\nStart time: ${info?.start_time}\nClick to attach to active terminal.`;
                sessionStatusBarItem.show();
            }
            purgeAddinPickerItems();
            await setContext('rSessionActive', true);
            if (params.plot_url) {
                await globalHttpgdManager?.showViewer(String(params.plot_url));
            }
            void watchProcess(pid).then((v: string) => { void cleanupSession(v); });
            break;
        }
        // case 'detach': {
        //     if (params.pid) {
        //         await cleanupSession(String(params.pid));
        //     }
        //     break;
        // }
        case 'help': {
            if (globalRHelp && params.requestPath) {
                await globalRHelp.showHelpForPath(String(params.requestPath), params.viewer);
            }
            break;
        }
        case 'httpgd': {
            if (params.url) {
                await globalHttpgdManager?.showViewer(String(params.url));
            }
            break;
        }
        case 'browser': {
            if (params.url && params.title && params.viewer !== undefined) {
                await showBrowser(String(params.url), String(params.title), params.viewer as string | boolean);
            }
            break;
        }
        case 'webview': {
            if (params.file && params.title && params.viewer !== undefined) {
                await showWebView(String(params.file), String(params.title), params.viewer as string | boolean);
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
        case 'send_to_console': {
            await rstudioapi.sendCodeToRTerminal(String(params.code), Boolean(params.execute), Boolean(params.focus));
            break;
        }
        default:
            console.error(`[startSessionWatcher] Unsupported notification method: ${method}`);
    }
}

async function handleRequest(message: Record<string, unknown>, ws: WebSocket.WebSocket) {
    if (message.method) {
        const method = String(message.method);
        const params = (message.params as Record<string, unknown>) || {};
        let result: unknown = null;
        let error: unknown = null;
        
        try {
            switch (method) {
                case 'active_editor_context':
                    result = rstudioapi.activeEditorContext();
                    break;
                case 'insert_or_modify_text':
                    await rstudioapi.insertOrModifyText(params.query as any[], String(params.id));
                    result = true;
                    break;
                case 'replace_text_in_current_selection':
                    await rstudioapi.replaceTextInCurrentSelection(String(params.text), String(params.id));
                    result = true;
                    break;
                case 'show_dialog':
                    rstudioapi.showDialog(String(params.message));
                    result = true;
                    break;
                case 'navigate_to_file':
                    await rstudioapi.navigateToFile(String(params.file), Number(params.line), Number(params.column));
                    result = true;
                    break;
                case 'set_selection_ranges':
                    await rstudioapi.setSelections(params.ranges as number[][], String(params.id));
                    result = true;
                    break;
                case 'document_save':
                    await rstudioapi.documentSave(String(params.id));
                    result = true;
                    break;
                case 'document_save_all':
                    await rstudioapi.documentSaveAll();
                    result = true;
                    break;
                case 'get_project_path':
                    result = rstudioapi.projectPath();
                    break;
                case 'document_context':
                    result = await rstudioapi.documentContext(String(params.id));
                    break;
                case 'document_new':
                    await rstudioapi.documentNew(String(params.text), String(params.type), params.position as number[]);
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
    if (pid === pidArg) {
        if (sessionStatusBarItem) {
            sessionStatusBarItem.text = 'R: (not attached)';
            sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
        }
        server = undefined;
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
        const payload = data.jsonrpc ? data : {
            jsonrpc: '2.0',
            id: Math.floor(Math.random() * 1000000),
            ...data
        };
        const response = await fetch(`http://${server.host}:${server.port}/rpc`, {
            agent: httpAgent,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: server.token
            },
            body: JSON.stringify(payload),
            follow: 0,
            timeout: 500,
        });

        if (!response.ok) {
            throw new Error(`Error! status: ${response.status}`);
        }

        const res = await response.json() as Record<string, unknown>;
        return res.result !== undefined ? res.result : res;
    } catch (error) {
        if (error instanceof Error) {
            console.log('error message: ', error.message);
        } else {
            console.log('unexpected error: ', error);
        }

        return undefined;
    }
}
