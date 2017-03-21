'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext, StatusBarAlignment, TextEditor, Disposable } from 'vscode';
import cp = require('child_process');

let willSaveTextDocument: Disposable;
let configurationChangedListener: Disposable;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "rtvsc" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    function createRterm() {
        window.showInformationMessage('createRterm');
    }

    function runR()  {
        let path = window.activeTextEditor.document.fileName;
        let cmd = workspace.getConfiguration('rtvsc').get('rtvsc.rterm.windows', "C:\\Program Files\\Microsoft\\MRO\\R-3.2.5\\bin\\x64\\Rterm.exe");
        let args = ["--no-restore",
		"--no-save",
		"--quiet",
        "--file=" + path];
        cp.execFile(cmd, args, {}, (err, stdout, stderr) => {
            try {
                if (err) {
                    console.log(err);
                }
                let lines = stdout.toString().split('\n');
                window.showInformationMessage(stdout)
            } catch (e) {
                window.showInformationMessage(e.msg);
            }
        });

        
        // window.showInformationMessage('runR');
    }

    context.subscriptions.push(
        commands.registerCommand('rtvsc.createRterm', createRterm),
        commands.registerCommand('rtvsc.runR', runR)
    );
}

// this method is called when your extension is deactivated
export function deactivate() {
}