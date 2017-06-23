'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { workspace, window, commands, ExtensionContext, languages, 
    Diagnostic, DiagnosticSeverity, Range, Position, Terminal, Uri } from 'vscode';
import cp = require('child_process');
import fs = require('fs');
import path = require('path');

let config = workspace.getConfiguration('r');
let rTerm: Terminal;
let ignorePath =  path.join(workspace.rootPath, '.gitignore');
let diagnostics = languages.createDiagnosticCollection('R');
// From 'https://github.com/github/gitignore/raw/master/R.gitignore'
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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "r" is now active!');

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    function getRpath() {
        if (process.platform === 'win32') {
            return <string>config.get('rterm.windows');
        } else if (process.platform === 'darwin') {
            return <string>config.get('rterm.mac');
        } else if ( process.platform === 'linux') {
            return <string>config.get('rterm.linux');
        }else {
            window.showErrorMessage(process.platform + "can't use R");
            return "";
        }
    }

    function createRterm(preserveshow?: boolean) {
        const termName = "R";
        let termPath = getRpath();
        if (!termPath) {
            return;
        }
        const termOpt =  <Array<string>>config.get('rterm.option');
        rTerm = window.createTerminal(termName, termPath, termOpt);
        rTerm.show(preserveshow);
    }

    function runSource()  {
        let wad = window.activeTextEditor.document;
        wad.save();
        let rPath = ToRStringLiteral(wad.fileName, '"');
        let encodingParam = <string>config.get('source.encoding');
        if (encodingParam) {
            encodingParam = `encoding = "${encodingParam}"`;
            rPath = [rPath, encodingParam].join(", ");
        }
        if (!rTerm) {
            createRterm(true);
        }
        rTerm.sendText(`source(${rPath})`);
        setFocus();
    }

    function runSelection() {
        let { start, end } = window.activeTextEditor.selection;
        let currentDocument = window.activeTextEditor.document;
        let range = new Range(start, end);
        const selectedLineText = !range.isEmpty
                                 ? currentDocument.getText(new Range(start, end))
                                 : currentDocument.lineAt(start.line).text;
        if (!rTerm) {
            createRterm(true);
        }
        rTerm.sendText(selectedLineText);
        setFocus();
    }

    function setFocus() {
        let focus = <string>config.get('source.focus');
        if (focus === "terminal") {
            rTerm.show();
        }
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

    function parseSeverity(severity): DiagnosticSeverity {

        switch (severity) {
            case "error":
                return DiagnosticSeverity.Error;
            case "warning":
                return DiagnosticSeverity.Warning;
            case "style":
                return DiagnosticSeverity.Information;
        }
        return DiagnosticSeverity.Hint;
    }

    const lintRegex = /.+?:(\d+):(\d+): ((?:error)|(?:warning|style)): (.+)/g;

    function lintr() {
        let rPath: string;
        if (config.get('lintr.executable') !== "") {
            rPath = <string>config.get('lintr.executable');
        }else {
            rPath = getRpath();
        }
        if (!rPath) {
            return;
        }

        let rCommand;
        const cache = config.get('lintr.cache') ? "TRUE" : "FALSE";
        const linters = config.get('lintr.linters');
        let fPath = ToRStringLiteral(window.activeTextEditor.document.fileName, "'");
        if (process.platform === 'win32') {
            rPath =  ToRStringLiteral(rPath, '');
            rCommand = `\"suppressPackageStartupMessages(library(lintr));lint(${fPath})\"`;
        }else {
            fPath = `${fPath}, cache = ${cache}, linters = ${linters}`;
            rCommand = `suppressPackageStartupMessages(library(lintr));lint(${fPath})`;
        }
        const parameters = [
            '--vanilla', '--slave',
            '--no-save',
            '-e',
            rCommand,
            '--args'
        ];

        console.log(rPath);
        console.log(rPath + " " + parameters.join(" "));
        cp.execFile(rPath, parameters, (error, stdout, stderr) => {
            if (stderr) {
                console.log("stderr:" + stderr.toString());
            }
            if (error) {
                console.log(error.toString());
            }
            let match = lintRegex.exec(stdout);
            let results = [];
            const diagsCollection: {[key: string]: Diagnostic[]} = {};
            
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
                    diagsCollection[filename] = [];
                }
                diagsCollection[filename].push(diag);
                console.log(message);
                match = lintRegex.exec(stdout);
            }
            diagnostics.clear();
            diagnostics.set(Uri.file(filename),
                            diagsCollection[filename]);
            return results;
        });
    }

    function installLintr() {
        if (!rTerm) {
            commands.executeCommand('r.createRterm');  
        }
        rTerm.show();
        rTerm.sendText("install.packages(\"lintr\")");
    }

    function deleteTerminal(term: Terminal) {
        if (term === rTerm) {
            rTerm = null; 
        }  
    }

    context.subscriptions.push(
        commands.registerCommand('r.createRterm', createRterm),
        commands.registerCommand('r.runSource', runSource),
        commands.registerCommand('r.runSelection', runSelection),
        commands.registerCommand('r.createGitignore', createGitignore),
        commands.registerCommand('r.lintr', lintr),
        commands.registerCommand('r.installLintr', installLintr),
        window.onDidCloseTerminal(deleteTerminal)
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