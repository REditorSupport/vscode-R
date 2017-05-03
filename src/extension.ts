'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext} from 'vscode';
import cp = require('child_process');
import fs = require('fs');
import path = require('path');

let outputChennel = window.createOutputChannel("r");
let config = workspace.getConfiguration('r');
let Rterm;
let ignorePath =  path.join(workspace.rootPath, '.gitignore');
// from 'https://github.com/github/gitignore/raw/master/R.gitignore'
let ignoreFiles = [".Rhistory", 
                   ".Rapp.history",
                   ".RData",
                   "*-Ex.R",
                   "/*.tar.gz",
                   "/*.Rcheck/",
                   ".Rproj.user/",
                   "vignettes/*.html",
                   "vignettes/*.pdf",
                   ".httr-oauth",
                   "/*_cache/",
                   "/cache/",
                   "*.utf8.md",
                   "*.knit.md"].join('\n');

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
        let termPath = ""
        if (process.platform == 'win32') {
            termPath += config.get('rterm.windows');
        } else if (process.platform == 'darwin') {
            termPath += config.get('rterm.mac');
        } else if ( process.platform == 'linux'){
            termPath += config.get('rterm.linux');
        }else{
            window.showErrorMessage(process.platform + "can't use R");
            return;
        }
        Rterm = window.createTerminal(termName, termPath);
        Rterm.show();
        return;
    }

    function runR()  {
        const path = ToRStringLiteral(window.activeTextEditor.document.fileName);
        
        if (!Rterm){
            commands.executeCommand('r.createRterm');  
        }
        Rterm.show();
        Rterm.sendText("source(" + path + ")");
    }

    function createGitignore() {
        if (!workspace.rootPath) {
            window.showWarningMessage('Please open workspace to create .gitignore');
            return;
        }
        fs.writeFile(ignorePath, ignoreFiles, (err) => {
            try {
                if (err) {
                    console.log(err);
                }
            } catch (e) {
                window.showErrorMessage(e.message);
            }
        });
    }

    context.subscriptions.push(
        commands.registerCommand('r.createRterm', createRterm),
        commands.registerCommand('r.runR', runR),
        commands.registerCommand('r.createGitignore', createGitignore)
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