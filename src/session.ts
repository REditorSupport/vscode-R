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
import { config } from './util';
import { purgeAddinPickerItems, dispatchRStudioAPICall } from './rstudioapi';

import { rWorkspace, globalRHelp } from './extension';

export let globalenv: any;
let resDir: string;
export let watcherDir: string;
let requestFile: string;
let requestLockFile: string;
let requestTimeStamp: number;
let responseTimeStamp: number;
export let sessionDir: string;
export let workingDir: string;
let pid: string;
let globalenvFile: string;
let globalenvLockFile: string;
let globalenvTimeStamp: number;
let plotView: string;
let plotFile: string;
let plotLockFile: string;
let plotTimeStamp: number;
let plotDir: string;
let globalEnvWatcher: FSWatcher;
let plotWatcher: FSWatcher;
let activeBrowserPanel: WebviewPanel;
let activeBrowserUri: Uri;
let activeBrowserExternalUri: Uri;

export function deploySessionWatcher(extensionPath: string): void {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');
    watcherDir = path.join(os.homedir(), '.vscode-R');
    console.info(`[deploySessionWatcher] watcherDir: ${watcherDir}`);
    if (!fs.existsSync(watcherDir)) {
        console.info('[deploySessionWatcher] watcherDir not exists, create directory');
        fs.mkdirSync(watcherDir);
    }
    const initPath = path.join(extensionPath, 'R', 'init.R');
    const linkPath = path.join(watcherDir, 'init.R');
    fs.writeFileSync(linkPath, `local(source("${initPath.replace(/\\/g, '\\\\')}", chdir = TRUE, local = TRUE))\n`);
}

export function startRequestWatcher(sessionStatusBarItem: StatusBarItem): void {
    console.info('[startRequestWatcher] Starting');
    requestFile = path.join(watcherDir, 'request.log');
    requestLockFile = path.join(watcherDir, 'request.lock');
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
    } else {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}

function removeDirectory(dir: string) {
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
                viewColumn: ViewColumn[plotView],
            });
            console.info('[updatePlot] Done');
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
            rWorkspace?.refresh();
            console.info('[updateGlobalenv] Done');
        } else {
            console.info('[updateGlobalenv] File not found');
        }
    }
}

async function showBrowser(url: string, title: string, viewer: string | boolean) {
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
            void commands.executeCommand('setContext', 'r.browser.active', false);
        });
        panel.webview.html = getBrowserHtml(externalUri);
    }
    console.info('[showBrowser] Done');
}

function getBrowserHtml(uri: Uri) {
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

export function refreshBrowser():void {
    console.log('[refreshBrowser]');
    if (activeBrowserPanel) {
        activeBrowserPanel.webview.html = '';
        activeBrowserPanel.webview.html = getBrowserHtml(activeBrowserExternalUri);
    }
}

export function openExternalBrowser():void {
    console.log('[openExternalBrowser]');
    if (activeBrowserUri) {
        void env.openExternal(activeBrowserUri);
    }
}

async function showWebView(file: string, title: string, viewer: string | boolean) {
    console.info(`[showWebView] file: ${file}, viewer: ${viewer.toString()}`);
    if (viewer === false) {
        void env.openExternal(Uri.parse(file));
    } else {
        const dir = path.dirname(file);
        const panel = window.createWebviewPanel('webview', title,
            {
                preserveFocus: true,
                viewColumn: ViewColumn[String(viewer)],
            },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(dir)],
            });
        const content = await fs.readFile(file);
        const html = content.toString()
            .replace('<body>', '<body style="color: black;">')
            .replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
                `<$1 $2="${String(panel.webview.asWebviewUri(Uri.file(dir)))}/`);
        panel.webview.html = html;
    }
    console.info('[showWebView] Done');
}

async function showDataView(source: string, type: string, title: string, file: string, viewer: string) {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}, viewer: ${viewer}`);
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
        panel.webview.html = content;
    } else {
        await commands.executeCommand('vscode.open', Uri.file(file), {
            preserveFocus: true,
            preview: true,
            viewColumn: ViewColumn[viewer],
        });
    }
    console.info('[showDataView] Done');
}

async function getTableHtml(webview: Webview, file: string) {
    const content = await fs.readFile(file);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'bootstrap.min.css'))))}" rel="stylesheet">
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'dataTables.bootstrap4.min.css'))))}" rel="stylesheet">
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'fixedHeader.jqueryui.min.css'))))}" rel="stylesheet">
  <style type="text/css">
    body {
        color: black;
        background-color: white;
    }
    table {
        font-size: 0.75em;
    }
  </style>
</head>
<body>
  <div class="container-fluid">
    <table id="data-table" class="display table table-sm table-striped table-condensed table-hover"></table>
  </div>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.min.js'))))}"></script>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.dataTables.min.js'))))}"></script>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'dataTables.bootstrap4.min.js'))))}"></script>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'dataTables.fixedHeader.min.js'))))}"></script>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'fixedHeader.jqueryui.min.js'))))}"></script>
  <script>
    var data = ${String(content)};
    $(document).ready(function () {
      $("#data-table").DataTable({
        data: data.data,
        columns: data.columns,
        paging: false,
        autoWidth: false,
        order: [],
        fixedHeader: true
      });
      $("#data-table tbody").on("click", "tr", function() {
        $(this).toggleClass("table-active");
      });
    });
  </script>
</body>
</html>
`;
}

async function getListHtml(webview: Webview, file: string) {
    const content = await fs.readFile(file);

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
        color: black;
        background-color: white;
    }
    pre#json-renderer {
      border: 1px solid #aaa;
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

export async function showPlotHistory(): Promise<void> {
    if (config().get<boolean>('sessionWatcher')) {
        if (plotDir === undefined) {
            void window.showErrorMessage('No session is attached.');
        } else {
            const files = await fs.readdir(plotDir);
            if (files.length > 0) {
                const panel = window.createWebviewPanel('plotHistory', 'Plot History',
                    {
                        preserveFocus: true,
                        viewColumn: ViewColumn.Active,
                    },
                    {
                        retainContextWhenHidden: true,
                        enableScripts: true,
                        localResourceRoots: [Uri.file(resDir), Uri.file(plotDir)],
                    });
                const html = getPlotHistoryHtml(panel.webview, files);
                panel.webview.html = html;
            } else {
                void window.showInformationMessage('There is no plot to show yet.');
            }
        }
    } else {
        void window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}

function getPlotHistoryHtml(webview: Webview, files: string[]) {
    const imgs = files
        .map((file) => `<img src="${String(webview.asWebviewUri(Uri.file(path.join(plotDir, file))))}" />`)
        .join('\n');

    return `
<!doctype HTML>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'bootstrap.min.css'))))}" rel="stylesheet">
  <link href="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'fotorama.css'))))}" rel="stylesheet">
  <style type="text/css">
    body {
        background-color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="text-center">
      <div class="fotorama" data-width="100%" data-maxheight="100%" data-nav="thumbs" data-keyboard="true">
        ${imgs}
      </div>
    </div>
  </div>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'jquery.min.js'))))}"></script>
  <script src="${String(webview.asWebviewUri(Uri.file(path.join(resDir, 'fotorama.js'))))}"></script>
</body>
</html>
`;
}

function isFromWorkspace(dir: string) {
    if (workspace.workspaceFolders === undefined) {
        const rel = path.relative(os.homedir(), dir);
        if (rel === '') {
            return true;
        }
    } else {
        for (const folder of workspace.workspaceFolders) {
            const rel = path.relative(folder.uri.fsPath, dir);
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
            switch (request.command) {
                case 'help': {
                    if(globalRHelp){
                        console.log(request.requestPath);
                        void globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                    }
                    break;
                }
                case 'attach': {
                    pid = String(request.pid);
                    sessionDir = path.join(request.tempdir, 'vscode-R');
                    workingDir = request.wd;
                    plotDir = path.join(sessionDir, 'images');
                    plotView = String(request.plot);
                    console.info(`[updateRequest] attach PID: ${pid}`);
                    sessionStatusBarItem.text = `R: ${pid}`;
                    sessionStatusBarItem.show();
                    updateSessionWatcher();
                    purgeAddinPickerItems();
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
        } else {
            console.info(`[updateRequest] Ignored request outside workspace`);
        }
    }
}
