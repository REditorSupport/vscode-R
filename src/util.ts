import fs = require("fs-extra");
import { window, workspace } from "vscode";
export let config = workspace.getConfiguration("r");

export function getRpath() {
    if (process.platform === "win32") {
        return config.get("rterm.windows") as string;
    } else if (process.platform === "darwin") {
        return config.get("rterm.mac") as string;
    } else if ( process.platform === "linux") {
        return config.get("rterm.linux") as string;
    } else {
        window.showErrorMessage(process.platform + " can't use R");
        return "";
    }
}

export function ToRStringLiteral(s: string, quote: string) {
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

export function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function checkForSpecialCharacters(text) {
    return !/[~`!#$%\^&*+=\-\[\]\\';,/{}|\\":<>\?]/g.test(text);
}

export function checkIfFileExists(filePath) {
    return fs.existsSync(filePath);
}

export function assertRTerminalCreation(rTerm): boolean {
    if (!rTerm) {
        window.showErrorMessage("Could not create R terminal.");
        return false;
    } else {
        return true;
    }
}
