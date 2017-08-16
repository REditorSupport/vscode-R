"use srict";

import { Terminal, window } from "vscode";
import { config, getRpath } from "./util";
export let rTerm: Terminal;

export function createRTerm(preserveshow?: boolean) {
        const termName = "R";
        let termPath = getRpath();
        if (!termPath) {
            return;
        }
        const termOpt =  <string[]> config.get("rterm.option");
        rTerm = window.createTerminal(termName, termPath, termOpt);
        rTerm.show(preserveshow);
    }

export function deleteTerminal(term: Terminal) {
    if (term === rTerm) {
        rTerm = null;
    }
}
