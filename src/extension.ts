'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext} from 'vscode';
import cp = require('child_process');

let outputChennel = window.createOutputChannel("r");
let config = workspace.getConfiguration('r');
let Rterm;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "r" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    function createRterm() {
        const termName = "R";
        if (process.platform == 'win32') {
            Rterm = window.createTerminal(termName);
            Rterm.show();
            let termPath = config.get('rterm.windows');
            Rterm.sendText("& " + "'" + termPath + "'");
        } else if (process.platform == 'darwin' || process.platform == 'linux') {
            Rterm = window.createTerminal(termName);
            Rterm.show();
            Rterm.sendText("R");
        } else{
            window.showErrorMessage(process.platform + "can't use R");
        }
        return;
    }

    function runR()  {
        const path = window.activeTextEditor.document.fileName;
        
        if (Rterm){
            Rterm.sendText("source(" + ToRStringLiteral(path) + ")");            
        }else{
            createRterm();
            window.showInformationMessage("Opening R terminal... Please wait and run this command again");
        }
    }

    context.subscriptions.push(
        commands.registerCommand('r.createRterm', createRterm),
        commands.registerCommand('r.runR', runR)
    );

    function ToRStringLiteral(s) {
        let quote = '"';
        if (s == null){
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

// this method is called when your extension is deactivated
export function deactivate() {
}