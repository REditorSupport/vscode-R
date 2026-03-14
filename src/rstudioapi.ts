'use strict';

import {
    window, TextEditor, TextDocument, Uri,
    workspace, WorkspaceEdit, Position, Range, Selection,
    QuickPickItem, QuickPickOptions, ViewColumn
} from 'vscode';
import { readJSON } from 'fs-extra';
import * as path from 'path';
import { sessionDir, sessionDirectoryExists } from './session';
import { runTextInTerm, chooseTerminal } from './rTerminal';
import { config } from './util';

let lastActiveTextEditor: TextEditor;

// Types for rstudioapi
export type RSCoord = number | 'Inf' | '-Inf';

export interface RSPosition {
    [index: number]: RSCoord;
    length: number;
}

export interface RSRange {
    start: RSPosition;
    end: RSPosition;
}

export interface RSEditOperation {
    operation: 'insertText' | 'modifyRange';
    text: string;
    location: RSPosition | RSRange;
}

interface RSSelection {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface RSDocumentContext {
    id: { external: string };
    contents: string;
    path: string;
    selection: RSSelection[];
}

// dispatchRStudioAPICall removed

//rstudioapi
export function activeEditorContext(): RSDocumentContext {
    // info returned from RStudio:
    // list with:
    // id
    // path
    // contents
    // selection - a list of selections
    const currentEditor = getLastActiveTextEditor();
    const currentDocument = currentEditor.document;
    return {
        id: { external: currentDocument.uri.toString() },
        contents: currentDocument.getText(),
        path: currentDocument.fileName,
        selection: currentEditor.selections.map(s => ({
            start: { line: s.start.line + 1, character: s.start.character + 1 },
            end: { line: s.end.line + 1, character: s.end.character + 1 }
        }))
    };
}

export async function documentContext(id: string | null): Promise<{ id: { external: string } }> {
    const target = findTargetUri(id);
    const targetDocument = await workspace.openTextDocument(target);
    console.info(`[documentContext] getting context for: ${target.path}`);
    return {
        id: { external: targetDocument.uri.toString() }
    };
}

export async function insertOrModifyText(query: RSEditOperation[], id: string | null = null): Promise<void> {


    const target = findTargetUri(id);
    const targetDocument = await workspace.openTextDocument(target);
    console.info(`[insertTextAtPosition] inserting text into: ${target.path}`);
    const edit = new WorkspaceEdit();

    query.forEach((op) => {
        assertSupportedEditOperation(op.operation);

        let editLocation: Position | Range;
        const editText = normaliseEditText(op.text, op.location, op.operation, targetDocument);

        if (op.operation === 'insertText') {
            editLocation = parsePosition(op.location as RSPosition, targetDocument);
            console.info(`[insertTextAtPosition] inserting at: ${JSON.stringify(editLocation)}`);
            console.info(`[insertTextAtPosition] inserting text: ${editText}`);
            edit.insert(target, editLocation, editText);
        } else {
            editLocation = parseRange(op.location as RSRange, targetDocument);
            console.info(`[insertTextAtPosition] replacing at: ${JSON.stringify(editLocation)}`);
            console.info(`[insertTextAtPosition] replacing with text: ${editText}`);
            edit.replace(target, editLocation, editText);
        }
    });

    void workspace.applyEdit(edit);
}

export async function replaceTextInCurrentSelection(text: string, id: string | null): Promise<void> {
    const target = findTargetUri(id);
    console.info(`[replaceTextInCurrentSelection] inserting: ${text} into ${target.path}`);
    const edit = new WorkspaceEdit();
    edit.replace(
        target,
        getLastActiveTextEditor().selection,
        text
    );
    await workspace.applyEdit(edit);
}

export function showDialog(message: string): void {

    void window.showInformationMessage(message);

}

export async function navigateToFile(file: string, line: number, column: number): Promise<void>{

    const targetDocument = await workspace.openTextDocument(Uri.file(file));
    const editor = await window.showTextDocument(targetDocument);
    const targetPosition = parsePosition([line, column], targetDocument);
    editor.selection = new Selection(targetPosition, targetPosition);
    editor.revealRange(new Range(targetPosition, targetPosition));
}

export async function setSelections(ranges: RSRange[], id: string | null): Promise<void> {
    // Setting selections can only be done on TextEditors not TextDocuments, but
    // it is the latter which are the things actually referred to by `id`. In
    // VSCode it's not possible to get a list of the open text editors. it is not
    // window.visibleTextEditors - this is only editors (tabs) with text showing.
    // The only editors we know about are those that are visible and the last
    // active (which may not be visible if it was overtaken by a WebViewPanel).
    // This function looks to see if a text editor for the document id is amongst
    // those known, and if not, it opens and shows that document, but in a
    // texteditor 'beside' the current one.
    // The rationale for this is:
    // If an addin is trying to set selections in an editor that is not the active
    // one it is most likely that it was active before the addin ran, but the addin
    // opened a something that overtook its' focus. The most likely culprit for
    // this is a shiny app. In the case that the target window is visible
    // alongside the shiny app, it will be found and used. If it is not visible,
    // there's a change it may be the last active, if the shiny app over took it.
    // If it is neither of these things a new one needs to be opened to set
    // selections and the question is whether open it in the same window as the
    // shiny app, or the one 'beside'. 'beside' is preferred since it allows shiny
    // apps that work interactively with an open document to behave more smoothly.
    // {prefixer} is an example of one of these.
    const target = findTargetUri(id);
    const targetDocument = await workspace.openTextDocument(target);
    const editor = await reuseOrCreateEditor(targetDocument);

    const selectionObjects = ranges.map(x => {
        const newRange = parseRange(x, targetDocument);
        const newSelection = new Selection(newRange.start, newRange.end);
        return (newSelection);
    });

    editor.selections = selectionObjects;
}

export async function documentSave(id: string | null): Promise<void> {
    const target = findTargetUri(id);
    const targetDocument = await workspace.openTextDocument(target);
    await targetDocument.save();
}

export async function documentSaveAll(): Promise<void> {
    await workspace.saveAll();
}

export async function documentClose(id: string | null, save: boolean): Promise<void> {
    const target = findTargetUri(id);
    if (save) {
        const targetDocument = await workspace.openTextDocument(target);
        await targetDocument.save();
    }
    const tabs = window.tabGroups.all.flatMap(g => g.tabs);
    const targetTabs = tabs.filter(t => (t.input as { uri?: Uri })?.uri?.toString() === target.toString());
    await window.tabGroups.close(targetTabs);
}

// TODO: very similar to ./utils.getCurrentWorkspaceFolder()
export function projectPath(): { path: string | undefined; } {

    if (typeof workspace.workspaceFolders !== 'undefined') {
        // Is there a root folder open?

        if (workspace.workspaceFolders.length === 1) {
            // In single root common case, this will always work.
            return {
                path: workspace.workspaceFolders[0].uri.path
            };
        } else if (workspace.workspaceFolders.length > 1) {
            // In less common multi-root folder case is a bit tricky. If the active
            // text editor has scheme 'untitled:' (is unsaved), then
            // workspace.getWorkspaceFolder() won't be able to find its Uri in any
            // folder and will return undefined.
            const currentDocument = getLastActiveTextEditor().document;
            const currentDocFolder = workspace.getWorkspaceFolder(currentDocument.uri);
            if (typeof currentDocFolder !== 'undefined') {
                return {
                    path: currentDocFolder.uri.path
                };
            }
        }
    }

    // if we got to here either:
    //     - the workspaceFolders array was undefined (no folder open)
    //     - the activeText editor was an unsaved document, which has undefined workspace folder.
    // return undefined and handle with a message in R.
    return {
        path: undefined
    };
}

export async function documentNew(text: string, type: string, position: number[]): Promise<void> {
    const currentProjectPath = projectPath().path; 
    if (!currentProjectPath) {
        return; // TODO: Report failure
    }
    const documentUri = Uri.parse('untitled:' + path.join(currentProjectPath, 'new_document.' + type));
    const targetDocument = await workspace.openTextDocument(documentUri);
    const edit = new WorkspaceEdit();
    const docLines = targetDocument.lineCount;
    edit.replace(documentUri,
        targetDocument.validateRange(new Range(
            new Position(0, 0),
            new Position(docLines + 1, 0)
        )),
        text);

    void workspace.applyEdit(edit).then(async () => {
        const editor = await window.showTextDocument(targetDocument);
        editor.selections = [new Selection(
            parsePosition(position, targetDocument),
            parsePosition(position, targetDocument)
        )];
    });
}

// interface
// represents addins in a QuickPick menu
interface AddinItem extends QuickPickItem {
    binding: string;
    package: string;
}

let addinQuickPicks: AddinItem[] | undefined = undefined;

interface RawAddin {
    package: string;
    name: string;
    description: string;
    binding: string;
}

export async function getAddinPickerItems(): Promise<AddinItem[]> {

    if (typeof addinQuickPicks === 'undefined') {
        const addins: RawAddin[] = await readJSON(path.join(sessionDir, 'addins.json')).
            then(
                (result: RawAddin[]) => result,
                () => {
                    throw ('Could not find list of installed addins.' +
                        ' options(vsc.rstudioapi = TRUE) must be set in your .Rprofile to use ' +
                        ' RStudio Addins');
                }
            );

        const addinItems = addins.map((x) => {
            return {
                alwaysShow: false,
                description: `{${x.package}}`,
                label: x.name,
                detail: x.description,
                picked: false,
                binding: x.binding,
                package: x.package,
            };
        });
        addinQuickPicks = addinItems;
    }
    return addinQuickPicks;
}

export function purgeAddinPickerItems(): void {
    addinQuickPicks = undefined;
}

export async function launchAddinPicker(): Promise<void> {

    if (!config().get<boolean>('sessionWatcher')) {
        void window.showErrorMessage('{rstudioapi} emulation requires session watcher to be enabled in extension config.');
        return;
    }
    if (!sessionDirectoryExists()) {
        void window.showErrorMessage('No active R terminal session, attach one to use RStudio addins.');
        return;
    }

    const addinPickerOptions: QuickPickOptions = {
        matchOnDescription: true,
        matchOnDetail: true,
        canPickMany: false,
        ignoreFocusOut: false,
        placeHolder: '',
        onDidSelectItem: undefined
    };
    const addinSelection: AddinItem | undefined =
        await window.showQuickPick<AddinItem>(getAddinPickerItems(), addinPickerOptions);

    if (!(typeof addinSelection === 'undefined')) {
        await runTextInTerm(addinSelection.package + ':::' + addinSelection.binding + '()');
    }
}

export async function sendCodeToRTerminal(code: string, execute: boolean, focus: boolean) {
    if (execute) {
        console.info(`[sendCodeToRTerminal] sending code: ${code}`);
    } else {
        console.info(`[sendCodeToRTerminal] inserting code: ${code}`);
    }

    await runTextInTerm(code, execute);
    if (focus) {
        const rTerm = await chooseTerminal();
        if (rTerm !== undefined) {
            rTerm.show();
        }
    }
}

//utils
function toVSCCoord(coord: RSCoord) {
    // this is necessary because RStudio will accept negative or infinite values,
    // replacing them with the min or max or the document.
    // These must be clamped non-negative integers accepted by VSCode.
    // For Inf, we set the value to a very large integer, relying on the
    // parsing functions to revise this down using the validatePosition/Range functions.
    let coord_value: number;
    if (coord === 'Inf') {
        coord_value = 10000000;
    } else if (coord === '-Inf') {
        coord_value = 0;
    } else if (typeof coord === 'number' && coord <= 0) {
        coord_value = 0;
    }
    else { // coord > 0
        coord_value = coord - 1; // positions in the rstudioapi are 1 indexed.
    }

    return coord_value;

}

function parsePosition(rs_position: RSPosition, targetDocument: TextDocument) {
    if (rs_position.length !== 2) {
        throw ('an rstudioapi position must be an array of 2 numbers');
    }
    return (
        targetDocument.validatePosition(
            new Position(toVSCCoord(rs_position[0]), toVSCCoord(rs_position[1]))
        ));
}

function parseRange(rs_range: RSRange, targetDocument: TextDocument) {
    if (rs_range.start.length !== 2 || rs_range.end.length !== 2) {
        throw ('an rstudioapi range must be an object containing two numeric arrays');
    }
    return (
        targetDocument.validateRange(
            new Range(
                new Position(toVSCCoord(rs_range.start[0]), toVSCCoord(rs_range.start[1])),
                new Position(toVSCCoord(rs_range.end[0]), toVSCCoord(rs_range.end[1]))
            )
        ));
}

function assertSupportedEditOperation(operation: string) {
    if (operation !== 'insertText' && operation !== 'modifyRange') {
        throw ('Operation: ' + operation + ' not supported by VSCode-R API');
    }
}

function normaliseEditText(text: string, editLocation: RSPosition | RSRange,
    operation: string, targetDocument: TextDocument) {
    // in a document with lines, does the line position extend past the existing
    // lines in the document? rstudioapi adds a newline in this case, so must we.
    // n_lines is a count, line is 0 indexed position hence + 1
    const editStartLine = operation === 'insertText' ?
        (editLocation as RSPosition)[0] :
        (editLocation as RSRange).start[0];
    if (editStartLine === 'Inf' ||
        (typeof editStartLine === 'number' && editStartLine + 1 > targetDocument.lineCount && targetDocument.lineCount > 0)) {
        return (text + '\n');
    } else {
        return text;
    }
}

// window.onActiveTextEditorDidChange handler
export function trackLastActiveTextEditor(editor?: TextEditor): void {
    if (typeof editor !== 'undefined') {
        lastActiveTextEditor = editor;
    }
}

function getLastActiveTextEditor() {
    return (typeof window.activeTextEditor === 'undefined' ?
        lastActiveTextEditor : window.activeTextEditor);
}

function findTargetUri(id: string | null) {
    return (id === null ?
        getLastActiveTextEditor().document.uri : Uri.parse(id));
}

async function reuseOrCreateEditor(targetDocument: TextDocument) {
    // if there's a known text editor for a Uri, use it. if not, open a new one
    // 'beside' the current one. We know about the last active, and all visible.
    // Sometimes the last active is not visible in the case it was overtaken by a
    // WebViewPanel.

    const KnownEditors: TextEditor[] = [];

    KnownEditors.push(lastActiveTextEditor);
    KnownEditors.push(...window.visibleTextEditors);


    const matchingTextEditors = KnownEditors.filter((editor) =>
        editor.document.uri.toString() === targetDocument.uri.toString());

    if (matchingTextEditors.length === 0) {
        const newEditor = await window.showTextDocument(
            targetDocument,
            ViewColumn.Beside
        );
        return (newEditor);
    }
    else {
        return (matchingTextEditors[0]);
    }
}
