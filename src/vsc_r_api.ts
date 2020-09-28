import {
  window, TextEdit, TextEditorCursorStyle, TextEditor, TextDocument, Uri,
  workspace, WorkspaceEdit, Position, Range, MessageOptions, MessageItem, Selection,
  QuickPick, QuickPickItem, QuickPickOptions
} from 'vscode';
import { kMaxLength } from 'buffer';
import { fileURLToPath, Url } from 'url';
import { ENGINE_METHOD_DIGESTS } from 'constants';
import { MessageChannel } from 'worker_threads';
import { watcherDir } from './session';
import fs = require('fs-extra');
import path = require('path');
import { chooseTerminal, runTextInTerm } from './rTerminal';



//vsc-r-api
export async function activeEditorContext() {
  // info returned from RStudio:
  // list with:
  // id
  // path
  // contents
  // selection - a list of selections
  const currentDocument = window.activeTextEditor.document;
  return {
    id: currentDocument.uri,
    contents: currentDocument.getText(),
    path: currentDocument.fileName,
    selection: window.activeTextEditor.selections
  };
}


export async function insertOrModifyText(query: any[], id: string = null) {

  const target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  const targetDocument = await workspace.openTextDocument(target);
  const nLines = targetDocument.lineCount;
  console.info(`[insertTextAtPosition] inserting text into: ${target}`);
  const edit = new WorkspaceEdit();

  query.forEach((op) => {
    assertSupportedEditOperation(op.operation);

    const editOperation = op.operation === 'insertText' ?
      (uri: Uri, newText: string) => edit.insert(uri, parsePosition(op.location), newText) :
      (uri: Uri, newText: string) => edit.replace(uri, parseRange(op.location), newText);

    // in a document with lines, does the line position extend past the existing lines in the document?
    // rstudioapi adds a newline in this case, so must we.
    // n_lines is a count, line is 0 indexed position hence + 1
    const editLocation = op.operation === 'insertText' ? parsePosition(op.location) : parseRange(op.location);
    const editText = normaliseEditText(op.text, locationStart(editLocation), nLines);

    console.info(`[insertTextAtPosition] inserting at: ${JSON.stringify(editLocation)}`);
    console.info(`[insertTextAtPosition] inserting text: ${editText}`);
    return editOperation(target, editText);
  });

  workspace.applyEdit(edit);
}

export async function replaceTextInCurrentSelection(text: string, id: string) {
  const target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  const edit = new WorkspaceEdit();
  edit.replace(
    target,
    window.activeTextEditor.selection,
    text
  );
  workspace.applyEdit(edit);
}

export async function showDialog(message: string) {

  window.showInformationMessage(message);

}

export async function navigateToFile(file: string, line: number, column: number) {

  const targetDocument = await workspace.openTextDocument(Uri.file(file));
  const editor = await window.showTextDocument(targetDocument);
  if (line > 0 && column > 0) {
    const targetPosition = parsePosition([line, column]);
    editor.selection = new Selection(targetPosition, targetPosition);
  }
}

export async function setSelections(ranges: number[][], id: string) {
  // In VSCode it's not possible to get a list of the open text editors. it is
  // not window.visibleTextEditors - this is only editors (tabs) with text
  // showing. So we have to open the target document and and 'show' it, to get
  // access to the editor object and manipulate its' selections. This is
  // different from RStudio which can manipulate the selections and cursor
  // positions in documents on open tabs, without showing those documents.
  const target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  const targetDocument = await workspace.openTextDocument(target);
  const editor = await window.showTextDocument(targetDocument);

  const selectionObjects = ranges.map(x => {
    const newRange = parseRange(x);
    const newSelection = new Selection(newRange.start, newRange.end);
    return (newSelection)
  });

  editor.selections = selectionObjects;
}

export async function documentSave(id: string) {
  const target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  const targetDocument = await workspace.openTextDocument(target)
  await targetDocument.save();
}

// interface

// represents addins in a QuickPick menu
interface AddinItem extends QuickPickItem {
  binding :string;
  package :string;
}

// This a memoised style function that only generates the list of addins for the 
// quick pick menu once, returning the generated array on every subsequent call. 
export const getAddinPickerItems = (() => {

  let addinQuickPicks: AddinItem[] = undefined;

  return async () => {
    if (typeof addinQuickPicks === 'undefined') {
      const addins: any[] = await fs.readJSON(path.join(watcherDir, "addins.json"));
      const addinItems = addins.map((x) => {
        return {
          alwaysShow: true,
          description: x.description,
          label: x.name,
          detail: x.package,
          picked: false,
          binding: x.binding,
          package: x.package,
        }
      })
      addinQuickPicks = addinItems;
    }
    return addinQuickPicks;
  }
})();




export async function launchAddinPicker() {

  // This is important to do before we build the quick pick item list, since if
  // no terminal is active it will create a new one and initialise the addin
  // registry from the latest state of the user's library as part of init.R
  const activeRTerm = await chooseTerminal();

  const addinPickerOptions: QuickPickOptions = {
    matchOnDescription: true,
    matchOnDetail: true,
    canPickMany: false,
    ignoreFocusOut: false,
    placeHolder: '',
    onDidSelectItem: undefined
  }
  const addinSelection :AddinItem = 
    await window.showQuickPick<AddinItem>(getAddinPickerItems(), addinPickerOptions);

    if (!(typeof addinSelection === 'undefined')) {
      runTextInTerm(activeRTerm, addinSelection.package + '::' + addinSelection.binding + '()');
    }
}

//utils
function parsePosition(rs_position: number[]) {
  if (rs_position.length !== 2) {
    throw ('an rstudioapi position must be an array of 2 numbers');
  }
  // positions in the rstudioapi are 1 indexed.
  return (new Position(rs_position[0] - 1, rs_position[1] - 1));
}

function parseRange(rs_range: any) {
  if (rs_range.start.length !== 2 || rs_range.end.length !== 2) {
    throw ('an rstudioapi range must be an object containing two numeric arrays');
  }
  return (new Range(new Position(rs_range.start[0] - 1, rs_range.start[1] - 1),
    new Position(rs_range.end[0] - 1, rs_range.end[1] - 1)));
}

function assertSupportedEditOperation(operation: string) {
  if (operation !== 'insertText' && operation !== 'modifyRange') {
    throw ('Operation: ' + operation + ' not supported by VSCode-R API');
  }
}

function locationStart(location: Position | Range) {
  const startPosition = location instanceof Position ? location : location.start;
  return (startPosition);
}

function normaliseEditText(text: string, editStart: Position, nLines: number) {
  const targetText = (nLines > 0 && nLines < editStart.line + 1) ? '\n' + text : text;
  return (targetText);
}