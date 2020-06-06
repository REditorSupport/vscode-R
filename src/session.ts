// tslint:disable: no-console
'use strict';

import fs = require('fs-extra');
import os = require('os');
import path = require('path');
import { URL } from 'url';
import { commands, StatusBarItem, Uri, ViewColumn, Webview, window, workspace } from 'vscode';

import { chooseTerminalAndSendText } from './rTerminal';
import { config } from './util';
import { FSWatcher } from 'fs-extra';

export let globalenv: any;
let resDir: string;
let watcherDir: string;
let requestFile: string;
let requestLockFile: string;
let requestTimeStamp: number;
let sessionDir: string;
let pid: string;
let globalenvFile: string;
let globalenvLockFile: string;
let globalenvTimeStamp: number;
let plotFile: string;
let plotLockFile: string;
let plotTimeStamp: number;
let plotDir: string;
let requestWatcher: FSWatcher;
let globalEnvWatcher: FSWatcher;
let plotWatcher: FSWatcher;


export function deploySessionWatcher(extensionPath: string) {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');
    watcherDir = path.join(os.homedir(), '.vscode-R');
    console.info(`[deploySessionWatcher] watcherDir: ${watcherDir}`);
    if (!fs.existsSync(watcherDir)) {
        console.info('[deploySessionWatcher] watcherDir not exists, create directory');
        fs.mkdirSync(watcherDir);
    }
    console.info('[deploySessionWatcher] Deploy init.R');
    fs.copySync(path.join(extensionPath, 'R', 'init.R'), path.join(watcherDir, 'init.R'));
    console.info('[deploySessionWatcher] Deploy .Rprofile');
    fs.copySync(path.join(extensionPath, 'R', '.Rprofile'), path.join(watcherDir, '.Rprofile'));
    console.info('[deploySessionWatcher] Done');
}

export function startRequestWatcher(sessionStatusBarItem: StatusBarItem) {
    console.info('[startRequestWatcher] Starting');
    requestFile = path.join(watcherDir, 'request.log');
    requestLockFile = path.join(watcherDir, 'request.lock');
    requestTimeStamp = 0;
    if (!fs.existsSync(requestLockFile)) {
        fs.createFileSync(requestLockFile);
    }
    requestWatcher = fs.watch(requestLockFile, {}, (event: string, filename: string) => {
        updateRequest(sessionStatusBarItem);
    });
    console.info('[startRequestWatcher] Done');
}

export function attachActive() {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActive]');
        chooseTerminalAndSendText('getOption(\'vscodeR\')$attach()');
    } else {
        window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
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

export function removeSessionFiles() {
    console.info('[removeSessionFiles] ', sessionDir);
    if (fs.existsSync(sessionDir)) {
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
    globalEnvWatcher = fs.watch(globalenvLockFile, {}, (event: string, filename: string) => {
        updateGlobalenv();
    });
    console.info('[updateSessionWatcher] Create plotWatcher');
    plotFile = path.join(sessionDir, 'plot.png');
    plotLockFile = path.join(sessionDir, 'plot.lock');
    plotTimeStamp = 0;
    if (plotWatcher !== undefined) {
        plotWatcher.close();
    }
    plotWatcher = fs.watch(plotLockFile, {}, (event: string, filename: string) => { 
        updatePlot();
    });
    console.info('[updateSessionWatcher] Done');
}

async function updatePlot() {
    console.info(`[updatePlot] ${plotFile}`);
    const lockContent = await fs.readFile(plotLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== plotTimeStamp) {
        plotTimeStamp = newTimeStamp;
        if (fs.existsSync(plotFile) && fs.statSync(plotFile).size > 0) {
            commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn.Two,
            });
            console.info('[updatePlot] Done');
        }    
    }
}

async function updateGlobalenv() {
    console.info(`[updateGlobalenv] ${globalenvFile}`);
    const lockContent = await fs.readFile(globalenvLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== globalenvTimeStamp) {
        globalenvTimeStamp = newTimeStamp;
        const content = await fs.readFile(globalenvFile, 'utf8');
        globalenv = JSON.parse(content);
        console.info('[updateGlobalenv] Done');
    }
}

function showBrowser(url: string) {
    console.info(`[showBrowser] uri: ${url}`);
    const port = parseInt(new URL(url).port, 10);
    const panel = window.createWebviewPanel(
        'browser',
        url,
        {
            preserveFocus: true,
            viewColumn: ViewColumn.Active,
        },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            portMapping: [
                {
                    extensionHostPort: port,
                    webviewPort: port,
                },
            ],
        });
    panel.webview.html = getBrowserHtml(url);
    console.info('[showBrowser] Done');
}

function getBrowserHtml(url: string) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
    <div style="border:0px;position:absolute;left:0px;top:0px;bottom:0px;right:0px;">
        <iframe src="${url}"; width="100%" height="100%" frameborder="0" />
    </div>
</body>
</html>
`;
}

async function showWebView(file: string, viewColumn: ViewColumn) {
    console.info(`[showWebView] file: ${file}`);
    const dir = path.dirname(file);
    const panel = window.createWebviewPanel('webview', 'WebView',
                                            {
            preserveFocus: true,
            viewColumn,
        },
                                            {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [Uri.file(dir)],
        });
    const content = await fs.readFile(file);
    const html = content.toString()
        .replace('<body>', '<body style="color: black;">')
        .replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
                 `<$1 $2="${String(panel.webview.asWebviewUri(Uri.file(dir)))}/`);
    panel.webview.html = html;
    console.info('[showWebView] Done');
}

async function showDataView(source: string, type: string, title: string, file: string) {
    console.info(`[showDataView] source: ${source}, type: ${type}, title: ${title}, file: ${file}`);
    if (source === 'table') {
        const panel = window.createWebviewPanel('dataview', title,
                                                {
                preserveFocus: true,
                viewColumn: ViewColumn.Two,
            },
                                                {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(resDir)],
            });
        const content = await getTableHtml(panel.webview, file);
        panel.webview.html = content;
    } else if (source === 'list') {
        const panel = window.createWebviewPanel('dataview', title,
                                                {
                preserveFocus: true,
                viewColumn: ViewColumn.Two,
            },
                                                {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(resDir)],
            });
        const content = await getListHtml(panel.webview, file);
        panel.webview.html = content;
    } else {
        commands.executeCommand('vscode.open', Uri.file(file), {
            preserveFocus: true,
            preview: true,
            viewColumn: ViewColumn.Active,
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

export async function showPlotHistory() {
    if (config().get<boolean>('sessionWatcher')) {
        if (plotDir === undefined) {
            window.showErrorMessage('No session is attached.');
        } else {
            const files = await fs.readdir(plotDir);
            if (files.length > 0) {
                const panel = window.createWebviewPanel('plotHistory', 'Plot History',
                                                        {
                        preserveFocus: true,
                        viewColumn: ViewColumn.Two,
                    },
                                                        {
                        retainContextWhenHidden: true,
                        enableScripts: true,
                        localResourceRoots: [Uri.file(resDir), Uri.file(plotDir)],
                    });
                const html = getPlotHistoryHtml(panel.webview, files);
                panel.webview.html = html;
            } else {
                window.showInformationMessage('There is no plot to show yet.');
            }
        }
    } else {
        window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
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
    for (const folder of workspace.workspaceFolders) {
        const rel = path.relative(folder.uri.fsPath, dir);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return true;
        }
    }
    return false;
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
        const parseResult = JSON.parse(requestContent);
        if (isFromWorkspace(parseResult.wd)) {
            switch (parseResult.command) {
                case 'attach':
                    pid = String(parseResult.pid);
                    sessionDir = path.join(parseResult.tempdir, 'vscode-R');
                    plotDir = path.join(sessionDir, 'images');
                    console.info(`[updateRequest] attach PID: ${pid}`);
                    sessionStatusBarItem.text = `R: ${pid}`;
                    sessionStatusBarItem.show();
                    updateSessionWatcher();
                    updateGlobalenv();
                    updatePlot();
                    break;
                case 'browser':
                    showBrowser(parseResult.url);
                    break;
                case 'webview':
                    const viewColumn: string = parseResult.viewColumn;
                    showWebView(parseResult.file, ViewColumn[viewColumn]);
                    break;
                case 'dataview':
                    showDataView(parseResult.source,
                        parseResult.type, parseResult.title, parseResult.file);
                    break;
                default:
                    console.error(`[updateRequest] Unsupported command: ${parseResult.command}`);
            }
        } else {
            console.info(`[updateRequest] Ignored request not from workspace`);
        }
    }
}
