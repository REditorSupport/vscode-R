import * as vscode from 'vscode';
import fs = require('fs-extra');

export class RNotebookProvider implements vscode.NotebookContentProvider {
  async openNotebook(uri: vscode.Uri): Promise<vscode.NotebookData> {
    const content = (await vscode.workspace.fs.readFile(uri)).toString();
    const lines = content.split(/\r?\n/);
    const cells: vscode.NotebookCellData[] = [];
    
    let cell: vscode.NotebookCellData;
    let line = 0;
    while (line < lines.length) {

      line++;
    }

    return {
      languages: ['r'],
      metadata: {},
      cells: cells,
    };

    // return {
    //   languages: [ 'r' ],
    //   metadata: { custom: content.metadata },
    //   cells: content.cells.map((cell: any) => {
    //     if (cell.cell_type === 'markdown') {
    //       return {
    //         cellKind: vscode.CellKind.Markdown,
    //         source: cell.source,
    //         language: 'markdown',
    //         outputs: [],
    //         metadata: {}
    //       };
    //     } else if (cell.cell_type === 'code') {
    //       return {
    //         cellKind: vscode.CellKind.Code,
    //         source: cell.source,
    //         language: content.metadata?.language_info?.name || 'r',
    //         outputs: [/* not implemented */],
    //         metadata: {}
    //       };
    //     } else {
    //       console.error('Unexpected cell:', cell);
    //     }
    //   })
    // };
  }

  // The following are dummy implementations not relevant to this example.
  onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentEditEvent>().event;
  async resolveNotebook(): Promise<void> { }
  async saveNotebook(): Promise<void> { }
  async saveNotebookAs(): Promise<void> { }
  async backupNotebook(): Promise<vscode.NotebookDocumentBackup> { return { id: '', delete: () => { } }; }
}
