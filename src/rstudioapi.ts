/* eslint-disable @typescript-eslint/restrict-plus-operands */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  window, TextEditor, TextDocument, Uri,
  workspace, WorkspaceEdit, Position, Range, Selection,
  QuickPickItem, QuickPickOptions, ViewColumn
} from 'vscode';
import { readJSON } from 'fs-extra';
import * as path from 'path';
import { sessionDir, sessionDirectoryExists, writeResponse, writeSuccessResponse } from './session';
import { runTextInTerm, restartRTerminal, chooseTerminal } from './rTerminal';
import { config } from './util';

let lastActiveTextEditor: TextEditor;

export async function dispatchRStudioAPICall(action: string, args: any, sd: string): Promise<void> {

  switch (action) {
    case 'active_editor_context': {
      await writeResponse(activeEditorContext(), sd);
      break;
    }
    case 'insert_or_modify_text': {
      await insertOrModifyText(args.query, args.id);
      await writeSuccessResponse(sd);
      break;
    }
    case 'replace_text_in_current_selection': {
      await replaceTextInCurrentSelection(args.text, args.id);
      await writeSuccessResponse(sd);
      break;
    }
    case 'show_dialog': {
      showDialog(args.message);
      await writeSuccessResponse(sd);
      break;
    }
    case 'navigate_to_file': {
      await navigateToFile(args.file, args.line, args.column);
      await writeSuccessResponse(sd);
      break;
    }
    case 'set_selection_ranges': {
      await setSelections(args.ranges, args.id);
      await writeSuccessResponse(sd);
      break;
    }
    case 'document_save': {
      await documentSave(args.id);
      await writeSuccessResponse(sd);
      break;
    }
    case 'document_save_all': {
      await documentSaveAll();
      await writeSuccessResponse(sd);
      break;
    }
    case 'get_project_path': {
      await writeResponse(projectPath(), sd);
      break;
    }
    case 'document_context': {
      await writeResponse(await documentContext(args.id), sd);
      break;
    }
    case 'document_new': {
      await documentNew(args.text, args.type, args.position);
      await writeSuccessResponse(sd);
      break;
    }
    case 'restart_r': {
      await restartRTerminal();
      await writeSuccessResponse(sd);
      break;
    }
    case 'send_to_console': {
      await sendCodeToRTerminal(args.code, args.execute, args.focus);
      await writeSuccessResponse(sd);
      break;
    }
    default:
      console.error(`[dispatchRStudioAPICall] Unsupported action: ${action}`);
  }

}

//rstudioapi
export function activeEditorContext() {
  // info returned from RStudio:
  // list with:
  // id
  // path
  // contents
  // selection - a list of selections
  const currentDocument = getLastActiveTextEditor().document;
  return {
    id: currentDocument.uri,
    contents: currentDocument.getText(),
    path: currentDocument.fileName,
    selection: getLastActiveTextEditor().selections
  };
}

export async function documentContext(id: string) {
  const target = findTargetUri(id);
  const targetDocument = await workspace.openTextDocument(target);
  console.info(`[documentContext] getting context for: ${target.path}`);
  return {
    id: targetDocument.uri
  };
}

export async function insertOrModifyText(query: any[], id: string = null) {


  const target = findTargetUri(id);
  const targetDocument = await workspace.openTextDocument(target);
  console.info(`[insertTextAtPosition] inserting text into: ${target.path}`);
  const edit = new WorkspaceEdit();

  query.forEach((op) => {
    assertSupportedEditOperation(op.operation);

    let editLocation: any;
    const editText = normaliseEditText(op.text, op.location, op.operation, targetDocument);

    if (op.operation === 'insertText') {
      editLocation = parsePosition(op.location, targetDocument);
      console.info(`[insertTextAtPosition] inserting at: ${JSON.stringify(editLocation)}`);
      console.info(`[insertTextAtPosition] inserting text: ${editText}`);
      edit.insert(target, editLocation, editText);
    } else {
      editLocation = parseRange(op.location, targetDocument);
      console.info(`[insertTextAtPosition] replacing at: ${JSON.stringify(editLocation)}`);
      console.info(`[insertTextAtPosition] replacing with text: ${editText}`);
      edit.replace(target, editLocation, editText);
    }
  });

  void workspace.applyEdit(edit);
}

export async function replaceTextInCurrentSelection(text: string, id: string): Promise<void> {
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

export async function setSelections(ranges: number[][], id: string): Promise<void> {
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

export async function documentSave(id: string): Promise<void> {
  const target = findTargetUri(id);
  const targetDocument = await workspace.openTextDocument(target);
  await targetDocument.save();
}

export async function documentSaveAll(): Promise<void> {
  await workspace.saveAll();
}

export function projectPath(): { path: string; } {

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
  //   - the workspaceFolders array was undefined (no folder open)
  //   - the activeText editor was an unsaved document, which has undefined workspace folder.
  // return undefined and handle with a message in R.
  return {
    path: undefined
  };
}

export async function documentNew(text: string, type: string, position: number[]): Promise<void> {
  const documentUri = Uri.parse('untitled:' + path.join(projectPath().path, 'new_document.' + type));
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

let addinQuickPicks: AddinItem[] = undefined;

export async function getAddinPickerItems(): Promise<AddinItem[]> {

  if (typeof addinQuickPicks === 'undefined') {
    const addins: any[] = await readJSON(path.join(sessionDir, 'addins.json')).
      then(
        (result) => result,
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
  const addinSelection: AddinItem =
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
function toVSCCoord(coord: any) {
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
  } else if (coord <= 0) {
    coord_value = 0;
  }
  else { // coord > 0
    coord_value = coord - 1; // positions in the rstudioapi are 1 indexed.
  }

  return coord_value;

}

function parsePosition(rs_position: any[], targetDocument: TextDocument) {
  if (rs_position.length !== 2) {
    throw ('an rstudioapi position must be an array of 2 numbers');
  }
  return (
    targetDocument.validatePosition(
      new Position(toVSCCoord(rs_position[0]), toVSCCoord(rs_position[1]))
    ));
}

function parseRange(rs_range: any, targetDocument: TextDocument) {
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

function normaliseEditText(text: string, editLocation: any,
  operation: string, targetDocument: TextDocument) {
  // in a document with lines, does the line position extend past the existing
  // lines in the document? rstudioapi adds a newline in this case, so must we.
  // n_lines is a count, line is 0 indexed position hence + 1
  const editStartLine = operation === 'insertText' ?
    editLocation[0] :
    editLocation.start[0];
  if (editStartLine === 'Inf' ||
    (editStartLine + 1 > targetDocument.lineCount && targetDocument.lineCount > 0)) {
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

function findTargetUri(id: string) {
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
