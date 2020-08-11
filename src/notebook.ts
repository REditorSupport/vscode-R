import * as vscode from 'vscode';
import fs = require('fs-extra');

export class RNotebookProvider implements vscode.NotebookContentProvider {
  async openNotebook(uri: vscode.Uri): Promise<vscode.NotebookData> {
    const content = (await vscode.workspace.fs.readFile(uri)).toString();
    const lines = content.split(/\r?\n/);
    const cells: vscode.NotebookCellData[] = [];
    
    let line = 0;
    let cellType = 'markdown';
    let cellStartLine = 1;
    while (line < lines.length) {
      if (cellType === 'markdown') {
        if (lines[line].startsWith('---')) {
          cellType = 'yaml';
          cellStartLine = line;
        } else if (lines[line].startsWith('```{r')) {
          cells.push({
            cellKind: vscode.CellKind.Markdown,
            source: lines.slice(cellStartLine, line).join('\n'),
            language: 'markdown',
            outputs: [],
            metadata: {},
          });
          cellType = 'r';
          cellStartLine = line;
        }
      } else if (cellType === 'yaml') {
        if (lines[line].startsWith('---')) {
          cells.push({
            cellKind: vscode.CellKind.Code,
            source: lines.slice(cellStartLine, line + 1).join('\n'),
            language: 'yaml',
            outputs: [],
            metadata: {},
          });
          cellType = 'markdown';
          cellStartLine = line + 1;
        }
      } else if (cellType === 'r') {
        if (lines[line].startsWith('```')) {
          cells.push({
            cellKind: vscode.CellKind.Code,
            source: lines.slice(cellStartLine + 1, line).join('\n'),
            language: 'r',
            outputs: [],
            metadata: {},
          });
          cellType = 'markdown';
          cellStartLine = line + 1;
        }
      } else if (line == lines.length - 1) {
        cells.push({
          cellKind: vscode.CellKind.Markdown,
          source: lines.slice(cellStartLine, line).join('\n'),
          language: 'markdown',
          outputs: [],
          metadata: {},
        });
      }
      line++;
    }

    return {
      languages: ['r', 'yaml'],
      metadata: {},
      cells: cells,
    };
  }

  // The following are dummy implementations not relevant to this example.
  onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentEditEvent>().event;
  async resolveNotebook(): Promise<void> { }
  async saveNotebook(): Promise<void> { }
  async saveNotebookAs(): Promise<void> { }
  async backupNotebook(): Promise<vscode.NotebookDocumentBackup> { return { id: '', delete: () => { } }; }
}
