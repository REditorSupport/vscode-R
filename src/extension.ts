'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext, languages, 
    Diagnostic, DiagnosticSeverity, Range, Position, Terminal, Uri } from 'vscode';
import cp = require('child_process');
import fs = require('fs');
import path = require('path');

let outputChennel = window.createOutputChannel("r");
let config = workspace.getConfiguration('r');
let Rterm: Terminal;
let ignorePath =  path.join(workspace.rootPath, '.gitignore');
let Diagnostics = languages.createDiagnosticCollection('R');
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
    function getRpath() {
        let term = ""
        if (process.platform === 'win32') {
            return term + config.get('rterm.windows');
        } else if (process.platform === 'darwin') {
            return term + config.get('rterm.mac');
        } else if ( process.platform === 'linux'){
            return term + config.get('rterm.linux');
        }else{
            window.showErrorMessage(process.platform + "can't use R");
            return term;
        }
    }

    function createRterm() {
        const termName = "R";
        let termPath = getRpath()
        if (!termPath) {
            return
        }
        Rterm = window.createTerminal(termName, termPath);
        Rterm.show();
    }

    function runSource()  {
        const Rpath = ToRStringLiteral(window.activeTextEditor.document.fileName, '"');
        var encodingParam = config.get('source.encoding');
        if (encodingParam) {
            encodingParam = `encoding="${encodingParam}"`
        }
        if (!Rterm){
            commands.executeCommand('r.createRterm');  
        }
        Rterm.show();
        Rterm.sendText(`source(${Rpath}, ${encodingParam})`);
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

    function runSelected() {
        const { start, end } = window.activeTextEditor.selection;
        const currentDocument = window.activeTextEditor.document;
        const selectedLineText = currentDocument.getText(new Range(start, end));
        if (!Rterm){
            commands.executeCommand('r.createRterm');  
        }
        Rterm.show();
        Rterm.sendText(selectedLineText);
    }


    function parseSeverity(severity) {
        switch (severity) {
            case "error":
                return DiagnosticSeverity.Warning;
            case "warning":
                return DiagnosticSeverity.Warning;
            case "style":
                return DiagnosticSeverity.Warning;
        }
    }

    const lintRegex = /.+?:(\d+):(\d+): ((?:error)|(?:warning|style)): (.+)/g

    function lintr() {
        let RPath
        if (config.get('lintr.executable') !== ""){
            RPath = config.get('lintr.executable')
        }else {
            RPath = getRpath();
        }
        if (!RPath) {
            return
        }

        let Rcommand;
        const cache = config.get('lintr.cache')? "TRUE" : "FALSE";
        const linters = config.get('lintr.linters');
        let Fpath = ToRStringLiteral(window.activeTextEditor.document.fileName, "'")
        if (process.platform === 'win32') {
            RPath =  ToRStringLiteral(RPath, '');
            Rcommand = `\"suppressPackageStartupMessages(library(lintr));lint(${Fpath})\"`
        }else{
            RPath = "R";
            Fpath = `${Fpath}, cache = ${cache}, linters = ${linters}`
            Rcommand = `suppressPackageStartupMessages(library(lintr));lint(${Fpath})`
        }
        const parameters = [
            '--vanilla', '--slave',
            '--no-save',
            '-e',
            Rcommand,
            '--args'
        ];

        console.log(RPath);
        console.log(RPath + " " + parameters.join(" "))
        cp.execFile(RPath, parameters, (error, stdout, stderr) => {
            if (stderr){
                console.log("stderr:" + stderr.toString());
            }
            if (error){
                console.log(error.toString());
            }
            let match = lintRegex.exec(stdout);
            let results = []
            const diagsCollection: {[key: string]: Diagnostic[]} = {}
            
            let filename = window.activeTextEditor.document.fileName;

            while (match !== null) {
                const range = new Range(new Position(Number(match[1]) - 1, 
                                                     match[2] === undefined ? 0 : Number(match[2]) - 1),
                                        new Position(Number(match[1]) - 1, 
                                                     match[2] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[2]) - 1));
                
                const message = match[4];
                const severity = parseSeverity(match[3]);
                const diag = new Diagnostic(range, message, severity);
                if (diagsCollection[filename] === undefined) {
                    diagsCollection[filename] = []
                }
                diagsCollection[filename].push(diag)
                console.log(message);
                match = lintRegex.exec(stdout);
            }
            Diagnostics.clear();
            Diagnostics.set(Uri.file(filename),
                            diagsCollection[filename]);
            return results;
        });
    }

    function installLintr() {
        if (!Rterm){
            commands.executeCommand('r.createRterm');  
        }
        Rterm.show();
        Rterm.sendText("install.packages(\"lintr\")");
    }


    context.subscriptions.push(
        commands.registerCommand('r.createRterm', createRterm),
        commands.registerCommand('r.runSource', runSource),
        commands.registerCommand('r.runSelected', runSelected),
        commands.registerCommand('r.createGitignore', createGitignore),
        commands.registerCommand('r.lintr', lintr),
        commands.registerCommand('r.installLintr', installLintr)
    );

    function ToRStringLiteral(s, q) {
        let quote = q;
        if (s === null){
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