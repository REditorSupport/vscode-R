"use strict";

import fs = require("fs-extra");
import os = require("os");
import path = require("path");
import { URL } from "url";
import { commands, FileSystemWatcher, RelativePattern, StatusBarItem, Uri, ViewColumn, Webview, window, workspace } from "vscode";
import { chooseTerminalAndSendText } from "./rTerminal";
import { config } from "./util";

export let globalenv: any;
let responseWatcher: FileSystemWatcher;
let globalEnvWatcher: FileSystemWatcher;
let plotWatcher: FileSystemWatcher;
let PID: string;
let tempDir: string;
let plotDir: string;
let resDir: string;
const sessionDir = path.join(".vscode", "vscode-R");

export function deploySessionWatcher(extensionPath: string) {
    resDir = path.join(extensionPath, "dist", "resources");
    const srcPath = path.join(extensionPath, "R", "init.R");
    const targetDir = path.join(os.homedir(), ".vscode-R");
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }
    const targetPath = path.join(targetDir, "init.R");
    fs.copySync(srcPath, targetPath);
}

export function startResponseWatcher(sessionStatusBarItem: StatusBarItem) {
    responseWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join(".vscode", "vscode-R", "response.log")));
    responseWatcher.onDidCreate(() => updateResponse(sessionStatusBarItem));
    responseWatcher.onDidChange(() => updateResponse(sessionStatusBarItem));
}

export function attachActive() {
    if (config.get("sessionWatcher")) {
        chooseTerminalAndSendText("getOption('vscodeR')$attach()");
    } else {
        window.showInformationMessage("This command requires that r.sessionWatcher be enabled.");
    }
}

function removeDirectory(dir: string) {
    if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach((file) => {
            const curPath = path.join(dir, file);
            fs.unlinkSync(curPath);
        });
        fs.rmdirSync(dir);
    }
}

export function removeSessionFiles() {
    const sessionPath = path.join(
        workspace.workspaceFolders[0].uri.fsPath, sessionDir, PID);
    console.info("removeSessionFiles: ", sessionPath);
    if (fs.existsSync(sessionPath)) {
        removeDirectory(sessionPath);
    }
}

function updateSessionWatcher() {
    console.info("Updating session to PID " + PID);
    console.info("Create globalEnvWatcher");
    globalEnvWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join(sessionDir, PID, "globalenv.json")));
    globalEnvWatcher.onDidChange(updateGlobalenv);

    console.info("Create plotWatcher");
    plotWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.workspaceFolders[0],
            path.join(sessionDir, PID, "plot.png")));
    plotWatcher.onDidCreate(updatePlot);
    plotWatcher.onDidChange(updatePlot);
}

function _updatePlot() {
    const plotPath = path.join(workspace.workspaceFolders[0].uri.fsPath,
        sessionDir, PID, "plot.png");
    if (fs.existsSync(plotPath)) {
        commands.executeCommand("vscode.open", Uri.file(plotPath), {
            preserveFocus: true,
            preview: true,
            viewColumn: ViewColumn.Two,
        });
        console.info("Updated plot");
    }
}

function updatePlot(event) {
    _updatePlot();
}

async function _updateGlobalenv() {
    const globalenvPath = path.join(workspace.workspaceFolders[0].uri.fsPath,
        sessionDir, PID, "globalenv.json");
    const content = await fs.readFile(globalenvPath, "utf8");
    globalenv = JSON.parse(content);
    console.info("Updated globalenv");
}

async function updateGlobalenv(event) {
    _updateGlobalenv();
}

function showBrowser(url: string) {
    console.info("browser uri: " + url);
    const port = parseInt(new URL(url).port, 10);
    const panel = window.createWebviewPanel("browser", url,
        {
            preserveFocus: true,
            viewColumn: ViewColumn.Active,
        },
        {
            enableScripts: true,
            portMapping: [
                {
                    extensionHostPort: port,
                    webviewPort: port,
                },
            ],
        });
    panel.webview.html = getBrowserHtml(url);
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

async function showWebView(file: string) {
    const dir = path.dirname(file);
    console.info("webview uri: " + file);
    const panel = window.createWebviewPanel("webview", "WebView",
        {
            preserveFocus: true,
            viewColumn: ViewColumn.Two,
        },
        {
            enableScripts: true,
            localResourceRoots: [Uri.file(dir)],
        });
    const content = await fs.readFile(file);
    const html = content.toString()
        .replace("<style>body{background-color:white;}</style>",
            "<style>body{background-color:white;color:black;}</style>")
        .replace(/<script src="/g, '<script src="' + panel.webview.asWebviewUri(Uri.file(dir)) + "/")
        .replace(/<link href="/g, '<link href="' + panel.webview.asWebviewUri(Uri.file(dir)) + "/");
    panel.webview.html = html;
}

async function showDataView(source: string, type: string, title: string, file: string) {
    const panel = window.createWebviewPanel("dataview", title,
        {
            preserveFocus: true,
            viewColumn: ViewColumn.Two,
        },
        {
            enableScripts: true,
            localResourceRoots: [Uri.file(resDir)],
        });
    let content: string;
    if (source === "table") {
        content = await getTableHtml(panel.webview, file);
    } else if (source === "list") {
        content = await getListHtml(panel.webview, file);
    } else {
        console.error("Unsupported data source: " + source);
    }
    panel.webview.html = content;
}

async function getTableHtml(webview: Webview, file: string) {
    const content = await fs.readFile(file);
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="${webview.asWebviewUri(Uri.file(path.join(resDir, "bootstrap.min.css")))}" rel="stylesheet">
  <link href="${webview.asWebviewUri(Uri.file(path.join(resDir, "dataTables.bootstrap4.min.css")))}" rel="stylesheet">
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
    <table id="data-table" class="display compact table table-sm table-striped table-condensed"></table>
  </div>
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.min.js")))}"></script>
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.dataTables.min.js")))}"></script>
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "dataTables.bootstrap4.min.js")))}"></script>
  <script>
    var data = ${content};
    $(document).ready(function () {
      $("#data-table").DataTable({
        data: data.data,
        columns: data.columns,
        paging: false,
        autoWidth: false,
        order: []
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
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.min.js")))}"></script>
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.json-viewer.js")))}"></script>
  <link href="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.json-viewer.css")))}" rel="stylesheet">
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

export async function showPlotHistory() {
    if (config.get("sessionWatcher")) {
        if (plotDir === undefined) {
            window.showErrorMessage("No session is attached.")
        } else {
            const files = await fs.readdir(plotDir);
            if (files.length > 0) {
                const panel = window.createWebviewPanel("plotHistory", "Plot History",
                    {
                        preserveFocus: true,
                        viewColumn: ViewColumn.Two,
                    },
                    {
                        retainContextWhenHidden: true,
                        enableScripts: true,
                        localResourceRoots: [Uri.file(resDir), Uri.file(plotDir)],
                    });
                const html = getPlotHistoryHtml(panel.webview, files)
                panel.webview.html = html;
            } else {
                window.showInformationMessage("There is no plot to show yet.")
            }
        }
    } else {
        window.showInformationMessage("This command requires that r.sessionWatcher be enabled.");
    }
}

function getPlotHistoryHtml(webview: Webview, files: string[]) {
    const imgs = files
        .map((file) => `<img src="${webview.asWebviewUri(Uri.file(path.join(plotDir, file)))}" />`)
        .join("\n");
    return `
<!doctype HTML>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="${webview.asWebviewUri(Uri.file(path.join(resDir, "bootstrap.min.css")))}" rel="stylesheet">
  <link href="${webview.asWebviewUri(Uri.file(path.join(resDir, "fotorama.css")))}" rel="stylesheet">
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
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "jquery.min.js")))}"></script>
  <script src="${webview.asWebviewUri(Uri.file(path.join(resDir, "fotorama.js")))}"></script>
</body>
</html>
`;
}

async function updateResponse(sessionStatusBarItem: StatusBarItem) {
    console.info("Response file updated!");
    // Read last line from response file
    const responseLogFile = path.join(workspace.workspaceFolders[0].uri.fsPath,
        sessionDir, "response.log");
    const content = await fs.readFile(responseLogFile, "utf8");
    const lines = content.split("\n");
    console.info("Read response file");
    const lastLine = lines[lines.length - 2];
    console.info("Last line: " + lastLine);
    const parseResult = JSON.parse(lastLine);
    if (parseResult.command === "attach") {
        PID = String(parseResult.pid);
        tempDir = parseResult.tempdir;
        plotDir = path.join(tempDir, "images");
        console.info("Got PID: " + PID);
        sessionStatusBarItem.text = "R: " + PID;
        sessionStatusBarItem.show();
        updateSessionWatcher();
        _updateGlobalenv();
        _updatePlot();
    } else if (parseResult.command === "browser") {
        showBrowser(parseResult.url);
    } else if (parseResult.command === "webview") {
        showWebView(parseResult.file);
    } else if (parseResult.command === "dataview") {
        showDataView(parseResult.source,
            parseResult.type, parseResult.title, parseResult.file);
    } else {
        console.error("Unsupported command: " + parseResult.command);
    }
}
