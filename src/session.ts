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

export function deploySessionWatcher(extensionPath: string) {
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
    } else {
        console.info("Command was not attach");
    }
}
