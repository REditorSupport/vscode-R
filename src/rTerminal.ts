'use strict';

import * as path from 'path';
import { getMigratedSetting } from './configuration';
import { isDeepStrictEqual } from 'util';

import * as vscode from 'vscode';

import { extensionContext, globalPlotManager } from './extension';
import * as util from './util';
import * as selection from './selection';
import { getSelection } from './selection';
import {
    cleanupTerminalAssociation,
    createSessionDiscoveryFile,
    deferWorkspaceRefresh,
    getGlobalPipePath,
    isTerminalClosed,
    removeTerminalDiscoveryFile,
    updateTerminalSessionDiscoveryFile,
    waitForTerminalReady,
} from './session';
import { config, delay, getRterm, getCurrentWorkspaceFolder, getRPathConfigEntry } from './util';
import { resolveBackend, jgdEnabled, CommonPlotManager } from './plotViewer';
import { tryInteractiveExecution } from './interactive/executionTarget';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

export let rTerm: vscode.Terminal | undefined = undefined;
let rTermResource: vscode.Uri | undefined;
const terminalStartup = new WeakMap<vscode.Terminal, {
    integrated: boolean;
    ready: boolean;
    pending?: Promise<boolean>;
}>();

async function prepareTerminalForInput(terminal: vscode.Terminal): Promise<boolean> {
    const startup = terminalStartup.get(terminal);
    if (!startup || startup.ready) {
        return !isTerminalClosed(terminal) && !terminal.exitStatus;
    }
    if (!startup.pending) {
        startup.pending = (async () => {
            const ready = startup.integrated
                ? await waitForTerminalReady(terminal)
                : await delay(200).then(() => !isTerminalClosed(terminal) && !terminal.exitStatus);
            startup.ready = ready;
            if (!ready && !isTerminalClosed(terminal) && !terminal.exitStatus) {
                void vscode.window.showWarningMessage('R session did not attach, so code was not sent. Install or update sess and restart the R terminal, or disable r.sessionWatcher and reload VS Code before retrying.');
            }
            return ready;
        })();
    }
    const pending = startup.pending;
    try {
        return await pending;
    } finally {
        if (startup.pending === pending) {
            startup.pending = undefined;
        }
    }
}
let startingExecutionTerminal: Promise<vscode.Terminal | undefined> | undefined;
const terminalSends = new WeakMap<vscode.Terminal, Promise<void>>();

let lastParamsRmdPath: string | undefined;
let lastParamsRmdVersion: number | undefined;

const rExprType = new yaml.Type('!r', {
    kind: 'scalar',
    construct: (data: string) => ({ __rExpr: data }),
});
const RMARKDOWN_SCHEMA = yaml.DEFAULT_SCHEMA.extend([rExprType]);

function valueToR(val: unknown): string {
    if (val === null || val === undefined) {
        return 'NULL';
    }
    if (typeof val === 'boolean') {
        return val ? 'TRUE' : 'FALSE';
    }
    if (typeof val === 'number') {
        return String(val);
    }
    if (typeof val === 'string') {
        return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    if (typeof val === 'object' && val !== null && '__rExpr' in (val as Record<string, unknown>)) {
        return (val as { __rExpr: string }).__rExpr;
    }
    if (Array.isArray(val)) {
        return `c(${val.map(valueToR).join(', ')})`;
    }
    const obj = val as Record<string, unknown>;
    if ('value' in obj) {
        return valueToR(obj['value']);
    }
    const entries = Object.entries(obj).map(([k, v]) => `${k} = ${valueToR(v)}`);
    return `list(${entries.join(', ')})`;
}

export function getRmdParamsCommand(document: vscode.TextDocument): string | undefined {
    if (document.languageId !== 'rmd') {
        return undefined;
    }
    const text = document.getText();
    const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match || !/^\s*params\s*:/m.test(match[1])) {
        return undefined;
    }
    const filePath = document.uri.fsPath;
    if (filePath === lastParamsRmdPath && document.version === lastParamsRmdVersion) {
        return undefined;
    }
    lastParamsRmdPath = filePath;
    lastParamsRmdVersion = document.version;
    try {
        const frontmatter = yaml.load(match[1], { schema: RMARKDOWN_SCHEMA }) as Record<string, unknown>;
        const params = frontmatter?.['params'] as Record<string, unknown> | undefined;
        if (!params || typeof params !== 'object') {
            return undefined;
        }
        const entries = Object.entries(params).map(([k, v]) => `${k} = ${valueToR(v)}`);
        return `params <- list(${entries.join(', ')})`;
    } catch {
        return undefined;
    }
}

export async function runSource(echo: boolean): Promise<void>  {
    const wad = vscode.window.activeTextEditor?.document;
    if (!wad) {
        return;
    }
    const target = await tryInteractiveExecution(wad.getText(), wad.uri, { uri: wad.uri.toString(), line: 0, version: wad.version }, !findTerminal());
    if (target === 'executed' || target === 'cancelled') { return; }
    if (target === 'createTerminal' && !await createExecutionTerminal(wad.uri)) { return; }
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

function getConsoleArgs(configuration: vscode.WorkspaceConfiguration): string[] {
    return getMigratedSetting<string[]>(configuration, 'consoleArgs', 'rterm.option')?.value
        ?? ['--no-save', '--no-restore'];
}

function getConsoleSendDelay(resource?: vscode.Uri): number {
    return getMigratedSetting<number>(config(resource), 'consoleSendDelay', 'rtermSendDelay')?.value ?? 8;
}

export async function makeTerminalOptions(resource?: vscode.Uri): Promise<vscode.TerminalOptions> {
    const workspaceFolder = resource ? getCurrentWorkspaceFolder(resource) : getCurrentWorkspaceFolder();
    const configResource = resource ?? workspaceFolder?.uri;
    const workspaceFolderPath = workspaceFolder?.uri.fsPath;
    const currentConfig = config(configResource);
    const termPath = await getRterm(configResource);
    const shellArgs = getConsoleArgs(currentConfig)
        .map(value => util.substituteVariables(value, configResource));
    const termOptions: vscode.TerminalOptions = {
        name: 'R Interactive',
        shellPath: termPath,
        shellArgs: shellArgs,
        cwd: workspaceFolderPath,
    };
    const newRprofile = extensionContext.asAbsolutePath(path.join('R', 'profile.R'));
    if (config().get<boolean>('sessionWatcher')) {
        const pipePath = await getGlobalPipePath();
        const discoveryFile = await createSessionDiscoveryFile(pipePath);
        const backend = resolveBackend();
        termOptions.env = {
            R_PROFILE_USER_OLD: process.env.R_PROFILE_USER,
            R_PROFILE_USER: newRprofile,
            // Remove inherited endpoint overrides so the per-terminal discovery file
            // remains authoritative, including after a VS Code window reload.
            SESS_ENDPOINT: null,
            SESS_DISCOVERY_FILE: discoveryFile,
            SESS_RSTUDIOAPI: config().get<boolean>('session.emulateRStudioAPI') ? 'TRUE' : 'FALSE',
            SESS_PLOT_BACKEND: backend,
        };
        if (jgdEnabled(backend)) {
            const jgdVars = (globalPlotManager as CommonPlotManager)?.getJgdEnvVars() ?? {};
            Object.assign(termOptions.env, jgdVars);
        }
    }
    return termOptions;
}

// ---------------------------------------------------------------------------
// The contributed "R Terminal" profile (the terminal panel's "+" menu)
// ---------------------------------------------------------------------------
//
// A terminal created from a contributed profile is created by VS Code, not by
// createRTerm(), so nothing here ever calls show() on it. VS Code does try to
// focus it, but its extension host fires off the terminal creation without
// awaiting it ($createContributedProfileTerminal -> createTerminalFromOptions)
// and then focuses "the last terminal" — which, when the extension host is
// remote (Codespaces, SSH, the web client), is still the previous terminal
// because the new one has not been registered yet (microsoft/vscode#340185).
// The result: an R terminal that opens without focus, unlike every other
// profile and unlike "R: Create R Terminal".
//
// So each profile request is remembered by the very options object handed to
// VS Code — VS Code freezes that object and exposes it unchanged as
// `terminal.creationOptions` — and the terminal whose creationOptions IS one
// of the pending objects is shown with focus when it opens. Identity is the
// correlation: a terminal from createRTerm() (same name, different object) is
// never mistaken for it, several in-flight requests are each matched to their
// own terminal, and a request whose terminal never opens expires.

const PROFILE_TERMINAL_PENDING_MS = 10_000;
const pendingProfileTerminals = new Map<vscode.TerminalOptions, number>();

export async function provideTerminalProfile(resource?: vscode.Uri, now: number = Date.now()): Promise<vscode.TerminalProfile> {
    const options = await makeTerminalOptions(resource);
    pendingProfileTerminals.set(options, now + PROFILE_TERMINAL_PENDING_MS);
    return new vscode.TerminalProfile(options);
}

/**
 * Called for every terminal that opens. If it is one the contributed profile
 * produced (its creationOptions is a pending request's options object), focus
 * it (see above) and forget the request. Returns whether it did.
 */
export function focusProfileTerminal(terminal: vscode.Terminal, now: number = Date.now()): boolean {
    for (const [options, deadline] of pendingProfileTerminals) {
        if (now > deadline) {
            pendingProfileTerminals.delete(options);
        }
    }
    const options = terminal.creationOptions as vscode.TerminalOptions;
    if (!pendingProfileTerminals.has(options)) {
        return false;
    }
    pendingProfileTerminals.delete(options);
    terminal.show();
    return true;
}

/** Test hook: forget any pending profile requests. */
export function resetProfileTerminalPending(): void {
    pendingProfileTerminals.clear();
}

export async function createRTerm(preserveshow?: boolean, resource?: vscode.Uri): Promise<boolean> {
    resource = resource ?? getCurrentWorkspaceFolder()?.uri;
    const termOptions = await makeTerminalOptions(resource);
    const termPath = termOptions.shellPath;
    const discoveryFile = termOptions.env?.['SESS_DISCOVERY_FILE'];
    const discardDiscoveryFile = async () => {
        if (typeof discoveryFile === 'string') {
            try {
                await fs.promises.unlink(discoveryFile);
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                    return;
                }
                console.error('Failed to remove unused session discovery file', error);
            }
        }
    };
    if(!termPath){
        await discardDiscoveryFile();
        return false;
    } else if(!fs.existsSync(termPath)){
        void vscode.window.showErrorMessage(`Cannot find R console executable at ${termPath}. Please check r.consolePath, r.${getRPathConfigEntry(true)}, or r.executablePath.`);
        await discardDiscoveryFile();
        return false;
    }
    let createdTerminal: vscode.Terminal;
    try {
        if (!await util.promptToInstallSessPackage(termOptions.cwd)) {
            await discardDiscoveryFile();
            return false;
        }
        createdTerminal = vscode.window.createTerminal(termOptions);
    } catch (error) {
        await discardDiscoveryFile();
        throw error;
    }
    rTerm = createdTerminal;
    rTermResource = resource;
    const args = termOptions.shellArgs;
    const skipsProfile = Array.isArray(args) && args.some(arg => arg === '--vanilla' || arg === '--no-init-file');
    terminalStartup.set(createdTerminal, {
        integrated: typeof discoveryFile === 'string' && !skipsProfile,
        ready: false,
    });
    createdTerminal.show(preserveshow);

    void Promise.resolve(createdTerminal.processId).then(async (pid: number | undefined) => {
        if (pid && typeof discoveryFile === 'string' && !isTerminalClosed(createdTerminal)) {
            const pipePath = await getGlobalPipePath();
            if (!isTerminalClosed(createdTerminal)) {
                await updateTerminalSessionDiscoveryFile(createdTerminal, discoveryFile, pipePath, pid);
            }
        }
    }).catch(error => console.error('Failed to update terminal session discovery file', error));
    
    return true;
}

export async function restartRTerminal(): Promise<void>{
    if (typeof rTerm !== 'undefined'){
        const resource = rTermResource;
        rTerm.dispose();
        deleteTerminal(rTerm);
        await createRTerm(true, resource);
    }
}

export function deleteTerminal(term: vscode.Terminal): void {
    const exitReason = term.exitStatus?.reason;
    if (exitReason === vscode.TerminalExitReason.User
        || exitReason === vscode.TerminalExitReason.Process
        || exitReason === vscode.TerminalExitReason.Extension) {
        void removeTerminalDiscoveryFile(term).catch(error => {
            console.error('Failed to remove terminal session discovery file', error);
        });
    }
    // TODO: Prune orphaned extension-owned discovery files left by crashes, when
    // safe lifecycle information is available without relying on local PID polling.
    if (isDeepStrictEqual(term, rTerm)) {
        rTerm = undefined;
        rTermResource = undefined;
        if (config().get<boolean>('sessionWatcher')) {
            void term.processId.then((v) => {
                if (v) {
                    cleanupTerminalAssociation(v.toString());
                }
            });
        }
    }
}

function getTerminalResource(term: vscode.Terminal): vscode.Uri | undefined {
    if (term === rTerm && rTermResource) {
        return rTermResource;
    }

    const creationOptions = term.creationOptions;
    const cwd = creationOptions && 'cwd' in creationOptions ? creationOptions.cwd : undefined;
    // Profile terminals store cwd as a path; retain the matching remote URI.
    const cwdResource = typeof cwd === 'string'
        ? vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === cwd)?.uri ?? vscode.Uri.file(cwd)
        : cwd;
    return cwdResource
        ? getCurrentWorkspaceFolder(cwdResource)?.uri ?? cwdResource
        : getCurrentWorkspaceFolder()?.uri;
}

export function findTerminal(): vscode.Terminal | undefined {
    // VSCode Python's extension creates hidden terminal with string 'Deactivate'
    // For now ignore terminals with this string
    const ignoreTermIdentifier = 'deactivate';

    // Filter out terminals to be ignored
    const visibleTerminals = vscode.window.terminals.filter(terminal => {
        return terminal.exitStatus === undefined && !terminal.name.toLowerCase().includes(ignoreTermIdentifier);
    });

    if (config().get('alwaysUseActiveTerminal')) {
        return visibleTerminals.find(terminal => terminal === vscode.window.activeTerminal);
    }

    const rTermNameOptions = ['R', 'R Interactive'];

    const validRTerminals = visibleTerminals.filter(terminal => {
        return rTermNameOptions.includes(terminal.name);
    });

    if (validRTerminals.length > 0) {
        // If there is an active terminal that is an R terminal, use it
        if (vscode.window.activeTerminal && validRTerminals.includes(vscode.window.activeTerminal)) {
            return vscode.window.activeTerminal;
        }
        // Otherwise, use last valid R terminal
        return validRTerminals[validRTerminals.length - 1];
    }
}

export async function chooseTerminal(): Promise<vscode.Terminal | undefined> {
    const terminal = findTerminal();
    if (terminal) { terminal.show(true); return terminal; }
    if (config().get('alwaysUseActiveTerminal')) {
        void vscode.window.showInformationMessage('There are no open terminals.'); return;
    }
    return await createExecutionTerminal();
}

async function createExecutionTerminal(resource?: vscode.Uri): Promise<vscode.Terminal | undefined> {
    const pending = startingExecutionTerminal ??= (async () => {
        if (!await createRTerm(true, resource)) { return; }
        return rTerm;
    })();
    try { return await pending; }
    finally { if (startingExecutionTerminal === pending) { startingExecutionTerminal = undefined; } }
}

export async function runSelectionInTerm(moveCursor: boolean, useRepl = true): Promise<void> {
    const selection = getSelection();
    if (!selection) {
        return;
    }
    const textEditor = vscode.window.activeTextEditor;
    if(useRepl && vscode.debug.activeDebugSession?.type === 'R-Debugger'){
        await sendRangeToRepl(selection.range);
    } else{
        const paramsCmd = textEditor ? getRmdParamsCommand(textEditor.document) : undefined;
        if (!await runTextInTerm(paramsCmd ? `${paramsCmd}\n${selection.selectedText}` : selection.selectedText)) { return; }
    }
    // Cancellation must preserve both the selected code and its cursor position.
    if (vscode.window.activeTextEditor !== textEditor) { return; }
    if (moveCursor && selection.linesDownToMoveCursor > 0) {
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
}

export async function runChunksInTerm(chunks: vscode.Range[]): Promise<void> {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return;
    }
    const paramsCmd = getRmdParamsCommand(textEditor.document);
    const text = chunks
        .map((chunk) => textEditor.document.getText(chunk).trim())
        .filter((chunk) => chunk.length > 0)
        .join('\n');
    if (text.length > 0) {
        await runTextInTerm(paramsCmd ? `${paramsCmd}\n${text}` : text);
    }
}

export async function runTextInTerm(text: string, execute: boolean = true): Promise<boolean> {
    const document = vscode.window.activeTextEditor?.document;
    const target = execute && await tryInteractiveExecution(text, document?.uri, document ? {
        uri: document.uri.toString(), line: vscode.window.activeTextEditor?.selection?.start.line ?? 0, version: document.version,
    } : undefined, !findTerminal());
    if (target === 'executed' || target === 'cancelled') { return target === 'executed'; }
    let term: vscode.Terminal | undefined;
    if (target === 'createTerminal') {
        term = await createExecutionTerminal(document?.uri);
    } else { term = await chooseTerminal(); }
    if (term === undefined || !await prepareTerminalForInput(term)) {
        return false;
    }
    await runTextInTerminal(term, text, execute);
    return true;
}

export async function runTextInTerminal(terminal: vscode.Terminal, text: string, execute = true): Promise<void> {
    const pending = (terminalSends.get(terminal) ?? Promise.resolve()).catch(() => undefined)
        .then(() => sendToTerminal(terminal, text, execute));
    terminalSends.set(terminal, pending);
    try { await pending; }
    finally { if (terminalSends.get(terminal) === pending) { terminalSends.delete(terminal); } }
}

async function sendToTerminal(term: vscode.Terminal, text: string, execute: boolean): Promise<void> {
    deferWorkspaceRefresh();
    if (config().get<boolean>('bracketedPaste')) {
        // Surround with ANSI control characters for bracketed paste mode
        text = `\x1b[200~${text}\x1b[201~`;
        term.sendText(text, execute);
    } else {
        const resource = getTerminalResource(term);
        const rtermSendDelay = getConsoleSendDelay(resource);
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
