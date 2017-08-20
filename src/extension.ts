"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { commands, ExtensionContext, languages, Range, window, workspace} from "vscode";
import { createGitignore } from "./rGitignore";
import { RHoverProvider } from "./rHoverProvider";
import { installLintr, lintr } from "./rLint";
import { R_MODE } from "./rMode";
import { createRTerm, deleteTerminal, rTerm } from "./rTerminal";
import { config } from "./util";

import fs = require('fs-extra');
import fswin = require('fswin');


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json

    function runSource(echo: boolean)  {
        let wad = window.activeTextEditor.document;
        wad.save();
        let rPath = ToRStringLiteral(wad.fileName, '"');
        let encodingParam = <string> config.get("source.encoding");
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

    function getSelection(): string {
        let { start, end } = window.activeTextEditor.selection;
        let currentDocument = window.activeTextEditor.document;
        let range = new Range(start, end);
        let selectedLineText = !range.isEmpty
                                 ? currentDocument.getText(new Range(start, end))
                                 : currentDocument.lineAt(start.line).text;
        return selectedLineText;
    }

    function runSelection() {
        let selectedLineText = getSelection();
        if (!rTerm) {
            createRTerm(true);
        }

        commands.executeCommand("cursorMove", {to: "down"});

        // Skip comments
        if (checkForComment(selectedLineText)) { return; }

        rTerm.sendText(selectedLineText);
        setFocus();
    }

    function setFocus() {
        let focus = <string> config.get("source.focus");
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

    async function previewDataframe(){
        
        if (!rTerm) {
            createRTerm(true);
        }

        // TODO: Check for special characters and warn, 'Doesn't look like a dataframe'
        let dataframeName = getSelection();

        // Make the tmp directory hidden.  Different depending on platform.
        var tmpDir = "";
        if (process.platform === "win32") {
            tmpDir = workspace.rootPath + "/tmp"
            if (!fs.existsSync(tmpDir)){
                fs.mkdirSync(tmpDir);
                // TODO: Need to test win32.
                //fswin.setAttributesSync(tmpDir, { IS_HIDDEN: true });
            }
        } else {
            tmpDir = workspace.rootPath + "/.tmp"
            if (!fs.existsSync(tmpDir)){
                fs.mkdirSync(tmpDir);
            }
        }

        // Create R write CSV command.  Turn off row names and quotes, they mess with Excel Viewer.
        let writeFolder = tmpDir + "/" + dataframeName + ".csv";
        let writeString = "write.csv(" + dataframeName + ", '" + writeFolder + "', row.names = FALSE, quote = FALSE)";
        rTerm.sendText(writeString);

        // Async poll for R to complete writing CSV.
        await waitForFileToFinish(writeFolder);

        // Open CSV in Excel Viewer.  Then delete the tmp directory and file.
        workspace.openTextDocument(writeFolder).then(async function(file){
            commands.executeCommand("csv.preview", file.uri);

            // TODO: Open Excel Viewer in side pane, or "Preview Position"

            fs.removeSync(tmpDir);
        });
    }
    
    async function waitForFileToFinish(filePath){
        let fileBusy = true;
        let currentSize = 0;
        let previousSize = 1;
        await delay(100);
        while(fileBusy){
            let stats = fs.statSync(filePath);
            currentSize = stats.size;
            if(currentSize === previousSize){
                return true;
            } else {
                previousSize = currentSize;
            }
            await delay(50);
        }   
    }

    function delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    context.subscriptions.push(
        commands.registerCommand("r.runSource", () => runSource(false)),
        commands.registerCommand("r.createRTerm", createRTerm),
        commands.registerCommand("r.runSourcewithEcho", () => runSource(true)),
        commands.registerCommand("r.runSelection", runSelection),
        commands.registerCommand("r.createGitignore", createGitignore),
        commands.registerCommand("r.lintr", lintr),
        commands.registerCommand("r.installLintr", installLintr),
        commands.registerCommand('r.previewDataframe', previewDataframe),
        languages.registerHoverProvider(R_MODE, new RHoverProvider()),
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
