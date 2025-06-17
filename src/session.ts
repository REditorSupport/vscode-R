'use strict';

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Agent } from 'http';
import { AddressInfo, Server, Socket } from 'node:net';
import { PromiseSocket } from 'promise-socket';
import fetch from 'node-fetch';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace, env, WebviewPanelOnDidChangeViewStateEvent, WebviewPanel } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { FSWatcher } from 'fs-extra';
import { config, createTempDir2, createTempFile, createWaiterForInvoker, hostnameOfListeningAddress, readContent, setContext, UriIcon } from './util';
import { purgeAddinPickerItems, dispatchRStudioAPICall } from './rstudioapi';

import { IRequest } from './liveShare/shareSession';
import { homeExtDir, rWorkspace, globalRHelp, globalHttpgdManager, extensionContext, sessionStatusBarItem } from './extension';
import { UUID, rHostService, rGuestService, isLiveShare, isHost, isGuestSession, closeBrowser, guestResDir, shareBrowser, shareWorkspace } from './liveShare';
import { openVirtualDoc } from './virtualDocs';

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
let incomingRequestServerCurrentSocket: Socket | null = null;
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
let activeBrowserPanel: WebviewPanel | undefined;
let activeBrowserUri: Uri | undefined;
let activeBrowserExternalUri: Uri | undefined;
export let incomingRequestServerAddressInfo: AddressInfo | undefined = undefined;
export let attached = false;

enum InterruptReason {
    ANOTHER_CONNECTION,
    USER_REQUEST
}

class InterruptSocketConnectionError extends Error {
    reason: InterruptReason;
    finishWaiter: Promise<void>;
    private finishInvoker: () => void;

    constructor (reason: InterruptReason) {
        super();

        this.reason = reason;

        const pair = createWaiterForInvoker();
        this.finishWaiter = pair.waiter;
        this.finishInvoker = pair.invoker;
    }

    reportFinishHandling() {
        this.finishInvoker();
    }
}

const addressToStr = (addressInfo: AddressInfo) => `${addressInfo.address}:${addressInfo.port}`;

function updateSessionStatusBarItem(sessionStatusBarItem: StatusBarItem) {
    const addressInfoStr = incomingRequestServerAddressInfo && addressToStr(incomingRequestServerAddressInfo);
    if (attached) {
        sessionStatusBarItem.text = `R ${rVer}: ${pid}` + (addressInfoStr ? ` (Connected via ${addressInfoStr})` : '');
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-member-access
        sessionStatusBarItem.tooltip = `${info?.version}\nProcess ID: ${pid}\n${addressInfoStr ? (`Connected via TCP address: ${addressInfoStr}\n`) : ''}Command: ${info?.command}\nStart time: ${info?.start_time}\nClick to attach to active terminal.`;
    } else {
        sessionStatusBarItem.text = `R: (not attached${addressInfoStr ? `, listening on ${addressInfoStr}` : ''})`;
        sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
    }
    sessionStatusBarItem.show();
}

export function deploySessionWatcher(extensionPath: string): void {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');

    for (const initFileName of ['init.R', 'init_late.R']) {
        const initPath = path.join(extensionPath, 'R', 'session', initFileName);
        const linkPath = path.join(homeExtDir(), initFileName);
        fs.writeFileSync(linkPath, `local(source("${initPath.replace(/\\/g, '\\\\')}", chdir = TRUE, local = TRUE))\n`);
    }

    writeSettings();
    workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('r')) {
            writeSettings();
        }
    });
}

export function startRequestWatcher(sessionStatusBarItem: StatusBarItem): void {
    console.info('[startRequestWatcher] Starting');
    
    try {
        requestFile = path.join(homeExtDir(), 'request.log');
        requestLockFile = path.join(homeExtDir(), 'request.lock');
        requestTimeStamp = 0;
        responseTimeStamp = 0;
        if (!fs.existsSync(requestLockFile)) {
            fs.createFileSync(requestLockFile);
        }
        fs.watch(requestLockFile, {}, () => {
            void updateRequest(sessionStatusBarItem);
        });
    } catch (e) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`Error in request file creating and watching: ${e}`);
        // TODO: Handle better
    }

    try {
        if (config().get<boolean>('sessionWatcherTcpServer')) {
            void startIncomingRequestServer(sessionStatusBarItem);
        }
    } catch (e) {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        console.error(`Error in incoming request server setup: ${e}`);
        // TODO: Handle better
    }

    console.info('[startRequestWatcher] Done');
}

export function attachActive(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActive]');
        if (incomingRequestServerAddressInfo) {
            void runTextInTerm(`.vsc.attach(host=${
                JSON.stringify(hostnameOfListeningAddress(incomingRequestServerAddressInfo))
            }, port=${incomingRequestServerAddressInfo.port}L)`);
        } else {
            void runTextInTerm('.vsc.attach()');
        }
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
    console.info('[updateSessionWatcher] Create workspaceWatcher');
    workspaceFile = path.join(sessionDir, 'workspace.json');
    workspaceLockFile = path.join(sessionDir, 'workspace.lock');
    workspaceTimeStamp = 0;
    if (workspaceWatcher !== undefined) {
        workspaceWatcher.close();
    }
    if (fs.existsSync(workspaceLockFile)) {
        workspaceWatcher = fs.watch(workspaceLockFile, {}, () => {
            void updateWorkspace();
        });
        void updateWorkspace();
    } else {
        console.info('[updateSessionWatcher] workspaceLockFile not found');
    }

    console.info('[updateSessionWatcher] Create plotWatcher');
    plotFile = path.join(sessionDir, 'plot.png');
    plotLockFile = path.join(sessionDir, 'plot.lock');
    plotTimeStamp = 0;
    if (plotWatcher !== undefined) {
        plotWatcher.close();
    }
    if (fs.existsSync(plotLockFile)) {
        plotWatcher = fs.watch(plotLockFile, {}, () => {
            void updatePlot();
        });
        void updatePlot();
    } else {
        console.info('[updateSessionWatcher] plotLockFile not found');
    }
    console.info('[updateSessionWatcher] Done');
}

async function updatePlot() {
    console.info(`[updatePlot] ${plotFile}`);
    const lockContent = await fs.readFile(plotLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== plotTimeStamp) {
        plotTimeStamp = newTimeStamp;
        if (fs.existsSync(plotFile) && fs.statSync(plotFile).size > 0) {
            showPlot(plotFile);
            console.info('[updatePlot] Done');
            if (isLiveShare()) {
                void rHostService?.notifyPlot(plotFile);
            }
        } else {
            console.info('[updatePlot] File not found');
        }
    }
}

function showPlot(plotFile: string) {
    void commands.executeCommand('vscode.open', Uri.file(plotFile), {
        preserveFocus: true,
        preview: true,
        viewColumn: ViewColumn[(config().get<string>('session.viewers.viewColumn.plot') || 'Two') as keyof typeof ViewColumn],
    });
}

async function updateWorkspace() {
    console.info(`[updateWorkspace] ${workspaceFile}`);

    const lockContent = await fs.readFile(workspaceLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== workspaceTimeStamp) {
        workspaceTimeStamp = newTimeStamp;
        if (fs.existsSync(workspaceFile)) {
            const content = await fs.readFile(workspaceFile, 'utf8');
            workspaceData = JSON.parse(content) as WorkspaceData;
            void rWorkspace?.refresh();
            console.info('[updateWorkspace] Done');
            if (isLiveShare()) {
                rHostService?.notifyWorkspace(workspaceData);
            }
        } else {
            console.info('[updateWorkspace] File not found');
        }
    }
}

export async function showBrowser(url: string, title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showBrowser] uri: ${url}, viewer: ${viewer.toString()}`);
    const uri = Uri.parse(url);
    if (viewer === false) {
        void env.openExternal(uri);
    } else {
        const externalUri = await env.asExternalUri(uri);
        const panel = window.createWebviewPanel(
            'browser',
            title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn],
            },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true,
            });
        if (isHost()) {
            await shareBrowser(url, title);
        }
        panel.onDidChangeViewState((e: WebviewPanelOnDidChangeViewStateEvent) => {
            if (e.webviewPanel.active) {
                activeBrowserPanel = panel;
                activeBrowserUri = uri;
                activeBrowserExternalUri = externalUri;
            } else {
                activeBrowserPanel = undefined;
                activeBrowserUri = undefined;
                activeBrowserExternalUri = undefined;
            }
            void commands.executeCommand('setContext', 'r.browser.active', e.webviewPanel.active);
        });
        panel.onDidDispose(() => {
            activeBrowserPanel = undefined;
            activeBrowserUri = undefined;
            activeBrowserExternalUri = undefined;
            if (isHost()) {
                closeBrowser(url);
            }
            void commands.executeCommand('setContext', 'r.browser.active', false);
        });
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = getBrowserHtml(externalUri);
    }
    console.info('[showBrowser] Done');
}

function getBrowserHtml(uri: Uri): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
    html, body {
        height: 100%;
        padding: 0;
        overflow: hidden;
    }
    </style>
</head>
<body>
    <iframe src="${uri.toString(true)}" width="100%" height="100%" frameborder="0" />
</body>
</html>
`;
}

export async function detach() {
    if (incomingRequestServerCurrentSocket === null) {
        return;
    }
    // otherwise
    
    const interrupt = new InterruptSocketConnectionError(InterruptReason.USER_REQUEST);
    incomingRequestServerCurrentSocket.destroy(interrupt);
    await interrupt.finishWaiter;
}

export function refreshBrowser(): void {
    console.log('[refreshBrowser]');
    if (activeBrowserPanel) {
        activeBrowserPanel.webview.html = '';
        if (activeBrowserExternalUri) {
            activeBrowserPanel.webview.html = getBrowserHtml(activeBrowserExternalUri);
        }
    }
}

export function openExternalBrowser(): void {
    console.log('[openExternalBrowser]');
    if (activeBrowserUri) {
        void env.openExternal(activeBrowserUri);
    }
}

export async function showWebView(file: string, files_content_base64: Record<string, string> | undefined,
    title: string, viewer: string | boolean): Promise<void> {
    console.info(`[showWebView] file: ${file}, viewer: ${viewer.toString()}`);
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
    } else {
        let dir: string;
        if (files_content_base64 !== undefined) {
            dir = (await createTempDir2()).path;
            const subdirs = new Set(Object.keys(files_content_base64).map((relativePath) => path.dirname(relativePath)));
            subdirs.delete('');
            subdirs.delete('.');
            await Promise.all(
                Array.from(subdirs).map((subdir) => fs.mkdir(path.join(dir, subdir), { recursive: true }))
            );
            await Promise.all(Object.entries(files_content_base64).map(async ([realtivePath, contentBase64]) => {
                const arrayData = Buffer.from(contentBase64, 'base64');
                return fs.writeFile(path.join(dir, realtivePath), arrayData);
            }));
            file = path.join(dir, file);
        } else {
            dir = path.dirname(file);
        }
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

export async function showDataView(source: string, type: string, title: string, file: string | undefined, data: string | object | undefined, viewer: string): Promise<void> {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file ?? 'none'}, viewer: ${viewer}`);
    console.debug(`data: ${JSON.stringify(data)}`);

    const getDataContent = async () : Promise<string | undefined> => {
        if (file === undefined) {
            return typeof data === 'string' ? data : JSON.stringify(data);
        } else {
            const fileContent = await readContent(file, 'utf8');
            if (fileContent === undefined) {
                console.error('Error: File wasn\'t found!');
                return undefined;
            }
        }
    };

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
        const fileContent = await getDataContent();
        if (fileContent !== undefined) {
            const content = getTableHtml(panel.webview, fileContent);
            panel.iconPath = new UriIcon('open-preview');
            panel.webview.html = content;
        }
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
        const fileContent = await getDataContent();
        if (fileContent !== undefined) {
            const content = getListHtml(panel.webview, fileContent);
            panel.iconPath = new UriIcon('open-preview');
            panel.webview.html = content;
        }
    } else {
        if (isGuestSession || file === undefined) {
            const fileContent = file === undefined ? data as string : await rGuestService?.requestFileContent(file, 'utf8');
            if (fileContent) {
                await openVirtualDoc(file ?? 'R View', fileContent, true, true, ViewColumn[viewer as keyof typeof ViewColumn]);
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

export function getTableHtml(webview: Webview, content: string): string {
    resDir = isGuestSession ? guestResDir : resDir;
    const pageSize = config().get<number>('session.data.pageSize', 500);
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
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
    const data = ${content};
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

export function getListHtml(webview: Webview, content: string): string {
    resDir = isGuestSession ? guestResDir : resDir;

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
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
    var data = ${content};
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

    const responseFile = path.join(responseSessionDir, 'response.log');
    const responseLockFile = path.join(responseSessionDir, 'response.lock');
    if (!fs.existsSync(responseFile) || !fs.existsSync(responseLockFile)) {
        throw ('Received a request from R for response' +
            'to a session directiory that does not contain response.log or response.lock: ' +
            responseSessionDir);
    }
    const responseString = JSON.stringify(responseData);
    console.info('[writeResponse] Started');
    console.info(`[writeResponse] responseData ${responseString}`);
    console.info(`[writeRespnse] responseFile: ${responseFile}`);
    await fs.writeFile(responseFile, responseString);
    responseTimeStamp = Date.now();
    await fs.writeFile(responseLockFile, `${responseTimeStamp}\n`);
}

export async function writeSuccessResponse(responseSessionDir: string): Promise<void> {
    await writeResponse({ result: true }, responseSessionDir);
}

type ISessionRequest = {
    plot_url?: string,
    server?: SessionServer
} & IRequest;

async function updateRequest(sessionStatusBarItem: StatusBarItem) {
    console.info('[updateRequest] Started');
    console.info(`[updateRequest] requestFile: ${requestFile}`);

    const lockContent = await fs.readFile(requestLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== requestTimeStamp) {
        requestTimeStamp = newTimeStamp;
        const requestContent = await fs.readFile(requestFile, 'utf8');
        console.info(`[updateRequest] request: ${requestContent}`);
        const request = JSON.parse(requestContent) as ISessionRequest;
        if (request.wd && isFromWorkspace(request.wd)) {
            if (request.uuid === null || request.uuid === undefined || request.uuid === UUID) {
                await processRequest(request, null, sessionStatusBarItem);
            }
        } else {
            console.info(`[updateRequest] Ignored request outside workspace`);
        }
        if (isLiveShare()) {
            void rHostService?.notifyRequest(requestFile);
        }
    }
}

function startIncomingRequestServer(sessionStatusBarItem: StatusBarItem) {
    console.log('Trying to start incoming request server now.');

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const incomingRequestServer = new Server(async (socket: Socket) => {
        console.info(`Incoming connection to the request server from ${addressToStr(socket.address() as AddressInfo)}`);
        if (incomingRequestServerCurrentSocket !== null) {
            console.info('Closing existing connection to the incoming request server since a new one is pending.');

            const interrupt = new InterruptSocketConnectionError(InterruptReason.ANOTHER_CONNECTION);
            incomingRequestServerCurrentSocket.destroy(interrupt);
            await interrupt.finishWaiter;
        }

        console.info('A new connection to the incoming request server has been established.');
        incomingRequestServerCurrentSocket = socket;
        const promiseSocket = new PromiseSocket(socket);

        try {
            console.info('Waiting for TCP input...');
        
            let contentToProcess = '';
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const currentChunk = await promiseSocket.read() as string | undefined;
                if (currentChunk === undefined) {
                    // The end of the socket
                    console.info('Incoming request server socket EOF');

                    // Force cleaning even if somehow not detached
                    await cleanupSession();
        
                    if (contentToProcess) {
                        console.error('TCP connection recieved EOF, but the last content didn\'t end up with line break.');
                    }
                    incomingRequestServerCurrentSocket = null;
                    return;
                }
                // otherwise
        
                contentToProcess = contentToProcess + currentChunk;
        
                const requests = contentToProcess.split((/\r?\n/));
                for (let i = 0; i < requests.length - 1; ++i) {
                    const requestContent = requests[i];

                    //console.debug(`TCP Request received from client: ${requestContent}.`);
                    const request = JSON.parse(requestContent) as ISessionRequest;
                    await processRequest(request, socket, sessionStatusBarItem);
                    await promiseSocket.write('req_finished\n');
                }
                contentToProcess = requests[requests.length - 1];
            }
        } catch (err) {
            if (err instanceof InterruptSocketConnectionError) {
                switch (err.reason) {
                    case InterruptReason.ANOTHER_CONNECTION:
                        console.log(`Closing this TCP connection since another one is pending.`);
                        break;
                    case InterruptReason.USER_REQUEST:
                        console.log(`Closing this TCP connection because of a user request.`);
                        break;
                }
            } else {
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                console.error(`Error while processing TCP connection: ${err}`);
            }

            void promiseSocket.end().catch(() => {
                // For some reason, there is an error when ending this connection, so we're ignoring the error for now
            });

            await cleanupSession();
            incomingRequestServerCurrentSocket = null;

            if (err instanceof InterruptSocketConnectionError) {
                err.reportFinishHandling();
            }
        }
    });

    const hostname = config().get<string>('sessionWatcherTcpServerHostName');
    const port = config().get<number>('sessionWatcherTcpServerPort');
    console.log(`Trying opening connection on ${hostname ?? '-'}:${port ?? '-'}`);
    const server = incomingRequestServer.listen(port,
        hostname, function() {
            incomingRequestServerAddressInfo = server.address() as AddressInfo;
            console.info(`Started listening on ${addressToStr(incomingRequestServerAddressInfo)}`);

            updateSessionStatusBarItem(sessionStatusBarItem);
        });

    return server;
}

export async function processRequest(request: ISessionRequest, socket: Socket | null, sessionStatusBarItem: StatusBarItem) {
    switch (request.command) {
        case 'help': {
            if (globalRHelp && request.requestPath) {
                console.log(request.requestPath);
                await globalRHelp.showHelpForPath(request.requestPath, request.viewer);
            }
            break;
        }
        case 'httpgd': {
            if (request.url) {
                await globalHttpgdManager?.showViewer(request.url);
            }
            break;
        }
        case 'updateWorkspace' : {
            if (!request.workspaceData) {
                console.error('[updateRequest] workspaceData is not set!');
                return;
            }

            workspaceData = request.workspaceData;
            void rWorkspace?.refresh();

            break;
        }
        case 'attach': {
            if (!request.tempdir || !request.wd) {
                return;
            }
            attached = true;
            rVer = String(request.version);
            pid = String(request.pid);
            info = request.info;
            sessionDir = path.join(request.tempdir, 'vscode-R');
            workingDir = request.wd;
            console.info(`[updateRequest] attach PID: ${pid}`);
            updateSessionStatusBarItem(sessionStatusBarItem);
            if (socket === null) {
                updateSessionWatcher();
            }

            if (request.server) {
                server = request.server;
            }

            purgeAddinPickerItems();
            await setContext('rSessionActive', true);
            if (request.plot_url) {
                await globalHttpgdManager?.showViewer(request.plot_url);
            }
            if (socket === null) {
                void watchProcess(pid).then((v: string) => {
                    void cleanupSession(v);
                });
            }
            break;
        }
        case 'detach': {
            if (socket === null) {
                if (request.pid) {
                    await cleanupSession(request.pid);
                }
            } else {
                await cleanupSession();
            }
            break;
        }
        case 'browser': {
            if (request.url && request.title && request.viewer !== undefined) {
                await showBrowser(request.url, request.title, request.viewer);
            }
            break;
        }
        case 'webview': {
            if (request.file && request.title && request.viewer !== undefined) {
                await showWebView(request.file, request.files_content_base64, request.title, request.viewer);
            }
            break;
        }
        case 'dataview': {
            if (request.source && request.type && (request.file || request.data) && request.title && request.viewer !== undefined) {
                await showDataView(request.source,
                    request.type, request.title, request.file, request.data, request.viewer);
            }
            break;
        }
        case 'plot': {
            if (request.format !== 'image/png') {
                console.info(`Error: the format ${request.format || '(none)'} isn't supported, only image/png is supported for now.`);
                break;
            }

            if (request.plot_base64) {
                const { name: filePath, fd } = await createTempFile({ postfix: '.png' });
                const arrayData = Buffer.from(request.plot_base64, 'base64');
                await fs.writeFile(fd, arrayData);
                showPlot(filePath);
            }
            break;
        }
        case 'rstudioapi': {
            if (request.action && request.args && request.sd) {
                await dispatchRStudioAPICall(request.action, request.args, request.sd);
            }
            break;
        }
        default:
            console.error(`[updateRequest] Unsupported command: ${request.command}`);
    }
}

export async function cleanupSession(pidArg?: string): Promise<void> {
    if (pidArg === undefined || pid === pidArg) {
        attached = false;
        if (sessionStatusBarItem) {
            updateSessionStatusBarItem(sessionStatusBarItem);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sessionRequest(server: SessionServer, data: any): Promise<any> {
    try {
        const response = await fetch(`http://${server.host}:${server.port}`, {
            agent: httpAgent,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: server.token
            },
            body: JSON.stringify(data),
            follow: 0,
            timeout: 500,
        });

        if (!response.ok) {
            throw new Error(`Error! status: ${response.status}`);
        }

        return response.json();
    } catch (error) {
        if (error instanceof Error) {
            console.log('error message: ', error.message);
        } else {
            console.log('unexpected error: ', error);
        }

        return undefined;
    }
}
