'use strict';

import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import * as vscode from 'vscode';

import { extensionContext, homeExtDir } from './extension';
import * as util from './util';
import * as selection from './selection';
import { getSelection } from './selection';
import { removeSessionFiles } from './session';
import { config, delay, getRterm } from './util';
import { rGuestService, isGuestSession } from './liveShare';
import * as fs from 'fs';
export let rTerm: vscode.Terminal;

export async function runSource(echo: boolean): Promise<void>  {
    const wad = vscode.window.activeTextEditor?.document;
    const isSaved = await util.saveDocument(wad);
    if (isSaved) {
        let rPath: string = util.ToRStringLiteral(wad.fileName, '"');
        let encodingParam = util.config().get<string>('source.encoding');
        encodingParam = `encoding = "${encodingParam}"`;
        rPath = [rPath, encodingParam].join(', ');
        if (echo) {
            rPath = [rPath, 'echo = TRUE'].join(', ');
        }
        void runTextInTerm(`source(${rPath})`);
    }
}

export async function runSelection(): Promise<void> {
    await runSelectionInTerm(true);
}

export async function runSelectionRetainCursor(): Promise<void> {
    await runSelectionInTerm(false);
}

export async function runSelectionOrWord(rFunctionName: string[]): Promise<void> {
    const text = selection.getWordOrSelection();
    const wrappedText = selection.surroundSelection(text, rFunctionName);
    await runTextInTerm(wrappedText);
}

export async function runCommandWithSelectionOrWord(rCommand: string): Promise<void>  {
    const text = selection.getWordOrSelection();
    const call = rCommand.replace(/\$\$/g, text);
    await runTextInTerm(call);
}

export async function runCommandWithEditorPath(rCommand: string): Promise<void>  {
    const wad: vscode.TextDocument = vscode.window.activeTextEditor.document;
    const isSaved = await util.saveDocument(wad);
    if (isSaved) {
        const rPath = util.ToRStringLiteral(wad.fileName, '');
        const call = rCommand.replace(/\$\$/g, rPath);
        await runTextInTerm(call);
    }
}

export async function runCommand(rCommand: string): Promise<void>  {
    await runTextInTerm(rCommand);
}

export async function runFromBeginningToLine(): Promise<void>  {
    const endLine = vscode.window.activeTextEditor.selection.end.line;
    const charactersOnLine = vscode.window.activeTextEditor.document.lineAt(endLine).text.length;
    const endPos = new vscode.Position(endLine, charactersOnLine);
    const range = new vscode.Range(new vscode.Position(0, 0), endPos);
    const text = vscode.window.activeTextEditor.document.getText(range);
    await runTextInTerm(text);
}

export async function runFromLineToEnd(): Promise<void>  {
    const startLine = vscode.window.activeTextEditor.selection.start.line;
    const startPos = new vscode.Position(startLine, 0);
    const endLine = vscode.window.activeTextEditor.document.lineCount;
    const range = new vscode.Range(startPos, new vscode.Position(endLine, 0));
    const text = vscode.window.activeTextEditor.document.getText(range);
    await runTextInTerm(text);
}

export async function makeTerminalOptions(): Promise<vscode.TerminalOptions> {
    const termPath = await getRterm();
    const shellArgs: string[] = config().get('rterm.option');
    const termOptions: vscode.TerminalOptions = {
        name: 'R Interactive',
        shellPath: termPath,
        shellArgs: shellArgs,
    };
    const newRprofile = extensionContext.asAbsolutePath(path.join('R', 'session', 'profile.R'));
    const initR = extensionContext.asAbsolutePath(path.join('R', 'session','init.R'));
    if (config().get<boolean>('sessionWatcher')) {
        termOptions.env = {
            R_PROFILE_USER_OLD: process.env.R_PROFILE_USER,
            R_PROFILE_USER: newRprofile,
            VSCODE_INIT_R: initR,
            VSCODE_WATCHER_DIR: homeExtDir()
        };
    }
    return termOptions;
}

export async function createRTerm(preserveshow?: boolean): Promise<boolean> {
    const termOptions = await makeTerminalOptions();
    const termPath = termOptions.shellPath;
    if(!termPath){
        void vscode.window.showErrorMessage('Could not find R path. Please check r.term and r.path setting.');
        return false;
    } else if(!fs.existsSync(termPath)){
        void vscode.window.showErrorMessage(`Cannot find R client at ${termPath}. Please check r.rterm setting.`);
        return false;
    }
    rTerm = vscode.window.createTerminal(termOptions);
    rTerm.show(preserveshow);
    return true;
}

export async function restartRTerminal(): Promise<void>{
    if (typeof rTerm !== 'undefined'){
        rTerm.dispose();
        deleteTerminal(rTerm);
        await createRTerm(true);
    }
}

export function deleteTerminal(term: vscode.Terminal): void {
    if (isDeepStrictEqual(term, rTerm)) {
        rTerm = undefined;
        if (config().get<boolean>('sessionWatcher')) {
            removeSessionFiles();
        }
    }
}

export async function chooseTerminal(): Promise<vscode.Terminal> {
    if (config().get('alwaysUseActiveTerminal')) {
        if (vscode.window.terminals.length < 1) {
            void vscode.window.showInformationMessage('There are no open terminals.');

            return undefined;
        }

        return vscode.window.activeTerminal;
    }

    let msg = '[chooseTerminal] ';
    msg += `A. There are ${vscode.window.terminals.length} terminals: `;
    for (let i = 0; i < vscode.window.terminals.length; i++){
        msg += `Terminal ${i}: ${vscode.window.terminals[i].name} `;
    }
    if (vscode.window.terminals.length > 0) {
        const rTermNameOptions = ['R', 'R Interactive'];
        if (vscode.window.activeTerminal !== undefined) {
            const activeTerminalName = vscode.window.activeTerminal.name;
            if (rTermNameOptions.includes(activeTerminalName)) {
                return vscode.window.activeTerminal;
            }
            for (let i = vscode.window.terminals.length - 1; i >= 0; i--){
                const terminal = vscode.window.terminals[i];
                const terminalName = terminal.name;
                if (rTermNameOptions.includes(terminalName)) {
                    terminal.show(true);
                    return terminal;
                }
            }
        } else {
            msg += `B. There are ${vscode.window.terminals.length} terminals: `;
            for (let i = 0; i < vscode.window.terminals.length; i++){
                msg += `Terminal ${i}: ${vscode.window.terminals[i].name} `;
            }
            // Creating a terminal when there aren't any already does not seem to set activeTerminal
            if (vscode.window.terminals.length === 1) {
                const activeTerminalName = vscode.window.terminals[0].name;
                if (rTermNameOptions.includes(activeTerminalName)) {
                    return vscode.window.terminals[0];
                }
            } else {
                msg += `C. There are ${vscode.window.terminals.length} terminals: `;
                for (let i = 0; i < vscode.window.terminals.length; i++){
                    msg += `Terminal ${i}: ${vscode.window.terminals[i].name} `;
                }
                console.info(msg);
                void vscode.window.showErrorMessage('Error identifying terminal! Please run command "Developer: Toggle Developer Tools", find the message starting with "[chooseTerminal]", and copy the message to https://github.com/REditorSupport/vscode-R/issues');

                return undefined;
            }
        }
    }

    if (rTerm === undefined) {
        await createRTerm(true);
        await delay(200); // Let RTerm warm up
    }

    return rTerm;
}

export async function runSelectionInTerm(moveCursor: boolean, useRepl = true): Promise<void> {
    const selection = getSelection();
    if (moveCursor && selection.linesDownToMoveCursor > 0) {
        const lineCount = vscode.window.activeTextEditor.document.lineCount;
        if (selection.linesDownToMoveCursor + vscode.window.activeTextEditor.selection.end.line === lineCount) {
            const endPos = new vscode.Position(lineCount, vscode.window.activeTextEditor.document.lineAt(lineCount - 1).text.length);
            await vscode.window.activeTextEditor.edit(e => e.insert(endPos, '\n'));
        }
        await vscode.commands.executeCommand('cursorMove', { to: 'down', value: selection.linesDownToMoveCursor });
        await vscode.commands.executeCommand('cursorMove', { to: 'wrappedLineFirstNonWhitespaceCharacter' });
    }
    if(useRepl && vscode.debug.activeDebugSession?.type === 'R-Debugger'){
        await sendRangeToRepl(selection.range);
    } else{
        await runTextInTerm(selection.selectedText);
    }
}

export async function runChunksInTerm(chunks: vscode.Range[]): Promise<void> {
    const text = chunks
        .map((chunk) => vscode.window.activeTextEditor.document.getText(chunk).trim())
        .filter((chunk) => chunk.length > 0)
        .join('\n');
    if (text.length > 0) {
        return runTextInTerm(text);
    }
}

export async function runTextInTerm(text: string, execute: boolean = true): Promise<void> {
    if (isGuestSession) {
        rGuestService.requestRunTextInTerm(text);
    } else {
        const term = await chooseTerminal();
        if (term === undefined) {
            return;
        }
        if (config().get<boolean>('bracketedPaste')) {
            if (process.platform !== 'win32') {
                // Surround with ANSI control characters for bracketed paste mode
                text = `\x1b[200~${text}\x1b[201~`;
            }
            term.sendText(text, execute);
        } else {
            const rtermSendDelay: number = config().get('rtermSendDelay');
            const split = text.split('\n');
            const last_split = split.length - 1;
            for (const [count, line] of split.entries()) {
                if (count > 0) {
                    await delay(rtermSendDelay); // Increase delay if RTerm can't handle speed.
                }

                // Avoid sending newline on last line
                if (count === last_split && !execute) {
                    term.sendText(line, false);
                } else {
                    term.sendText(line);
                }
            }
        }
        setFocus(term);
        // Scroll console to see latest output
        await vscode.commands.executeCommand('workbench.action.terminal.scrollToBottom');
    }
}

function setFocus(term: vscode.Terminal) {
    const focus: string = config().get('source.focus');
    if (focus !== 'none') {
        term.show(focus !== 'terminal');
    }
}

export async function sendRangeToRepl(rng: vscode.Range): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const sel0 = editor.selections;
    let sel1 = new vscode.Selection(rng.start, rng.end);
    while(/^[\r\n]/.exec(editor.document.getText(sel1))){
        sel1 = new vscode.Selection(sel1.start.translate(1), sel1.end);
    }
    while(/\r?\n\r?\n$/.exec(editor.document.getText(sel1))){
        sel1 = new vscode.Selection(sel1.start, sel1.end.translate(-1));
    }
    editor.selections = [sel1];
    await vscode.commands.executeCommand('editor.debug.action.selectionToRepl');
    editor.selections = sel0;
}
