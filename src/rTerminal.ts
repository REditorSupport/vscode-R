'use strict';

import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import * as vscode from 'vscode';

import { extensionContext, homeExtDir } from './extension';
import * as util from './util';
import * as selection from './selection';
import { getSelection } from './selection';
import { cleanupSession, incomingRequestServerAddressInfo } from './session';
import { config, delay, getRterm, getCurrentWorkspaceFolder, hostnameOfListeningAddress } from './util';
import { rGuestService, isGuestSession } from './liveShare';
import * as fs from 'fs';
import { isAbsolute } from 'path';
export let rTerm: vscode.Terminal | undefined = undefined;

export async function runSource(echo: boolean): Promise<void>  {
    const wad = vscode.window.activeTextEditor?.document;
    if (!wad) {
        return;
    }
    const isSaved = await util.saveDocument(wad);
    if (!isSaved) {
        return;
    }
    let rPath: string = util.ToRStringLiteral(wad.fileName, '"');
    let encodingParam = util.config().get<string>('source.encoding');
    if (encodingParam === undefined) {
        return;
    }
    encodingParam = `encoding = "${encodingParam}"`;
    const echoParam = util.config().get<boolean>('source.echo');
    rPath = [rPath, encodingParam].join(', ');
    if (echoParam) {
        echo = true;
    }
    if (echo) {
        rPath = [rPath, 'echo = TRUE'].join(', ');
    }
    void runTextInTerm(`source(${rPath})`);
}

export async function runSelection(): Promise<void> {
    await runSelectionInTerm(true);
}

export async function runSelectionRetainCursor(): Promise<void> {
    await runSelectionInTerm(false);
}

export async function runSelectionOrWord(rFunctionName: string[]): Promise<void> {
    const text = selection.getWordOrSelection();
    if (!text) {
        return;
    }
    const wrappedText = selection.surroundSelection(text, rFunctionName);
    await runTextInTerm(wrappedText);
}

export async function runCommandWithSelectionOrWord(rCommand: string): Promise<void>  {
    const text = selection.getWordOrSelection();
    if (!text) {
        return;
    }
    const call = rCommand.replace(/\$\$/g, text);
    await runTextInTerm(call);
}

export async function runCommandWithEditorPath(rCommand: string): Promise<void>  {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return;
    }
    const wad: vscode.TextDocument = textEditor.document;
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
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return;
    }
    const endLine = textEditor.selection.end.line;
    const charactersOnLine = textEditor.document.lineAt(endLine).text.length;
    const endPos = new vscode.Position(endLine, charactersOnLine);
    const range = new vscode.Range(new vscode.Position(0, 0), endPos);
    const text = textEditor.document.getText(range);
    if (text === undefined) {
        return;
    }
    await runTextInTerm(text);
}

export async function runFromLineToEnd(): Promise<void>  {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return;
    }
    const startLine = textEditor.selection.start.line;
    const startPos = new vscode.Position(startLine, 0);
    const endLine = textEditor.document.lineCount;
    const range = new vscode.Range(startPos, new vscode.Position(endLine, 0));
    const text = textEditor.document.getText(range);
    await runTextInTerm(text);
}

export async function makeTerminalOptions(): Promise<vscode.TerminalOptions> {
    const workspaceFolderPath = getCurrentWorkspaceFolder()?.uri.fsPath;
    const termPath = await getRterm();
    const shellArgs: string[] = config().get<string[]>('rterm.option')?.map(util.substituteVariables) || [];
    const termOptions: vscode.TerminalOptions = {
        name: 'R Interactive',
        shellPath: termPath,
        shellArgs: shellArgs,
        cwd: workspaceFolderPath,
    };
    const newRprofile = extensionContext.asAbsolutePath(path.join('R', 'session', 'profile.R'));
    const initR = extensionContext.asAbsolutePath(path.join('R', 'session','init.R'));
    if (config().get<boolean>('sessionWatcher')) {
        termOptions.env = {
            R_PROFILE_USER_OLD: process.env.R_PROFILE_USER,
            R_PROFILE_USER: newRprofile,
            VSCODE_INIT_R: initR,
            VSCODE_WATCHER_DIR: homeExtDir(),
            VSCODE_ATTACH_HOST: incomingRequestServerAddressInfo === undefined ? undefined :
                hostnameOfListeningAddress(incomingRequestServerAddressInfo),
            VSCODE_ATTACH_PORT: incomingRequestServerAddressInfo?.port?.toString(),
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
    } else if(isAbsolute(termPath) && !fs.existsSync(termPath)){
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
            void term.processId.then((v) => {
                if (v) {
                    void cleanupSession(v.toString());
                }
            });
        }
    }
}

export async function chooseTerminal(): Promise<vscode.Terminal | undefined> {
    // VSCode Python's extension creates hidden terminal with string 'Deactivate'
    // For now ignore terminals with this string
    const ignoreTermIdentifier = 'Deactivate';

    // Filter out terminals to be ignored
    const visibleTerminals = vscode.window.terminals.filter(terminal => {
        return !terminal.name.toLowerCase().includes(ignoreTermIdentifier);
    });

    if (config().get('alwaysUseActiveTerminal')) {
        if (visibleTerminals.length < 1) {
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

    const rTermNameOptions = ['R', 'R Interactive'];

    const validRTerminals = visibleTerminals.filter(terminal => {
        return rTermNameOptions.includes(terminal.name);
    });

    if (validRTerminals.length > 0) {
        // If there is an active terminal that is an R terminal, use it
        if (vscode.window.activeTerminal && rTermNameOptions.includes(vscode.window.activeTerminal.name)) {
            return vscode.window.activeTerminal;
        }
        // Otherwise, use last valid R terminal
        const rTerminal = validRTerminals[validRTerminals.length - 1];
        rTerminal.show(true);
        return rTerminal;
    } else {
        // If no valid R terminals are found, create a new one
        console.info(msg);
        await createRTerm(true);
        await delay(200); // Let RTerm warm up
        return rTerm;
    }
}


export async function runSelectionInTerm(moveCursor: boolean, useRepl = true): Promise<void> {
    const selection = getSelection();
    if (!selection) {
        return;
    }
    if (moveCursor && selection.linesDownToMoveCursor > 0) {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const lineCount = textEditor.document.lineCount;
        if (selection.linesDownToMoveCursor + textEditor.selection.end.line === lineCount) {
            const endPos = new vscode.Position(lineCount, textEditor.document.lineAt(lineCount - 1).text.length);
            await textEditor.edit(e => e.insert(endPos, '\n'));
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
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return;
    }
    const text = chunks
        .map((chunk) => textEditor.document.getText(chunk).trim())
        .filter((chunk) => chunk.length > 0)
        .join('\n');
    if (text.length > 0) {
        return runTextInTerm(text);
    }
}

export async function runTextInTerm(text: string, execute: boolean = true): Promise<void> {
    if (isGuestSession) {
        rGuestService?.requestRunTextInTerm(text);
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
            const rtermSendDelay: number = config().get('rtermSendDelay') || 8;
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
    const focus: string = config().get('source.focus') || 'editor';
    if (focus !== 'none') {
        term.show(focus !== 'terminal');
    }
}

export async function sendRangeToRepl(rng: vscode.Range): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
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
