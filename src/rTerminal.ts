'use strict';

import os = require('os');
import path = require('path');

import { pathExists } from 'fs-extra';
import { isDeepStrictEqual } from 'util';
import { commands, Terminal, TerminalOptions, window } from 'vscode';

import { getSelection } from './selection';
import { removeSessionFiles } from './session';
import { config, delay, getRpath } from './util';
export let rTerm: Terminal;

export async function createRTerm(preserveshow?: boolean): Promise<boolean> {
    const termName = 'R Interactive';
    const termPath = await getRpath();
    console.info(`termPath: ${termPath}`);
    if (termPath === undefined) {
        return undefined;
    }
    const termOpt: string[] = config().get('rterm.option');
    pathExists(termPath, (err, exists) => {
        if (exists) {
            const termOptions: TerminalOptions = {
                name: termName,
                shellPath: termPath,
                shellArgs: termOpt,
            };
            if (config().get<boolean>('sessionWatcher')) {
                termOptions.env = {
                    R_PROFILE_USER_OLD: process.env.R_PROFILE_USER,
                    R_PROFILE_USER: path.join(os.homedir(), '.vscode-R', '.Rprofile'),
                };
            }
            rTerm = window.createTerminal(termOptions);
            rTerm.show(preserveshow);

            return true;
        }
        window.showErrorMessage('Cannot find R client.  Please check R path in preferences and reload.');

        return false;
    });
}

export function deleteTerminal(term: Terminal) {
    if (isDeepStrictEqual(term, rTerm)) {
        if (config().get<boolean>('sessionWatcher')) {
            removeSessionFiles();
        }
        rTerm = undefined;
    }
}

export async function chooseTerminal(active: boolean = false) {
    if (active || config().get('alwaysUseActiveTerminal')) {
        if (window.terminals.length < 1) {
            window.showInformationMessage('There are no open terminals.');

            return undefined;
        }

        return window.activeTerminal;
    }

    if (window.terminals.length > 0) {
        const rTermNameOptions = ['R', 'R Interactive'];
        if (window.activeTerminal !== undefined) {
            const activeTerminalName = window.activeTerminal.name;
            if (rTermNameOptions.includes(activeTerminalName)) {
                return window.activeTerminal;
            }
            for (const terminal of window.terminals) {
                let terminalName = terminal.name;
                if (rTermNameOptions.includes(terminalName)) {
                    terminal.show(true);
                    return terminal;
                }
            }
        } else {
            // Creating a terminal when there aren't any already does not seem to set activeTerminal
            if (window.terminals.length === 1) {
                const activeTerminalName = window.terminals[0].name;
                if (rTermNameOptions.includes(activeTerminalName)) {
                    return window.terminals[0];
                }
            } else {
                // tslint:disable-next-line: max-line-length
                window.showInformationMessage('Error identifying terminal! This shouldn\'t happen, so please file an issue at https://github.com/Ikuyadeu/vscode-R/issues');

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

export function runSelectionInTerm(term: Terminal, moveCursor: boolean) {
    const selection = getSelection();
    if (moveCursor && selection.linesDownToMoveCursor > 0) {
        commands.executeCommand('cursorMove', { to: 'down', value: selection.linesDownToMoveCursor });
        commands.executeCommand('cursorMove', { to: 'wrappedLineFirstNonWhitespaceCharacter' });
    }
    runTextInTerm(term, selection.selectedText);
}

export async function runTextInTerm(term: Terminal, text: string) {
    if (config().get<boolean>('bracketedPaste')) {
        if (process.platform !== 'win32') {
            // Surround with ANSI control characters for bracketed paste mode
            text = `\x1b[200~${text}\x1b[201~`;
        }
        term.sendText(text);
    } else {
        for (const line of text.split('\n')) {
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
    const focus: string = config().get('source.focus');
    term.show(focus !== 'terminal');
}
