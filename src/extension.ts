"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, ExtensionContext, languages, Range, window, workspace} from "vscode";
import { createGitignore } from "./rGitignore";
import { installLintr, lintr } from "./rLint";
import { createRTerm, deleteTerminal, rTerm } from "./rTerminal";
import { checkForSpecialCharacters, checkIfFileExists, config, delay } from "./util";

import fs = require("fs-extra");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json

    function runSource(echo: boolean)  {
        const wad = window.activeTextEditor.document;
        wad.save();
        let rPath = ToRStringLiteral(wad.fileName, '"');
        let encodingParam = config.get("source.encoding") as string;
        if (encodingParam) {
            encodingParam = `encoding = "${encodingParam}"`;
            rPath = [rPath, encodingParam].join(", ");
        }
        if (echo) {
            rPath = [rPath, "echo = TRUE"].join(", ");
        }
        if (!rTerm) {
            createRTerm(true);
        }
        rTerm.sendText(`source(${rPath})`);
        setFocus();
    }

    function getSelection(): string[] {
        const { start, end } = window.activeTextEditor.selection;
        const currentDocument = window.activeTextEditor.document;
        const range = new Range(start, end);
        const selectedLineText = !range.isEmpty
                                 ? currentDocument.getText(new Range(start, end))
                                 : currentDocument.lineAt(start.line).text;

        const selectedTextArray = selectedLineText.split("\n");

        return selectedTextArray;

    }

    async function runSelection() {
        const selectedLineText = getSelection();

        if (!rTerm) {
            createRTerm(true);
            await delay (200); // Let RTerm warm up
        }

        for (const line of selectedLineText) {
            commands.executeCommand("cursorMove", { to: "down" });
            if (checkForComment(line)) { continue; }
            await delay(5); // Increase delay if RTerm can't handle speed.
            rTerm.sendText(line);
        }
        setFocus();
    }

    function setFocus() {
        const focus = config.get("source.focus") as string;
        if (focus === "terminal") {
            rTerm.show();
        }
    }

    function checkForComment(line): boolean {
        let index = 0;
        while (index < line.length) {
            if (!(line[index] === " ")) { break; }
            index++;
        }
        return line[index] === "#";
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

    async function previewEnvironment() {
        if (!rTerm) {
            createRTerm(true);
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

    async function previewDataframe() {
        if (!rTerm) {
            createRTerm(true);
        }

        const dataframeName = getSelection();

        if (!checkForSpecialCharacters(dataframeName)) {
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

    context.subscriptions.push(
        commands.registerCommand("r.runSource", () => runSource(false)),
        commands.registerCommand("r.createRTerm", createRTerm),
        commands.registerCommand("r.runSourcewithEcho", () => runSource(true)),
        commands.registerCommand("r.runSelection", runSelection),
        commands.registerCommand("r.createGitignore", createGitignore),
        commands.registerCommand("r.lintr", lintr),
        commands.registerCommand("r.previewDataframe", previewDataframe),
        commands.registerCommand("r.previewEnvironment", previewEnvironment),
        commands.registerCommand("r.installLintr", installLintr),
        workspace.onDidSaveTextDocument(lintr),
        window.onDidCloseTerminal(deleteTerminal),
    );

    function ToRStringLiteral(s: string, quote: string) {
        if (s === null) {
            return "NULL";
        }
        return (quote +
                s.replace(/\\/g, "\\\\")
                .replace(/"""/g, "\\" + quote)
                .replace(/\\n/g, "\\n")
                .replace(/\\r/g, "\\r")
                .replace(/\\t/g, "\\t")
                .replace(/\\b/g, "\\b")
                .replace(/\\a/g, "\\a")
                .replace(/\\f/g, "\\f")
                .replace(/\\v/g, "\\v") +
                quote);
    }
}

// This method is called when your extension is deactivated
// export function deactivate() {

// }
