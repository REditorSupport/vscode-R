"use strict";

import fs = require("fs-extra");
import { commands, extensions, window, workspace } from "vscode";
import { createRTerm, rTerm } from "./rTerminal";
import { getSelection } from "./selection";
import { checkForSpecialCharacters, checkIfFileExists, delay } from "./util";

export async function previewEnvironment() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }
    if (!checkcsv()) {
        return;
    }
    const tmpDir = makeTmpDir();
    const pathToTmpCsv = tmpDir + "/environment.csv";
    const envName = "name=ls()";
    const envClass = "class=sapply(ls(), function(x) {class(get(x))})";
    const envOut = "out=sapply(ls(), function(x) {capture.output(str(get(x)), silent = T)[1]})";
    const rWriteCsvCommand = "write.csv(data.frame("
                             + envName + ","
                             + envClass + ","
                             + envOut + "), '"
                             + pathToTmpCsv + "', row.names=FALSE, quote = TRUE)";
    rTerm.sendText(rWriteCsvCommand);
    await openTmpCSV(pathToTmpCsv, tmpDir);
}

export async function previewDataframe() {
    if (!rTerm) {
        const success = createRTerm(true);
        if (!success) { return; }
    }
    if (!checkcsv()) {
        return;
    }

    const selectedTextArray = getSelection().selectedTextArray;
    const dataframeName = selectedTextArray[0];

    if (selectedTextArray.length !== 1 || !checkForSpecialCharacters(dataframeName)) {
        window.showInformationMessage("This does not appear to be a dataframe.");
        return false;
    }

    const tmpDir = makeTmpDir();

    // Create R write CSV command.  Turn off row names and quotes, they mess with Excel Viewer.
    const pathToTmpCsv = tmpDir + "/" + dataframeName + ".csv";
    const rWriteCsvCommand = "write.csv(" + dataframeName + ", '"
                            + pathToTmpCsv
                            + "', row.names = FALSE, quote = FALSE)";
    rTerm.sendText(rWriteCsvCommand);
    await openTmpCSV(pathToTmpCsv, tmpDir);
}

async function openTmpCSV(pathToTmpCsv: string, tmpDir: string) {
    await delay(350); // Needed since file size has not yet changed

    if (!checkIfFileExists(pathToTmpCsv)) {
        window.showErrorMessage("Dataframe failed to display.");
        fs.removeSync(tmpDir);
        return false;
    }

    // Async poll for R to complete writing CSV.
    const success = await waitForFileToFinish(pathToTmpCsv);
    if (!success) {
        window.showWarningMessage("Visual Studio Code currently limits opening files to 20 MB.");
        fs.removeSync(tmpDir);
        return false;
    }

    if (process.platform === "win32") {
        const winattr = require("winattr");
        winattr.setSync(tmpDir, {hidden: true});
    }

    // Open CSV in Excel Viewer and clean up.
    workspace.openTextDocument(pathToTmpCsv).then(async (file) => {
        await commands.executeCommand("csv.preview", file.uri);
        fs.removeSync(tmpDir);
            });
}

async function waitForFileToFinish(filePath) {
    const fileBusy = true;
    let currentSize = 0;
    let previousSize = 1;

    while (fileBusy) {
        const stats = fs.statSync(filePath);
        currentSize = stats.size;

        // UPDATE: We are now limited to 20 mb by MODEL_TOKENIZATION_LIMIT
        // https://github.com/Microsoft/vscode/blob/master/src/vs/editor/common/model/textModel.ts#L34
        if (currentSize > 2 * 10000000) { // 20 MB
            return false;
        }

        if (currentSize === previousSize) {
            return true;
        } else {
            previousSize = currentSize;
        }
        await delay(50);
    }
}

function makeTmpDir() {
    let tmpDir = workspace.rootPath;
    if (process.platform === "win32") {
        tmpDir = tmpDir.replace(/\\/g, "/");
        tmpDir += "/tmp";
    } else {
        tmpDir += "/.tmp";
    }
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir);
    }
    return tmpDir;
}

function checkcsv() {
    const iscsv = extensions.getExtension("GrapeCity.gc-excelviewer");
    if (iscsv && iscsv.isActive) {
        return true;
    } else {
        window.showInformationMessage("This function need to install `GrapeCity.gc-excelviewer`");
        return false;
    }
}
