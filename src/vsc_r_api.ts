import {window} from 'vscode';


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
