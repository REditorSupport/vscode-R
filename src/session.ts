'use strict';

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Agent } from 'http';
import fetch from 'node-fetch';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace, env, WebviewPanelOnDidChangeViewStateEvent, WebviewPanel } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { FSWatcher } from 'fs-extra';
import { config, readContent, setContext, UriIcon} from './util';
import { purgeAddinPickerItems, dispatchRStudioAPICall } from './rstudioapi';

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

interface WebviewMessage {
    command: string;
    start?: number;
    end?: number;
}

interface PanelWithFetchFlag {
  _hasFetchHandler?: boolean;
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
let activeBrowserPanel: WebviewPanel | undefined;
let activeBrowserUri: Uri | undefined;
let activeBrowserExternalUri: Uri | undefined;

// Add a map to track dataview panels by UUID
const dataviewPanels = new Map<string, WebviewPanel>();

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
            void commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[(config().get<string>('session.viewers.viewColumn.plot') || 'Two') as keyof typeof ViewColumn],
            });
            console.info('[updatePlot] Done');
            if (isLiveShare()) {
                void rHostService?.notifyPlot(plotFile);
            }
        } else {
            console.info('[updatePlot] File not found');
        }
    }
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

export async function showDataView(source: string, type: string, title: string, file: string, viewer: string, dataview_uuid?: string): Promise<void> {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, 
                 viewer: ${viewer}, dataview_uuid: ${String(dataview_uuid)}`);

    if (isGuestSession) {
        resDir = guestResDir;
    }

    // Check if we have an existing panel with this UUID
    let panel: WebviewPanel | undefined;
    if (dataview_uuid && dataviewPanels.has(dataview_uuid)) {
        panel = dataviewPanels.get(dataview_uuid);
        // Panel might have been closed, check if it's still valid
        if (panel) {
            try {
                panel.title = title;
                panel.reveal(ViewColumn[viewer as keyof typeof ViewColumn]);
                
                await panel?.webview.postMessage({ command: 'refreshDataview' });
                
            } catch (e) {
                console.log(`Panel was disposed, creating new one: ${String(e)}`);
                dataviewPanels.delete(dataview_uuid);
                panel = undefined;
            }
        }
    }

    if (!panel) {
        if (source === 'table' || source === 'list') {
            panel = window.createWebviewPanel('dataview', title,
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

            if (dataview_uuid) {
                dataviewPanels.set(dataview_uuid, panel);
                panel.onDidDispose(() => {
                    dataviewPanels.delete(dataview_uuid);
                });
            }
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
    }

    // Register the message handler after panel is created or retrieved, but only once per panel
    const p = panel as PanelWithFetchFlag;
    if (panel && !p._hasFetchHandler) {
        panel.webview.onDidReceiveMessage(async (message: WebviewMessage & {
          requestId?: string;
          sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
          filterModel?: {[colId: string]: any};
        }) => {
            if (message.command === 'fetchRows') {
                try {
                    const { start, end, sortModel, filterModel, requestId } = message;
                    
                    console.log('[fetchRows] Sending to R:', {varname: title, start, end, sortModel, filterModel});
                    
                    if (!server) {
                        throw new Error('R server not available');
                    }

                    const response: unknown = await sessionRequest(server, {
                        type: 'dataview_fetch_rows',
                        varname: title,
                        start,
                        end,
                        sortModel, 
                        filterModel
                    });
                    
                    if (typeof response !== 'object' || 
                        response === null || 
                        !('rows' in response) || 
                        !('totalRows' in response) ||
                        !('totalUnfiltered' in response)) {
                        throw new Error('Invalid response from R server');
                    }
                    
                    const rows: unknown = (response as {rows: object[]}).rows;
                    const totalRows: unknown = (response as {totalRows: number}).totalRows;
                    const totalUnfiltered: unknown = (response as {totalUnfiltered: number}).totalUnfiltered;
                    
                    if (!Array.isArray(rows) || typeof totalRows !== 'number') {
                        throw new Error('Fetched rows or totalRows invalid');
                    }
                    
                    await panel?.webview.postMessage({
                        command: 'fetchedRows',
                        start,
                        end,
                        rows: rows as object[],
                        totalRows,
                        totalUnfiltered,
                        requestId
                    });
                } catch (error) {
                    console.error('[fetchRows] Error:', error);
                    await panel?.webview.postMessage({
                        command: 'fetchError',
                        error: String(error),
                        requestId: message.requestId
                    });
                }
            }
        });
        p._hasFetchHandler = true;
    }

    if (panel) {
        if (source === 'table') {
            const content = await getTableHtml(panel.webview, file);
            panel.webview.html = content;
            await panel?.webview.postMessage({ command: 'initAgGridRequestMap' });
        } else if (source === 'list') {
            const content = await getListHtml(panel.webview, file);
            panel.webview.html = content;
        }
    }

    console.info('[showDataView] Done');
}

export async function getTableHtml(webview: Webview, file: string): Promise<string> {
    try {
        resDir = isGuestSession ? guestResDir : resDir;
        const content = await readContent(file, 'utf8');
        if (!content) {
            console.error('[getTableHtml] Empty content');
            throw new Error('Empty content in getTableHtml');
        }
        //const data = JSON.parse(content);
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
    
    [class*="vscode"] div.ag-header-cell.ag-header-cell-filtered, div.ag-header-cell[aria-filtered="true"] {
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
    
    const vscode = acquireVsCodeApi();
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
    const booleanFilterParams = {
        filterOptions: ['equals'],
        defaultOption: 'equals',
        filterPlaceholder: '1=TRUE, 0=FALSE...'
    };
    const data = ${String(content)};
    const displayDataSource = {
        rowCount: undefined,
        getRows(params) {

        const msg = {
            command:     'fetchRows',
            start:       params.startRow,
            end:         params.endRow,
            sortModel:   params.sortModel,
            filterModel: params.filterModel,
            requestId: Math.random().toString(36).substr(2, 9)
        };
        
        const handler = event => {
            const m = event.data;
            if (m.command   === 'fetchedRows' && m.requestId === msg.requestId) {
              
              displayDataSource._TotalRows = m.totalRows;
              displayDataSource._TotalUnfiltered = m.totalUnfiltered;
              
              displayDataSource.api.refreshHeader();
              
              const totalRows = m.totalRows;
              let lastRow = -1;
              if (totalRows <= params.endRow) {
                lastRow = totalRows;
              }
              params.successCallback(m.rows, lastRow);
              window.removeEventListener('message', handler);
            } 
        };
        window.addEventListener('message', handler);
        vscode.postMessage(msg);
      }
    };

    const columnDefs = data.columns.map(col => {
        if (col.type === "booleanColumn") {
          return {
            ...col,
            valueFormatter: params =>
              params.value === true 
              ? 'TRUE'
              : params.value === false
                  ? 'FALSE'
                  : ''
          };
        } else if (col.type === "dateColumn") {
          return {
            ...col, 
            width: 200
          };
        }
      
        if (col.field === "x2") {
          return {
            ...col,
            hide: true
          };
        }
        else if (col.field === "x1") {
          return {
            ...col,
            sortable:     false,
            filter:       false,
            lockPosition: 'left',
            suppressHeaderMenuButton: true,
            width:        150,
            headerValueGetter: () => {
              const a = displayDataSource._TotalRows || 0;
              const b = displayDataSource._TotalUnfiltered || 0;
              return '(' + a + '/' + b + ')';
            }
          };
        }

        
        return col;
      });
    
    const gridOptions = {
        defaultColDef: {
            sortable: true,
            resizable: true,
            filter: true,
            width: 150,
            minWidth: 100,
            floatingFilter: true, 
            suppressHeaderMenuButton: true,
            lockPinned: true,
            filterParams: {
                buttons: ['apply', 'reset'],
                closeOnApply: true,
                maxNumConditions: 1
            }
        },
        
        columnDefs: columnDefs,
        getRowId: function(params) {
            return params.data.x2;
        },

        suppressColumnVirtualisation: true,
        alwaysShowVerticalScroll: true,
        debounceVerticalScrollbar: true,
        
        ensureDomOrder: true,
        rowHeight: 25,
        rowModelType: 'infinite',
        cacheBlockSize: 100,
        maxBlocksInCache: 20,
        infiniteInitialRowCount: 100,
        rowBuffer: 5,
        blockLoadDebounceMillis: 300,
      
        rowSelection: 'multiple',
        enableCellTextSelection: true,
        suppressRowTransform: true,
        animateRows: false,
        
        onFirstDataRendered: onFirstDataRendered,
        
        onSortChanged: function(params) {
            params.api.purgeInfiniteCache();
        }, 
        onFilterChanged: function(params) {
        console.log("onFilterChanged - new filterModel:", params.api.getFilterModel());
          params.api.purgeInfiniteCache();
        }
      };
    
    function onFirstDataRendered(params) {
        params.api.autoSizeAllColumns(false);

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
            else if (column.type == 'booleanColumn') {
                column.filterParams = booleanFilterParams;
            }
        });
        
        const gridDiv = document.querySelector('#myGrid');
        const gridApi = agGrid.createGrid(gridDiv, gridOptions);

        displayDataSource.api = gridApi;        
        gridApi.setGridOption('datasource', displayDataSource);
        
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'refreshDataview') {

              gridApi.setFilterModel(null);
              gridApi.onFilterChanged();            

              gridApi.resetColumnState();      
              gridApi.autoSizeAllColumns(false);

              gridApi.purgeInfiniteCache();           
              gridApi.ensureIndexVisible(0, 'top');   
            }
          });
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
    } catch (error) {
        console.error('[getTableHtml] Error:', error);
        throw error;
    }
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
    server?: SessionServer,
    dataview_uuid?: string  // Add this property to match the R code
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
            if (request.uuid === null || request.uuid === undefined || String(request.uuid) === String(UUID)) {
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
                    case 'attach': {
                        if (!request.tempdir || !request.wd) {
                            return;
                        }
                        rVer = String(request.version);
                        pid = String(request.pid);
                        info = request.info;
                        sessionDir = path.join(request.tempdir, 'vscode-R');
                        workingDir = request.wd;
                        console.info(`[updateRequest] attach PID: ${pid}`);
                        sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
                        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-member-access
                        sessionStatusBarItem.tooltip = `${info?.version}\nProcess ID: ${pid}\nCommand: ${info?.command}\nStart time: ${info?.start_time}\nClick to attach to active terminal.`;
                        sessionStatusBarItem.show();
                        updateSessionWatcher();

                        if (request.server) {
                            server = request.server;
                        }

                        purgeAddinPickerItems();
                        await setContext('rSessionActive', true);
                        if (request.plot_url) {
                            await globalHttpgdManager?.showViewer(request.plot_url);
                        }
                        void watchProcess(pid).then((v: string) => {
                            void cleanupSession(v);
                        });
                        break;
                    }
                    case 'detach': {
                        if (request.pid) {
                            await cleanupSession(request.pid);
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
                            await showWebView(request.file, request.title, request.viewer);
                        }
                        break;
                    }
                    case 'dataview': {
                        if (request.source && request.type && request.file && request.title && request.viewer !== undefined) {
                            // Use dataview_uuid for panel tracking, preserve uuid for LiveShare
                            await showDataView(request.source,
                                request.type, request.title, request.file, request.viewer, request.dataview_uuid);
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
        } else {
            console.info(`[updateRequest] Ignored request outside workspace`);
        }
        if (isLiveShare()) {
            void rHostService?.notifyRequest(requestFile);
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
            timeout: 120000,
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
