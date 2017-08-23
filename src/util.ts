import { window, workspace } from "vscode";
import fs = require('fs-extra');
export let config = workspace.getConfiguration("r");

export function getRpath() {
    if (process.platform === "win32") {
        return <string> config.get("rterm.windows");
    } else if (process.platform === "darwin") {
        return <string> config.get("rterm.mac");
    } else if ( process.platform === "linux") {
        return <string> config.get("rterm.linux");
    }else {
        window.showErrorMessage(process.platform + "can't use R");
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
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function checkForSpecialCharacters(text) {
    return !/[~`!#$%\^&*+=\-\[\]\\';,/{}|\\":<>\?]/g.test(text);
}

export function checkIfFileExists(filePath) {
    return fs.existsSync(filePath);
}