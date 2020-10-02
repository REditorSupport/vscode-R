import {
  window, TextEdit, TextEditorCursorStyle, TextEditor, TextDocument, Uri,
  workspace, WorkspaceEdit, Position, Range, MessageOptions, MessageItem, Selection,
  QuickPick, QuickPickItem, QuickPickOptions
} from 'vscode';
import { kMaxLength } from 'buffer';
import { fileURLToPath, Url } from 'url';
import { ENGINE_METHOD_DIGESTS } from 'constants';
import { MessageChannel } from 'worker_threads';
import { sessionDir } from './session';
import fs = require('fs-extra');
import path = require('path');
import { chooseTerminal, rTerm, runTextInTerm } from './rTerminal';
import { config } from './util';

let lastActiveTextEditor: TextEditor;


//vsc-r-api
export async function activeEditorContext() {
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
  console.info(`[documentContext] getting context for: ${target}`);
  return {
    id: targetDocument.uri
  };
}

export async function insertOrModifyText(query: any[], id: string = null) {

  const target = findTargetUri(id);
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
  const target = findTargetUri(id);
  const edit = new WorkspaceEdit();
  edit.replace(
    target,
    getLastActiveTextEditor().selection,
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
  const target = findTargetUri(id);
  const targetDocument = await workspace.openTextDocument(target);
  const editor = await window.showTextDocument(targetDocument);

  const selectionObjects = ranges.map(x => {
    const newRange = parseRange(x);
    const newSelection = new Selection(newRange.start, newRange.end);
    return (newSelection);
  });

  editor.selections = selectionObjects;
}

export async function documentSave(id: string) {
  const target = findTargetUri(id);
  const targetDocument = await workspace.openTextDocument(target);
  await targetDocument.save();
}

export async function documentSaveAll() {
  await workspace.saveAll();
}

export function projectPath() {

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

export async function documentNew(text: string, type: string, position: number[]) {
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

  workspace.applyEdit(edit).then(async () => {
    const editor = await window.showTextDocument(targetDocument);
    editor.selections = [new Selection(parsePosition(position), parsePosition(position))];
  });
}

// interface
// represents addins in a QuickPick menu
interface AddinItem extends QuickPickItem {
  binding: string;
  package: string;
}

let addinQuickPicks: AddinItem[] = undefined;

export async function getAddinPickerItems() {

  if (typeof addinQuickPicks === 'undefined') {
    const addins: any[] = await fs.readJSON(path.join(sessionDir, 'addins.json'));
    const addinItems = addins.map((x) => {
      return {
        alwaysShow: true,
        description: x.description,
        label: x.name,
        detail: x.package,
        picked: false,
        binding: x.binding,
        package: x.package,
      };
    });
    addinQuickPicks = addinItems;
  }
  return addinQuickPicks;
}

export function purgeAddinPickerItems() {
  addinQuickPicks = undefined;
}

export async function launchAddinPicker() {

  if (!config().get<boolean>('sessionWatcher')) {
    throw ('{rstudioapi} emulation requires session watcher to be enabled in extension config.');
  }
  if (typeof rTerm === 'undefined') {
    throw ('No active R terminal session, attach one to use RStudio addins.');
  }

  const activeRTerm = await chooseTerminal();

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
    runTextInTerm(activeRTerm, addinSelection.package + ':::' + addinSelection.binding + '()');
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

// window.onActiveTextEditorDidChange handler
export function trackLastActiveTextEditor(editor: TextEditor) {
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