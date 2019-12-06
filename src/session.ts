"use strict";

import os = require("os");
import fs = require("fs-extra");
import path = require("path");
import { commands, RelativePattern, window, workspace, ViewColumn, Uri, FileSystemWatcher } from "vscode";
import { chooseTerminalAndSendText } from "./rTerminal";
import { sessionStatusBarItem } from "./extension";
import { config } from "./util";

export let globalenv: any;
let responseWatcher: FileSystemWatcher;
let globalEnvWatcher: FileSystemWatcher;
let plotWatcher: FileSystemWatcher;
let PID: string;
let resDir: string;

export function deploySessionWatcher(extensionPath: string) {
    resDir = path.join(extensionPath, "resources");
    const srcPath = path.join(extensionPath, "R", "init.R");
    const targetDir = path.join(os.homedir(), ".vscode-R");
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }
    const targetPath = path.join(targetDir, "init.R");
    fs.copySync(srcPath, targetPath);
}

export function startResponseWatcher() {
    responseWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.rootPath,
            ".vscode/vscode-R/response.log"));
    responseWatcher.onDidCreate(updateResponse);
    responseWatcher.onDidChange(updateResponse);
}

export function attachActive() {
    if (config.get("sessionWatcher")) {
        chooseTerminalAndSendText("getOption('vscodeR')$attach()");
    } else {
        window.showInformationMessage("This command requires that r.sessionWatcher be enabled.");
    }
}

export function removeSessionFiles() {
    console.info("removeSessionFiles");
    const sessionPath = path.join(workspace.rootPath, ".vscode", "vscode-R", PID);
    if (fs.existsSync(sessionPath)) {
        fs.rmdirSync(sessionPath);
    }
}

function updateSessionWatcher() {
    const uri = window.activeTextEditor!.document.uri;
    console.info("Updating session to PID " + PID);

    console.info("Create globalEnvWatcher");
    globalEnvWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.getWorkspaceFolder(uri)!,
            ".vscode/vscode-R/" + PID + "/globalenv.json"));
    globalEnvWatcher.onDidChange(updateGlobalenv);

    console.info("Create plotWatcher");
    plotWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.getWorkspaceFolder(uri)!,
            ".vscode/vscode-R/" + PID + "/plot.png"));
    plotWatcher.onDidCreate(updatePlot);
    plotWatcher.onDidChange(updatePlot);
}

function _updatePlot() {
    const plotPath = path.join(workspace.rootPath, ".vscode", "vscode-R", PID, "plot.png");
    if (fs.existsSync(plotPath)) {
        commands.executeCommand("vscode.open", Uri.file(plotPath), {
            preserveFocus: true, preview: true, viewColumn: ViewColumn.Two
        });
        console.info("Updated plot");
    }
}

function updatePlot(event) {
    _updatePlot();
}

async function _updateGlobalenv() {
    const globalenvPath = path.join(workspace.rootPath, ".vscode", "vscode-R", PID, "globalenv.json");
    const content = await fs.readFile(globalenvPath, "utf8");
    globalenv = JSON.parse(content);;
    console.info("Updated globalenv");
}

async function updateGlobalenv(event) {
    _updateGlobalenv();
}

async function showWebView(file) {
    const dir = path.dirname(file);
    console.info("webview uri: " + file);
    const panel = window.createWebviewPanel("webview", "WebView",
        { preserveFocus: true, viewColumn: ViewColumn.Two },
        {
            enableScripts: true, localResourceRoots: [Uri.file(dir)]
        });
    const content = await fs.readFile(file);
    const html = content.toString()
        .replace(/<script src="/g, '<script src="vscode-resource://' + dir + "/")
        .replace(/<link href="/g, '<link href="vscode-resource://' + dir + "/");
    panel.webview.html = html;
}

async function showDataView(source: string, type: string, title: string, file: string) {
    const dir = path.dirname(file);
    if (source == "data.frame") {
        if (type == "html") {
            const panel = window.createWebviewPanel("dataview", title,
                { preserveFocus: true, viewColumn: ViewColumn.Two },
                {
                    enableScripts: true, localResourceRoots: [Uri.file(dir)]
                });
            const content = await getDataFrameHtml(file);
            panel.webview.html = content;
        } else {
            console.error("Unsupported type: " + type);
        }
    } else if (source == "list") {
        if (type == "json") {
            const panel = window.createWebviewPanel("dataview", title,
                { preserveFocus: true, viewColumn: ViewColumn.Two },
                {
                    enableScripts: true
                });
            const content = await getListHtml(file);
            panel.webview.html = content;
        } else {
            console.error("Unsupported type: " + type);
        }
    } else {
        console.error("Unsupported data source: " + source);
    }
}

function getDataFrameHtml(file) {
    return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.1.3/css/bootstrap.css" rel="stylesheet">
  <link href="https://cdn.datatables.net/1.10.20/css/dataTables.bootstrap4.min.css" rel="stylesheet">
</head>

<body>
  <div class="container-fluid">
    <div id='table-container'></div>
  </div>
  <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js"></script>
  <script type="text/javascript" src="https://cdn.datatables.net/1.10.20/js/jquery.dataTables.min.js"></script>
  <script type="text/javascript" src="https://cdn.datatables.net/1.10.20/js/dataTables.bootstrap4.min.js"></script>
  <script type="text/javascript">
    var path = 'vscode-resource://${file}';
    $(document).ready(function () {
      $("#table-container").load(path, function (data) {
        $table = $("table");
        $table.attr("class", "table table-striped table-condensed");
        $table.DataTable({ "paging": false });
      });
    })    
  </script>
</body>

</html>
`;
}

async function getListHtml(file) {
    var content = await fs.readFile(file);
    return `<!doctype HTML>
<html>

<head>
  <meta charset="utf-8" />
  <script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.4.1/jquery.min.js"></script>
  <script src="vscode-resource://${resDir}/js/jquery.json-viewer.js"></script>
  <link href="vscode-resource://${resDir}/css/jquery.json-viewer.css" type="text/css" rel="stylesheet">

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

async function updateResponse(event) {
    console.info("Response file updated!");
    // Read last line from response file
    const responseLogFile = workspace.rootPath + "/.vscode/vscode-R/response.log";
    const content = await fs.readFile(responseLogFile, "utf8");
    const lines = content.split("\n");
    console.info("Read response file");
    const lastLine = lines[lines.length - 2];
    console.info("Last line: " + lastLine);
    const parseResult = JSON.parse(lastLine);
    if (parseResult.command === "attach") {
        PID = String(parseResult.pid);
        console.info("Got PID: " + PID);
        sessionStatusBarItem.text = "R: " + PID;
        sessionStatusBarItem.show();
        updateSessionWatcher();
        _updateGlobalenv();
        _updatePlot();
    } else if (parseResult.command === "webview") {
        showWebView(parseResult.file);
    } else if (parseResult.command === "dataview") {
        showDataView(parseResult.source, parseResult.type, parseResult.title, parseResult.file);
    } else {
        console.info("Command was not attach");
    }
}
