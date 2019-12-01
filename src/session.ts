"use strict";

import fs = require("fs-extra");
import { dirname } from "path";
import { commands, RelativePattern, window, workspace, ViewColumn, Uri, StatusBarAlignment } from "vscode";
import { chooseTerminalAndSendText } from "./rTerminal";
import { sessionStatusBarItem } from "./extension";
import { config } from "./util";

export let globalenv: any;
let sessionWatcher: any;
let PID: string;

export function startLogWatcher() {
    const fileWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.rootPath,
            ".vscode/vscode-R/response.log"));
    fileWatcher.onDidCreate(updateResponse);
    fileWatcher.onDidChange(updateResponse);
}

export function attachActive() {
    if (config.get("sessionWatcher")) {
        chooseTerminalAndSendText("getOption('vscodeR')$attach()");
    } else {
        window.showInformationMessage("This command requires that r.sessionWatcher be enabled.");
    }
}

function updateSessionWatcher() {
    const uri = window.activeTextEditor!.document.uri;
    console.info("Updating session to PID " + PID);
    sessionWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.getWorkspaceFolder(uri)!,
            ".vscode/vscode-R/" + PID + "/globalenv.json"));
    sessionWatcher.onDidChange(updateGlobalenv);
    sessionWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.getWorkspaceFolder(uri)!,
            ".vscode/vscode-R/" + PID + "/plot.png"));
    sessionWatcher.onDidCreate(updatePlot);
    sessionWatcher.onDidChange(updatePlot);
}

function _updatePlot() {
    const plotPath = workspace.rootPath + "/.vscode/vscode-R/" + PID + "/plot.png";
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

function _updateGlobalenv() {
    const globalenvPath = workspace.rootPath + "/.vscode/vscode-R/" + PID + "/globalenv.json";
    const parseResult = JSON.parse(fs.readFileSync(globalenvPath, "utf8"));
    globalenv = parseResult;
    console.info("Updated globalenv");
}

function updateGlobalenv(event) {
    _updateGlobalenv();
}

function showWebView(file) {
    const dir = dirname(file);
    console.info("webview uri: " + file);
    const panel = window.createWebviewPanel("webview", "WebView",
        { preserveFocus: true, viewColumn: ViewColumn.Two },
        { enableScripts: true, localResourceRoots: [Uri.file(dir)]
    });
    const html = fs.readFileSync(file).toString()
        .replace(/<script src="/g, '<script src="vscode-resource://' + dir + "/")
        .replace(/<link href="/g, '<link href="vscode-resource://' + dir + "/");
    panel.webview.html = html;
}

function updateResponse(event) {
    console.info("Response file updated!");
    // Read last line from response file
    const responseLogFile = workspace.rootPath + "/.vscode/vscode-R/response.log";
    console.info("File exists? " + fs.existsSync(responseLogFile));
    const lines = fs.readFileSync(responseLogFile, "utf8").split("\n");
    console.info("Read response file");
    const lastLine = lines[lines.length - 2];
    console.info("Last line: " + lastLine);
    const parseResult = JSON.parse(lastLine);
    if (parseResult.command === "attach") {
        PID = parseResult.pid;
        sessionStatusBarItem.text = "R: " + PID;
        sessionStatusBarItem.show();
        updateSessionWatcher();
        _updateGlobalenv();
        _updatePlot();
        console.info("Got PID: " + PID);
    } else if (parseResult.command === "webview") {
        showWebView(parseResult.file);
        console.info("Show webview: " + parseResult.file);
    } else {
        console.info("Command was not attach");
    }
}
