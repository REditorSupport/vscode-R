import { window, TextEdit, TextEditorCursorStyle, TextEditor, TextDocument, Uri, workspace, WorkspaceEdit, Position, Range } from 'vscode';
import { kMaxLength } from 'buffer';
import { Url } from 'url';


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

  let target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  let targetDocument = await workspace.openTextDocument(target);
  let nLines = targetDocument.lineCount;
  console.info(`[insertTextAtPosition] inserting text into: ${target}`);
  let edit = new WorkspaceEdit();

  query.forEach((op) => {
    assertSupportedEditOperation(op.operation);

    let editOperation = op.operation == "insertText" ?
      (uri: Uri, newText: string) => edit.insert(uri, parsePosition(op.location), newText) :
      (uri: Uri, newText: string) => edit.replace(uri, parseRange(op.location), newText);

    // in a document with lines, does the line position extend past the existing lines in the document?
    // rstudioapi adds a newline in this case, so must we.
    // n_lines is a count, line is 0 indexed position hence + 1
    let editLocation = op.operation == "insertText" ? parsePosition(op.location) : parseRange(op.location);
    let editText = normaliseEditText(op.text, locationStart(editLocation), nLines);

    console.info(`[insertTextAtPosition] inserting at: ${JSON.stringify(editLocation)}`);
    console.info(`[insertTextAtPosition] inserting text: ${editText}`);
    console.info(`[insertTextAtPosition] going with edit: ${JSON.stringify(edit)}`)
    return editOperation(target, editText);
  });

  workspace.applyEdit(edit);
}

//utils
function parsePosition(rs_position: number[]) {
  if (rs_position.length != 2) throw ("an rstudioapi position must be an array of 2 numbers");
  // positions in the rstudioapi are 1 indexed.
  return (new Position(rs_position[0] - 1, rs_position[1] - 1));
}

function parseRange(rs_range: any) {
  if (rs_range.start.length != 2 || rs_range.end.length != 2) throw ("an rstudioapi range must be an object containing two numeric arrays");

  return (new Range(new Position(rs_range.start[0] - 1, rs_range.start[1] - 1),
    new Position(rs_range.end[0] - 1, rs_range.end[1] - 1)));
}

function assertSupportedEditOperation(operation: string) {
  if (operation != "insertText" && operation != "modifyRange") {
    throw ("Operation: " + operation + " not supported by VSCode-R API");
  }
}

function locationStart(location: Position | Range) {
  let startPosition = location instanceof Position ? location : location.start;
  return (startPosition);
}

function normaliseEditText(text: string, editStart: Position, nLines: number) {
  let targetText = (nLines > 0 && nLines < editStart.line + 1) ? "\n" + text : text;
  return (targetText);
}