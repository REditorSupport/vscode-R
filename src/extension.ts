'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext} from 'vscode';
import cp = require('child_process');

let outputChennel = window.createOutputChannel("r");
let config = workspace.getConfiguration('r');

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
        // let termName = workspace.getConfiguration('r').get<string>('rterm.windows');
        // let term = window.createTerminal(termName);
        // term.show();
        window.showErrorMessage("R: Sorry, this function is not implemented yet");
    }

    function runR()  {
        let path = window.activeTextEditor.document.fileName;
        let cmd;
        
        if (process.platform == 'win32') {
            cmd = config.get('rterm.windows');
        } else if (process.platform == 'darwin') {
            cmd = config.get('rterm.mac');
        } else if (process.platform == 'linux') {
            cmd = config.get('rterm.linux');
        } else {
            window.showErrorMessage(process.platform + "can't use R");
            return;
        }

        let args = ["--no-restore",
		"--no-save",
		"--quiet",
        "--file=" + path];
        cp.execFile(cmd, args, {}, (err, stdout, stderr) => {
            try {
                if (err) {
                    console.log(err);
                }
                outputChennel.show(true);
                outputChennel.append(stdout);
            } catch (e) {
                window.showErrorMessage(e.message);
            }
        });
    }

    context.subscriptions.push(
        commands.registerCommand('r.createRterm', createRterm),
        commands.registerCommand('r.runR', runR)
    );
}

// this method is called when your extension is deactivated
export function deactivate() {
}