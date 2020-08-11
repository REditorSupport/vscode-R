import * as vscode from 'vscode';
import net = require('net');
import { spawn } from 'child_process';

export class RNotebookProvider implements vscode.NotebookContentProvider {
  private kernalScript: string;
  constructor(kernelScript: string) {
    this.kernalScript = kernelScript;
  }

  async openNotebook(uri: vscode.Uri): Promise<vscode.NotebookData> {
    const content = (await vscode.workspace.fs.readFile(uri)).toString();
    const lines = content.split(/\r?\n/);
    const cells: vscode.NotebookCellData[] = [];
    
    let line = 0;
    let cellType = 'markdown';
    let cellStartLine = 0;
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
        } else if (line == lines.length - 1) {
          cells.push({
            cellKind: vscode.CellKind.Markdown,
            source: lines.slice(cellStartLine, line).join('\n'),
            language: 'markdown',
            outputs: [],
            metadata: {},
          });
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
      }
      line++;
    }
    
    const env = Object.create(process.env);
    env.LANG = "en_US.UTF-8"

    const childProcess = spawn('R', ["--quite", "--slave", "-f", this.kernalScript],
      { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath, env: env });
    childProcess.stderr.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      console.log(`R process (${childProcess.pid}): ${str}`);
    });
    childProcess.on('exit', (code, signal) => {
      console.log(`R process exited with code ${code}`);
    });

    const client = net.createConnection({
      port: 8780,
    }, () => {
        console.log('connected to server!');
    });
    client.on('data', (data) => {
      console.log(data.toString());
      client.end();
    });
    client.on('end', () => {
      console.log('disconnected from server');
    });

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
