"use strict";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { isNull } from "util";
import { commands, CompletionItem, ExtensionContext, IndentAction,
         languages, Position, TextDocument, window } from "vscode";
import { previewDataframe, previewEnvironment } from "./preview";
import { createGitignore } from "./rGitignore";
import { chooseTerminal, chooseTerminalAndSendText, createRTerm, deleteTerminal,
         runSelectionInTerm } from "./rTerminal";
import { config, ToRStringLiteral } from "./util";

const wordPattern = /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\<\>\/\s]+)/g;

// Get with names(roxygen2:::default_tags())
const roxygenTagCompletionItems = [
    "export", "exportClass", "exportMethod", "exportPattern", "import", "importClassesFrom",
    "importFrom", "importMethodsFrom", "rawNamespace", "S3method", "useDynLib", "aliases",
    "author", "backref", "concept", "describeIn", "description", "details",
    "docType", "encoding", "evalRd", "example", "examples", "family",
    "field", "format", "inherit", "inheritParams", "inheritDotParams", "inheritSection",
    "keywords", "method", "name", "md", "noMd", "noRd",
    "note", "param", "rdname", "rawRd", "references", "return",
    "section", "seealso", "slot", "source", "template", "templateVar",
    "title", "usage"].map((x) => new CompletionItem(x + " "));

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
        chooseTerminalAndSendText(`source(${rPath})`);
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
        if (isNull(outputFormat)) {
            chooseTerminalAndSendText(`rmarkdown::render(${rPath})`);
        } else {
            chooseTerminalAndSendText(`rmarkdown::render(${rPath}, "${outputFormat}")`);
        }
    }

    async function runSelection(rFunctionName: string[]) {
        const callableTerminal = await chooseTerminal();
        if (isNull(callableTerminal)) {
            return;
        }
        runSelectionInTerm(callableTerminal, rFunctionName);
    }

    async function runSelectionInActiveTerm(rFunctionName: string[]) {
        const callableTerminal = await chooseTerminal(true);
        if (isNull(callableTerminal)) {
            return;
        }
        runSelectionInTerm(callableTerminal, rFunctionName);
    }

    languages.registerCompletionItemProvider("r", {
        provideCompletionItems(document: TextDocument, position: Position) {
            if (document.lineAt(position).text.substr(0, 2) === "#'") {
                return roxygenTagCompletionItems;
            } else {
                return undefined;
            }
        },
    }, "@"); // Trigger on '@'

    languages.setLanguageConfiguration("r", {
        onEnterRules: [{ // Automatically continue roxygen comments: #'
        action: { indentAction: IndentAction.None, appendText: "#' " },
            beforeText: /^#'.*/,
        }],
        wordPattern,
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
        commands.registerCommand("r.loadAll", () => chooseTerminalAndSendText("devtools::load_all()")),
        commands.registerCommand("r.test", () => chooseTerminalAndSendText("devtools::test()")),
        commands.registerCommand("r.install", () => chooseTerminalAndSendText("devtools::install()")),
        commands.registerCommand("r.build", () => chooseTerminalAndSendText("devtools::build()")),
        commands.registerCommand("r.document", () => chooseTerminalAndSendText("devtools::document()")),
        window.onDidCloseTerminal(deleteTerminal),
    );
}

// This method is called when your extension is deactivated
// export function deactivate() {

// }
