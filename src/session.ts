// tslint:disable: no-console
'use strict';

import fs = require('fs-extra');
import os = require('os');
import path = require('path');
import { URL } from 'url';
import { commands, FileSystemWatcher, RelativePattern, StatusBarItem, Uri, ViewColumn, Webview, window, workspace } from 'vscode';

import { chooseTerminalAndSendText } from './rTerminal';
import { config } from './util';

export let globalenv: any;
let responseWatcher: FileSystemWatcher;
let globalEnvWatcher: FileSystemWatcher;
let plotWatcher: FileSystemWatcher;
let pid: string;
let tempDir: string;
let plotDir: string;
let resDir: string;
let responseLineCount: number;
const sessionDir = path.join('.vscode', 'vscode-R');

export function deploySessionWatcher(extensionPath: string) {
    console.info(`[deploySessionWatcher] extensionPath: ${extensionPath}`);
    resDir = path.join(extensionPath, 'dist', 'resources');
    const targetDir = path.join(os.homedir(), '.vscode-R');
    console.info(`[deploySessionWatcher] targetDir: ${targetDir}`);
    if (!fs.existsSync(targetDir)) {
        console.info('[deploySessionWatcher] targetDir not exists, create directory');
        fs.mkdirSync(targetDir);
    }
    console.info('[deploySessionWatcher] Deploy init.R');
    fs.copySync(path.join(extensionPath, 'R', 'init.R'), path.join(targetDir, 'init.R'));
    console.info('[deploySessionWatcher] Deploy .Rprofile');
    fs.copySync(path.join(extensionPath, 'R', '.Rprofile'), path.join(targetDir, '.Rprofile'));
    console.info('[deploySessionWatcher] Done');
}

export function startResponseWatcher(sessionStatusBarItem: StatusBarItem) {
    console.info('[startResponseWatcher] Starting');
    responseLineCount = 0;
    responseWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join('.vscode', 'vscode-R', 'response.log')));
    responseWatcher.onDidCreate(() => updateResponse(sessionStatusBarItem));
    responseWatcher.onDidChange(() => updateResponse(sessionStatusBarItem));
    console.info('[startResponseWatcher] Done');
}

export function attachActive() {
    if (workspace.getConfiguration('r').get<boolean>('sessionWatcher')) {
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
    const sessionPath = path.join(
        workspace.workspaceFolders[0].uri.fsPath, sessionDir, pid);
    console.info('[removeSessionFiles] ', sessionPath);
    if (fs.existsSync(sessionPath)) {
        removeDirectory(sessionPath);
    }
    console.info('[removeSessionFiles] Done');
}

function updateSessionWatcher() {
    console.info(`[updateSessionWatcher] PID: ${pid}`);
    console.info('[updateSessionWatcher] Create globalEnvWatcher');
    globalEnvWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join(sessionDir, pid, 'globalenv.json')));
    globalEnvWatcher.onDidChange(updateGlobalenv);

    console.info('[updateSessionWatcher] Create plotWatcher');
    plotWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join(sessionDir, pid, 'plot.png')));
    plotWatcher.onDidCreate(updatePlot);
    plotWatcher.onDidChange(updatePlot);

    console.info('[updateSessionWatcher] Done');
}

function _updatePlot() {
    const plotPath = path.join(workspace.workspaceFolders[0].uri.fsPath,
                               sessionDir, pid, 'plot.png');
    console.info(`[_updatePlot] ${plotPath}`);
    if (fs.existsSync(plotPath)) {
        commands.executeCommand('vscode.open', Uri.file(plotPath), {
            preserveFocus: true,
            preview: true,
            viewColumn: ViewColumn.Two,
        });
        console.info('[_updatePlot] Done');
    }
}

function updatePlot(event) {
    _updatePlot();
}

async function _updateGlobalenv() {
    const globalenvPath = path.join(workspace.workspaceFolders[0].uri.fsPath,
                                    sessionDir, pid, 'globalenv.json');
    console.info(`[_updateGlobalenv] ${globalenvPath}`);
    const content = await fs.readFile(globalenvPath, 'utf8');
    globalenv = JSON.parse(content);
    console.info('[_updateGlobalenv] Done');
}

async function updateGlobalenv(event) {
    _updateGlobalenv();
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
        .replace('<body>', '<body style="color: black;"')
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
    if (workspace.getConfiguration('r').get<boolean>('sessionWatcher')) {
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

async function updateResponse(sessionStatusBarItem: StatusBarItem) {
    console.info('[updateResponse] Started');
    // Read last line from response file
    const responseLogFile = path.join(workspace.workspaceFolders[0].uri.fsPath,
                                      sessionDir, 'response.log');
    console.info(`[updateResponse] responseLogFile: ${responseLogFile}`);
    const content = await fs.readFile(responseLogFile, 'utf8');
    const lines = content.split('\n');
    if (lines.length !== responseLineCount) {
        responseLineCount = lines.length;
        console.info(`[updateResponse] lines: ${responseLineCount}`);
        const lastLine = lines[lines.length - 2];
        console.info(`[updateResponse] lastLine: ${lastLine}`);
        const parseResult = JSON.parse(lastLine);
        switch (parseResult.command) {
            case 'attach':
                pid = String(parseResult.pid);
                tempDir = parseResult.tempdir;
                plotDir = path.join(tempDir, 'images');
                console.info(`[updateResponse] attach PID: ${pid}`);
                sessionStatusBarItem.text = `R: ${pid}`;
                sessionStatusBarItem.show();
                updateSessionWatcher();
                _updateGlobalenv();
                _updatePlot();
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
                console.error(`[updateResponse] Unsupported command: ${parseResult.command}`);
        }
    } else {
        console.warn('[updateResponse] Duplicate update on response change');
    }
}
