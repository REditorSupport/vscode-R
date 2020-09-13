import {window, TextEdit, TextEditorCursorStyle, TextEditor, Uri, workspace, WorkspaceEdit, Position} from 'vscode';
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

function parsePosition(rs_position :number[]) {
  if (rs_position.length != 2) throw("an rstudioapi position must be an array of 2 numbers");
  // positions in the rstudioapi are 1 indexed.
  return(new Position(rs_position[0] - 1, rs_position[1] - 1));
}

export async function insertTextAtPosition(position :number[], text :string, id :string = null) {
  
  let target = id === null ? window.activeTextEditor.document.uri : Uri.parse(id);
  let target_text_position = parsePosition(position);
  let n_lines = (await workspace.openTextDocument(target)).lineCount; 
  let target_text = (n_lines > 0 && n_lines < target_text_position.line + 1) ? "\n" + text : text;
  // in a document with lines, does the line position extend past the existing lines in the document?
  // rstudioapi adds a newline in this case, so must we.
  // n_lines is a count, line is 0 indexed position hence + 1
  console.info(`[insertTextAtPosition] inserting text into: ${target}`);
  console.info(`[insertTextAtPosition] inserting at position: ${position}`);
  console.info(`[insertTextAtPosition] inserting text: ${text}`);

  let edit = new WorkspaceEdit;
  edit.insert(target, target_text_position, target_text)
  workspace.applyEdit(edit);
} 