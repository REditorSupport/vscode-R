"use strict";

import fs = require("fs-extra");
import { isDeepStrictEqual } from "util";
import { commands, Terminal, window } from "vscode";

import { getSelection } from "./selection";
import { config, delay, getRpath } from "./util";
export let rTerm: Terminal;

export function createRTerm(preserveshow?: boolean): boolean {
        const termName = "R Interactive";
        const termPath = getRpath();
        if (!termPath) {
            return;
        }
        const termOpt: string[] = config.get("rterm.option");
        fs.pathExists(termPath, (err, exists) => {
            if (exists) {
                rTerm = window.createTerminal(termName, termPath, termOpt);
                rTerm.show(preserveshow);

                return true;
            }
            window.showErrorMessage("Cannot find R client.  Please check R path in preferences and reload.");

            return false;
        });
    }

export function deleteTerminal(term: Terminal) {
    if (isDeepStrictEqual(term, rTerm)) {
        rTerm = undefined;
    }
}

export async function chooseTerminal(active: boolean = false) {
    if (active || config.get("alwaysUseActiveTerminal")) {
        if (window.terminals.length < 1) {
            window.showInformationMessage("There are no open terminals.");

            return undefined;
        }

        return window.activeTerminal;
    }

    if (window.terminals.length > 0) {
        const RTermNameOpinions = ["R", "R Interactive"];
        if (window.activeTerminal) {
            const activeTerminalName = window.activeTerminal.name;
            if (RTermNameOpinions.includes(activeTerminalName)) {
                return window.activeTerminal;
            }
        } else {
            // Creating a terminal when there aren't any already does not seem to set activeTerminal
            if (window.terminals.length === 1) {
                const activeTerminalName = window.terminals[0].name;
                if (RTermNameOpinions.includes(activeTerminalName)) {
                    return window.terminals[0];
                }
            } else {
                // tslint:disable-next-line: max-line-length
                window.showInformationMessage("Error identifying terminal! This shouldn't happen, so please file an issue at https://github.com/Ikuyadeu/vscode-R/issues");

                return undefined;
            }
        }
    }

    if (!rTerm) {
        const success = createRTerm(true);
        await delay(200); // Let RTerm warm up
        if (!success) {
            return undefined;
        }
    }

    return rTerm;
}

export async function runSelectionInTerm(term: Terminal, rFunctionName: string[]) {
    const selection = getSelection();
    if (selection.linesDownToMoveCursor > 0) {
        commands.executeCommand("cursorMove", { to: "down", value: selection.linesDownToMoveCursor });
        commands.executeCommand("cursorMove", { to: "wrappedLineFirstNonWhitespaceCharacter" });
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
    setFocus(term);
}

export async function chooseTerminalAndSendText(text: string) {
    const callableTerminal = await chooseTerminal();
    if (callableTerminal === undefined) {
        return;
    }
    callableTerminal.sendText(text);
    setFocus(callableTerminal);
}

function setFocus(term: Terminal) {
    const focus: string = config.get("source.focus");
    term.show(focus !== "terminal");
}
