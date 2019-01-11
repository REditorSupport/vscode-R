"use strict";

import fs = require("fs-extra");
import { Terminal, window } from "vscode";
import { config, getRpath } from "./util";
export let rTerm: Terminal;

export function createRTerm(preserveshow?: boolean): boolean {
        const termName = "R Interactive";
        const termPath = getRpath();
        if (!termPath) {
            return;
        }
        const termOpt =  config.get("rterm.option") as string[];
        fs.pathExists(termPath, (err, exists) => {
            if (exists) {
                rTerm = window.createTerminal(termName, termPath, termOpt);
                rTerm.show(preserveshow);
                return true;
            } else {
                window.showErrorMessage("Cannot find R client.  Please check R path in preferences and reload.");
                return false;
            }
        });
    }

export function deleteTerminal(term: Terminal) {
    if (term === rTerm) {
        rTerm = null;
    }
}
