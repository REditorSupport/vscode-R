'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext, Range } from 'vscode';
import { config } from './util';
import { rTerm, createRTerm, deleteTerminal } from './rTerminal';
import { lintr, installLintr } from './rLint';
import { createGitignore } from './rGitignore';
// import { R_MODE } from './rMode';
// import { RHoverProvider } from "./rHoverProvider";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "r" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json

    function runSource(echo: boolean)  {
        let wad = window.activeTextEditor.document;
        wad.save();
        let rPath = ToRStringLiteral(wad.fileName, '"');
        let encodingParam = <string>config.get('source.encoding');
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

    function runSelection() {
        let { start, end } = window.activeTextEditor.selection;
        let currentDocument = window.activeTextEditor.document;
        let range = new Range(start, end);
        let selectedLineText = !range.isEmpty
                                 ? currentDocument.getText(new Range(start, end))
                                 : currentDocument.lineAt(start.line).text;
        if (!rTerm) {
            createRTerm(true);
        }
      
        commands.executeCommand('cursorMove', {'to': 'down'});
      
        // Skip comments
        if (checkForComment(selectedLineText)) { return; }
      
        rTerm.sendText(selectedLineText);
        setFocus();
    }

    function setFocus() {
        let focus = <string>config.get('source.focus');
        if (focus === "terminal") {
            rTerm.show();
        }
    }

    function checkForComment(line): boolean {
        var index = 0;
        while (index < line.length) {
            if (!(line[index] === ' ')) { break; }
            index++;
        }
        return line[index] === '#';
    }

    context.subscriptions.push(
        commands.registerCommand('r.runSource', () => runSource(false)),
        commands.registerCommand('r.createRTerm', createRTerm),
        commands.registerCommand('r.runSourcewithEcho', () => runSource(true)),
        commands.registerCommand('r.runSelection', runSelection),
        commands.registerCommand('r.createGitignore', createGitignore),
        commands.registerCommand('r.lintr', lintr),
        commands.registerCommand('r.installLintr', installLintr),
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
export function deactivate() {
}
