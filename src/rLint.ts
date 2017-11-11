import cp = require("child_process");
import { commands, Diagnostic,
    DiagnosticSeverity, languages, Position, Range, Uri, window, workspace } from "vscode";
import { rTerm } from "./rTerminal";
import { config, getRpath, ToRStringLiteral } from "./util";
const diagnostics = languages.createDiagnosticCollection("R");
const lintRegex = /(.+?):(\d+):(\d+): ((?:error)|(?:warning|style)): (.+)/g;

export function lintr() {
    if (!(config.get("lintr.enabled") &&
        window.activeTextEditor.document.languageId === "r")) {
        return;
    }
    let rPath: string = config.get("lintr.executable") as string;
    if (!rPath)  {
        rPath = getRpath();
    }
    if (!rPath) {
        return;
    }

    let rCommand;
    const cache = config.get("lintr.cache") ? "TRUE" : "FALSE";
    const linters = config.get("lintr.linters");
    const isPackage = config.get("lintr.ispackage") as boolean;
    const fPath = ToRStringLiteral(window.activeTextEditor.document.fileName, "'");
    const lintrArgs = `cache = ${cache}, linters = ${linters}`;
    const lintrExec = getLintrCommand(isPackage, lintrArgs, fPath);

    if (process.platform === "win32") {
        rPath =  ToRStringLiteral(rPath, "");
        rCommand = `\"suppressPackageStartupMessages(library(lintr));${lintrExec}\"`;
    } else {
        rCommand = `suppressPackageStartupMessages(library(lintr));${lintrExec}`;
    }
    const parameters = [
        "--vanilla",
        "--slave",
        "--restore",
        "--no-save",
        "-e",
        rCommand,
        "--args",
        "@"];

    cp.execFile(rPath, parameters, (error, stdout, stderr) => {
        if (stderr) {
            // console.log("stderr:" + stderr.toString());
        }
        if (error) {
            window.showInformationMessage("lintr is not installed", "install lintr", "disable lintr").then(
                (item) => {
                    if (item === "install lintr") {
                        installLintr();
                        return;
                    } else if (item === "disable lintr") {
                        config.update("lintr.enabled", false);
                        diagnostics.clear();
                        return;
                    }
            });

        }
        let match = lintRegex.exec(stdout);
        const diagsCollection: {[key: string]: Diagnostic[]} = {};
        diagnostics.clear();

        while (match !== null) {
            let filename = match[1];
            if (isPackage) {
                filename = workspace.rootPath + "/" + filename;
            }
            const range = new Range(new Position(Number(match[2]) - 1,
                                                 match[3] === undefined ? 0
                                                                        : Number(match[3]) - 1),
                                    new Position(Number(match[2]) - 1,
                                                 match[3] === undefined ? Number.MAX_SAFE_INTEGER
                                                                        : Number(match[3]) - 1));

            const message = match[5];
            const severity = parseSeverity(match[4]);
            const diag = new Diagnostic(range, message, severity);
            if (diagsCollection[filename] === undefined) {
                diagsCollection[filename] = [];
            }
            diagsCollection[filename].push(diag);
            match = lintRegex.exec(stdout);
            diagnostics.set(Uri.file(filename),
            diagsCollection[filename]);
        }
        return [];
    });
}

export function installLintr() {
    if (!rTerm) {
        commands.executeCommand("r.createRTerm");
    }
    rTerm.show();
    rTerm.sendText("install.packages(\"lintr\")");
}

function parseSeverity(severity): DiagnosticSeverity {
    switch (severity) {
        case "error":
            return DiagnosticSeverity.Error;
        case "warning":
            return DiagnosticSeverity.Warning;
        case "style":
            return DiagnosticSeverity.Information;
        default:
            return DiagnosticSeverity.Hint;
    }
}

function getLintrCommand(isPackage: boolean, lintrArgs: string, fPath: string)  {
    if (isPackage) {
        return `lint_package("${workspace.rootPath}", ${lintrArgs})`;
    } else {
        return `lint(${fPath}, ${lintrArgs})`;
    }
}
