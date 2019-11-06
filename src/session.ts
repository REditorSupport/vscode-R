"use strict";

import fs = require("fs-extra");
import { window, workspace, RelativePattern } from "vscode";

export let globalenv: any;

function updateGlobalenv(event) {
    const globalenvPath = workspace.rootPath + "/.vscode-R/session/PID/globalenv.json";
    const parseResult = JSON.parse(fs.readFileSync(globalenvPath, "utf8"));
    globalenv = parseResult;
    window.showInformationMessage("parseResult.a: " + parseResult['a'].str);
    window.showInformationMessage("Updated globalenv.a: " + globalenv['a'].str);
}

export function sessionStart() {
    //TODO Make async?
    //TODO Specify location of .vscode-R
    const uri = window.activeTextEditor!.document.uri;
    const globalenvPath = workspace.rootPath + "/.vscode-R/session/PID/globalenv.json";
    window.showInformationMessage("Path: " + globalenvPath);
    globalenv = JSON.parse(fs.readFileSync(globalenvPath, "utf8"));
    window.showInformationMessage("Probably loaded globalenv" + globalenv['a'].str);
    const fileWatcher = workspace.createFileSystemWatcher(
        new RelativePattern(
            workspace.getWorkspaceFolder(uri)!,
            ".vscode-R/session/PID/globalenv.json"));
    fileWatcher.onDidChange(updateGlobalenv);
    //TODO createFileSystemWatcher can only watch workspace
}
