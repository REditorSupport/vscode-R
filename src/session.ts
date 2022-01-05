/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
'use strict';

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace, env, WebviewPanelOnDidChangeViewStateEvent, WebviewPanel } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { FSWatcher } from 'fs-extra';
import { config, readContent, UriIcon } from './util';
import { purgeAddinPickerItems, dispatchRStudioAPICall } from './rstudioapi';

import { homeExtDir, rWorkspace, globalRHelp, globalHttpgdManager, extensionContext } from './extension';
import { UUID, rHostService, rGuestService, isLiveShare, isHost, isGuestSession, closeBrowser, guestResDir, shareBrowser, openVirtualDoc, shareWorkspace } from './liveShare';

export let globalenv: any;
let resDir: string;
export let requestFile: string;
export let requestLockFile: string;
let requestTimeStamp: number;
let responseTimeStamp: number;
export let sessionDir: string;
export let workingDir: string;
let rVer: string;
let pid: string;
let info: any;
export let globalenvFile: string;
let globalenvLockFile: string;
let globalenvTimeStamp: number;
let plotFile: string;
let plotLockFile: string;
let plotTimeStamp: number;
let globalEnvWatcher: FSWatcher;
let plotWatcher: FSWatcher;
let activeBrowserPanel: WebviewPanel;
let activeBrowserUri: Uri;
let activeBrowserExternalUri: Uri;

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

export function startRequestWatcher(sessionStatusBarItem: StatusBarItem): void {
    console.info('[startRequestWatcher] Starting');
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
    console.info('[startRequestWatcher] Done');
}

export function attachActive(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActive]');
        void runTextInTerm('.vsc.attach()');
        if (isLiveShare() && shareWorkspace) {
            rHostService.notifyRequest(requestFile, true);
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
    console.info('[updateSessionWatcher] Create globalEnvWatcher');
    globalenvFile = path.join(sessionDir, 'globalenv.json');
    globalenvLockFile = path.join(sessionDir, 'globalenv.lock');
    globalenvTimeStamp = 0;
    if (globalEnvWatcher !== undefined) {
        globalEnvWatcher.close();
    }
    if (fs.existsSync(globalenvLockFile)) {
        globalEnvWatcher = fs.watch(globalenvLockFile, {}, () => {
            void updateGlobalenv();
        });
        void updateGlobalenv();
    } else {
        console.info('[updateSessionWatcher] globalenvLockFile not found');
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
            void commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[config().get<string>('session.viewers.viewColumn.plot')],
            });
            console.info('[updatePlot] Done');
            if (isLiveShare()) {
                void rHostService.notifyPlot(plotFile);
            }
        } else {
            console.info('[updatePlot] File not found');
        }
    }
}

async function updateGlobalenv() {
    console.info(`[updateGlobalenv] ${globalenvFile}`);

    const lockContent = await fs.readFile(globalenvLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== globalenvTimeStamp) {
        globalenvTimeStamp = newTimeStamp;
        if (fs.existsSync(globalenvFile)) {
            const content = await fs.readFile(globalenvFile, 'utf8');
            globalenv = JSON.parse(content);
            void rWorkspace?.refresh();
            console.info('[updateGlobalenv] Done');
            if (isLiveShare()) {
                rHostService.notifyGlobalenv(globalenv);
            }
        } else {
            console.info('[updateGlobalenv] File not found');
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
                viewColumn: ViewColumn[String(viewer)],
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

export function refreshBrowser(): void {
    console.log('[refreshBrowser]');
    if (activeBrowserPanel) {
        activeBrowserPanel.webview.html = '';
        activeBrowserPanel.webview.html = getBrowserHtml(activeBrowserExternalUri);
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
                viewColumn: ViewColumn[String(viewer)],
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
                viewColumn: ViewColumn[viewer],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(resDir)],
            });
        const content = await getTableHtml(panel.webview, file);
        panel.iconPath = new UriIcon('open-preview');
        panel.webview.html = content;
    } else if (source === 'list') {
        const panel = window.createWebviewPanel('dataview', title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[viewer],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(resDir)],
            });
        const content = await getListHtml(panel.webview, file);
        panel.iconPath = new UriIcon('open-preview');
        panel.webview.html = content;
    } else {
        if (isGuestSession) {
            const fileContent = await rGuestService.requestFileContent(file, 'utf8');
            await openVirtualDoc(file, fileContent, true, true, ViewColumn[viewer]);
        } else {
            await commands.executeCommand('vscode.open', Uri.file(file), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[viewer],
            });
        }
    }
    console.info('[showDataView] Done');
}

export async function getTableHtml(webview: Webview, file: string): Promise<string> {
    resDir = isGuestSession ? guestResDir : resDir;
    const content = await readContent(file, 'utf8');
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
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'ag-theme-balham-dark.min.css'))))}" rel="stylesheet">
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
            filterParams: {
            buttons: ['reset', 'apply']
            }
        },
        columnDefs: data.columns,
        rowData: data.data,
        rowSelection: 'multiple',
        pagination: true,
        enableCellTextSelection: true,
        ensureDomOrder: true,
        onGridReady: function (params) {
            gridOptions.api.sizeColumnsToFit();
            autoSizeAll(false);
        }
    };
    function updateTheme() {
        const gridDiv = document.querySelector('#myGrid');
        if (document.body.classList.contains('vscode-light')) {
            gridDiv.className = 'ag-theme-balham';
        } else {
            gridDiv.className = 'ag-theme-balham-dark';
        }
    }
    function autoSizeAll(skipHeader) {
        var allColumnIds = [];
        gridOptions.columnApi.getAllColumns().forEach(function (column) {
            allColumnIds.push(column.colId);
        });
        gridOptions.columnApi.autoSizeColumns(allColumnIds, skipHeader);
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

export async function getListHtml(webview: Webview, file: string): Promise<string> {
    resDir = isGuestSession ? guestResDir : resDir;
    const content = await readContent(file, 'utf8');

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
    const body = (await readContent(file, 'utf8')).toString()
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

async function updateRequest(sessionStatusBarItem: StatusBarItem) {
    console.info('[updateRequest] Started');
    console.info(`[updateRequest] requestFile: ${requestFile}`);
    const lockContent = await fs.readFile(requestLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== requestTimeStamp) {
        requestTimeStamp = newTimeStamp;
        const requestContent = await fs.readFile(requestFile, 'utf8');
        console.info(`[updateRequest] request: ${requestContent}`);
        const request = JSON.parse(requestContent);
        if (isFromWorkspace(request.wd)) {
            if (request.uuid === null || request.uuid === undefined || request.uuid === UUID) {
                switch (request.command) {
                    case 'help': {
                        if (globalRHelp) {
                            console.log(request.requestPath);
                            void globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                        }
                        break;
                    }
                    case 'httpgd': {
                        if (request.url) {
                            globalHttpgdManager?.showViewer(request.url);
                        }
                        break;
                    }
                    case 'attach': {
                        rVer = String(request.version);
                        pid = String(request.pid);
                        info = request.info;
                        sessionDir = path.join(request.tempdir, 'vscode-R');
                        workingDir = request.wd;
                        console.info(`[updateRequest] attach PID: ${pid}`);
                        sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
                        sessionStatusBarItem.tooltip = `${info.version}\nProcess ID: ${pid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to active terminal.`;
                        sessionStatusBarItem.show();
                        updateSessionWatcher();
                        purgeAddinPickerItems();
                        if (request.plot_url) {
                            globalHttpgdManager?.showViewer(request.plot_url);
                        }
                        break;
                    }
                    case 'browser': {
                        await showBrowser(request.url, request.title, request.viewer);
                        break;
                    }
                    case 'webview': {
                        void showWebView(request.file, request.title, request.viewer);
                        break;
                    }
                    case 'dataview': {
                        void showDataView(request.source,
                            request.type, request.title, request.file, request.viewer);
                        break;
                    }
                    case 'rstudioapi': {
                        await dispatchRStudioAPICall(request.action, request.args, request.sd);
                        break;
                    }
                    default:
                        console.error(`[updateRequest] Unsupported command: ${request.command}`);
                }
            }
        } else {
            console.info(`[updateRequest] Ignored request outside workspace`);
        }
        if (isLiveShare()) {
            void rHostService.notifyRequest(requestFile);
        }
    }
}
