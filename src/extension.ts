"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { isNull } from "util";
import { commands, ExtensionContext, languages, Terminal, window, IndentAction } from "vscode";
import { buildPkg, documentPkg, installPkg, loadAllPkg, testPkg } from "./package";
import { previewDataframe, previewEnvironment } from "./preview";
import { createGitignore } from "./rGitignore";
import { createRTerm, deleteTerminal, rTerm } from "./rTerminal";
import { checkForBlankOrComment, getSelection } from "./selection";
import { config, delay } from "./util";

const wordPattern = /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\<\>\/\s]+)/g;

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
            const success = createRTerm(true);
            if (!success) { return; }
        }
        rTerm.sendText(`source(${rPath})`);
        setFocus(rTerm);
    }

    function knitRmd(echo: boolean, outputFormat: string)  {
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
            const success = createRTerm(true);
            if (!success) { return; }
        }
        if (isNull(outputFormat)) {
            rTerm.sendText(`rmarkdown::render(${rPath})`);
        } else {
            rTerm.sendText(`rmarkdown::render(${rPath}, "${outputFormat}")`);
        }
    }

    async function runSelection(rFunctionName: string[]) {
        const callableTerminal = await chooseTerminal();
        if (isNull(callableTerminal)) {
            return;
        }
        setFocus(callableTerminal);
        runSelectionInTerm(callableTerminal, rFunctionName);
    }

    async function chooseTerminal() {
        if (window.terminals.length > 0) {
            const RTermNameOpinions = ["R", "R Interactive"];
            if (window.activeTerminal) {
                const activeTerminalName = window.activeTerminal.name;
                if (RTermNameOpinions.includes(activeTerminalName)) {
                    return window.activeTerminal;
                }
            } else {
                // Creating a terminal when there aren't any already
                // does not seem to set activeTerminal
                if (window.terminals.length === 1) {
                    const activeTerminalName = window.terminals[0].name;
                    if (RTermNameOpinions.includes(activeTerminalName)) {
                        return window.terminals[0];
                    }
                } else {
                    // tslint:disable-next-line: max-line-length
                    window.showInformationMessage("Error identifying terminal! This shouldn't happen, so please file an issue at https://github.com/Ikuyadeu/vscode-R/issues");
                    return null;
                }
            }
        }

        if (!rTerm) {
            const success = createRTerm(true);
            await delay(200); // Let RTerm warm up
            if (!success) {
                return null;
            }
        }
        return rTerm;
    }

    function runSelectionInActiveTerm(rFunctionName: string[]) {
        if (window.terminals.length < 1) {
            window.showInformationMessage("There are no open terminals.");
        } else {
            runSelectionInTerm(window.activeTerminal, rFunctionName);
            setFocus(window.activeTerminal);
        }
    }

    async function runSelectionInTerm(term: Terminal, rFunctionName: string[]) {
        const selection = getSelection();
        if (selection.linesDownToMoveCursor > 0) {
            commands.executeCommand("cursorMove", { to: "down", value: selection.linesDownToMoveCursor });
            commands.executeCommand("cursorMove", { to: "wrappedLineEnd" });
        }

        if (selection.selectedTextArray.length > 1 && config.get("bracketedPaste")) {
            // Surround with ANSI control characters for bracketed paste mode
            selection.selectedTextArray[0] = "\x1b[200~" + selection.selectedTextArray[0];
            selection.selectedTextArray[selection.selectedTextArray.length - 1] += "\x1b[201~";
        }

        for (let line of selection.selectedTextArray) {
            await delay(8); // Increase delay if RTerm can't handle speed.

            if (rFunctionName && rFunctionName.length) {
                let rFunctionCall = "";
                for (const feature of rFunctionName) {
                    rFunctionCall += feature + "(";
                }
                line = rFunctionCall + line.trim() + ")".repeat(rFunctionName.length);
            }
            term.sendText(line);
        }
    }

    function setFocus(term: Terminal) {
        const focus = config.get("source.focus") as string;
        term.show(focus !== "terminal");
    }

    languages.setLanguageConfiguration("r", {
        wordPattern,
        onEnterRules: [{ // Automatically continue roxygen comments: #'
                beforeText: /^#'.*/,
                action: { indentAction: IndentAction.None, appendText: '#\' ' }
        }]
    });

    context.subscriptions.push(
        commands.registerCommand("r.nrow", () => runSelection(["nrow"])),
        commands.registerCommand("r.length", () => runSelection(["length"])),
        commands.registerCommand("r.head", () => runSelection(["head"])),
        commands.registerCommand("r.thead", () => runSelection(["t", "head"])),
        commands.registerCommand("r.names", () => runSelection(["names"])),
        commands.registerCommand("r.runSource", () => runSource(false)),
        commands.registerCommand("r.knitRmd", () => knitRmd(false, null)),
        commands.registerCommand("r.knitRmdToPdf", () => knitRmd(false, "pdf_document")),
        commands.registerCommand("r.knitRmdToHtml", () => knitRmd(false, "html_document")),
        commands.registerCommand("r.knitRmdToAll", () => knitRmd(false, "all")),
        commands.registerCommand("r.createRTerm", createRTerm),
        commands.registerCommand("r.runSourcewithEcho", () => runSource(true)),
        commands.registerCommand("r.runSelection", () => runSelection([])),
        commands.registerCommand("r.runSelectionInActiveTerm", () => runSelectionInActiveTerm([])),
        commands.registerCommand("r.createGitignore", createGitignore),
        commands.registerCommand("r.previewDataframe", previewDataframe),
        commands.registerCommand("r.previewEnvironment", previewEnvironment),
        commands.registerCommand("r.loadAll", loadAllPkg),
        commands.registerCommand("r.test", testPkg),
        commands.registerCommand("r.install", installPkg),
        commands.registerCommand("r.build", buildPkg),
        commands.registerCommand("r.document", documentPkg),
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
