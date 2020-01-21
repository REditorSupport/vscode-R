"use strict";

import os = require("os");
import path = require("path");

import { pathExists } from "fs-extra";
import { isDeepStrictEqual } from "util";
import { commands, Terminal, window, TerminalOptions } from "vscode";

import { getSelection } from "./selection";
import { removeSessionFiles } from "./session";
import { config, delay, getRpath } from "./util";
export let rTerm: Terminal;

export function createRTerm(preserveshow?: boolean): boolean {
        const termName = "R Interactive";
        const termPath = getRpath();
        if (termPath === undefined) {
            return undefined;
        }
        const termOpt: string[] = config.get("rterm.option");
        pathExists(termPath, (err, exists) => {
            if (exists) {
                let termOptions: TerminalOptions = {
                    name: termName,
                    shellPath: termPath,
                    shellArgs: termOpt
                };
                if (config.get("sessionWatcher")) {
                    termOptions.env = {
                        R_PROFILE_USER: path.join(os.homedir(), ".vscode-R", ".Rprofile")
                    };
                }
                rTerm = window.createTerminal(termOptions);
                rTerm.show(preserveshow);
                return true;
            }
            window.showErrorMessage("Cannot find R client.  Please check R path in preferences and reload.");

            return false;
        });
    }

export function deleteTerminal(term: Terminal) {
    if (isDeepStrictEqual(term, rTerm)) {
        if (config.get("sessionWatcher")) {
            removeSessionFiles();
        }
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
        const rTermNameOpinions = ["R", "R Interactive"];
        if (window.activeTerminal) {
            const activeTerminalName = window.activeTerminal.name;
            if (rTermNameOpinions.includes(activeTerminalName)) {
                return window.activeTerminal;
            }
        } else {
            // Creating a terminal when there aren't any already does not seem to set activeTerminal
            if (window.terminals.length === 1) {
                const activeTerminalName = window.terminals[0].name;
                if (rTermNameOpinions.includes(activeTerminalName)) {
                    return window.terminals[0];
                }
            } else {
                // tslint:disable-next-line: max-line-length
                window.showInformationMessage("Error identifying terminal! This shouldn't happen, so please file an issue at https://github.com/Ikuyadeu/vscode-R/issues");

                return undefined;
            }
        }
    }

    if (rTerm === undefined) {
        const success = createRTerm(true);
        await delay(200); // Let RTerm warm up
        if (!success) {
            return undefined;
        }
    }

    return rTerm;
}

export function runSelectionInTerm(term: Terminal) {
    const selection = getSelection();
    if (selection.linesDownToMoveCursor > 0) {
        commands.executeCommand("cursorMove", { to: "down", value: selection.linesDownToMoveCursor });
        commands.executeCommand("cursorMove", { to: "wrappedLineFirstNonWhitespaceCharacter" });
    }
    runTextInTerm(term, selection.selectedTextArray);
}

export async function runTextInTerm(term: Terminal, textArray: string[]) {
    if (textArray.length > 1 && config.get<boolean>("bracketedPaste")) {
        if (process.platform !== "win32") {
            // Surround with ANSI control characters for bracketed paste mode
            textArray[0] = `\x1b[200~${textArray[0]}`;
            textArray[textArray.length - 1] += "\x1b[201~";
        }
        term.sendText(textArray.join("\n"));
    } else {
        for (const line of textArray) {
            await delay(8); // Increase delay if RTerm can't handle speed.
            term.sendText(line);
        }
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
