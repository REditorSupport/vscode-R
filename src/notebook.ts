import * as vscode from 'vscode';
import net = require('net');
import { spawn, ChildProcess } from 'child_process';
import { dirname } from 'path';

class RKernel {
  private kernelScript: string;
  private cwd: string;
  private process: ChildProcess;
  private server: net.Server;
  private port: number;
  private outputBuffer = '';

  constructor(kernelScript: string, doc: vscode.NotebookDocument) {
    this.kernelScript = kernelScript;
    this.cwd = dirname(doc.uri.fsPath);
  }

  public start() {
    if (this.process) {
      return;
    }

    const env = Object.create(process.env);
    env.LANG = 'en_US.UTF-8';

    const server = net.createServer((socket) => {
      console.log('server created');
      socket.on('end', () => {
        console.log('R process disconnected');
      });
      socket.on('data', (data) => {
        console.log(data.toString());
        socket.end();
      });
      server.close();
    });

    this.server = server;

    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;
      const childProcess = spawn('R', ['--quite', '--slave', '-f', this.kernelScript, '--args', `port=${port}`],
        { cwd: this.cwd, env: env });
      childProcess.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        console.log(`R process (${childProcess.pid}): ${str}`);
      });
      childProcess.on('exit', (code, signal) => {
        console.log(`R process exited with code ${code}`);
      });
      this.process = childProcess;
      this.port = port;
    });
  }

  public stop() {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
  }

  public restart() {
    this.stop();
    this.start();
  }

  public async eval(cell: vscode.NotebookCell): Promise<string> {
    if (this.process && this.server) {
      this.outputBuffer = '';
      await new Promise(res => setTimeout(res, 500));

      const client = net.createConnection({ port: this.port }, () => {
        console.log('connected to server!');
      });

      client.on('data', (data) => {
        const result = data.toString();
        console.log(result);
        this.outputBuffer += result;
        client.end();
      });

      client.on('end', () => {
        console.log('disconnected from server');
      });

      client.write(JSON.stringify({
        time: Date.now(),
        uri: cell.uri.toString(),
        expr: '1+1',
      }));

      return Promise.resolve(this.outputBuffer);
    }
  }
}

class RNotebook implements vscode.Disposable {
  private kernel: RKernel;
  private disposables: vscode.Disposable[] = [];

  constructor(kernelScript: string, doc: vscode.NotebookDocument) {
    this.kernel = new RKernel(kernelScript, doc);
  }

  dispose() {
    this.kernel.stop();
  }

  public async restartKernel() {
    await vscode.commands.executeCommand('notebook.clearAllCellsOutputs');
    this.kernel.restart();
  }

  public async eval(cell: vscode.NotebookCell): Promise<string> {
    this.kernel.start();
    return this.kernel.eval(cell);
  }
}

export class RNotebookProvider implements vscode.NotebookContentProvider, vscode.NotebookKernel {
  public label = 'R Kernel';
  public kernel = this;

  private kernelScript: string;
  private disposables: vscode.Disposable[] = [];
  private readonly notebooks = new Map<string, RNotebook>();

  constructor(kernelScript: string) {
    this.kernelScript = kernelScript;
    this.disposables.push(
      vscode.notebook.onDidOpenNotebookDocument(document => {
        const docKey = document.uri.toString();
        if (!this.notebooks.has(docKey)) {
          this.notebooks.set(docKey, new RNotebook(this.kernelScript, document));
        }
      }),
      vscode.notebook.onDidCloseNotebookDocument(document => {
        const docKey = document.uri.toString();
        const notebook = this.notebooks.get(docKey);
        if (notebook) {
          notebook.dispose();
          this.notebooks.delete(docKey);
        }
      }),
    );
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
            metadata: {
              editable: true,
              runnable: false,
            },
          });
          cellType = 'r';
          cellStartLine = line;
        } else if (line === lines.length - 1) {
          cells.push({
            cellKind: vscode.CellKind.Markdown,
            source: lines.slice(cellStartLine, line).join('\n'),
            language: 'markdown',
            outputs: [],
            metadata: {
              editable: true,
              runnable: false,
            },
          });
        }
      } else if (cellType === 'yaml') {
        if (lines[line].startsWith('---')) {
          cells.push({
            cellKind: vscode.CellKind.Markdown,
            source: lines.slice(cellStartLine, line + 1).join('\n'),
            language: 'yaml',
            outputs: [],
            metadata: {
              editable: true,
              runnable: false,
            },
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
            metadata: {
              editable: true,
              runnable: true,
            },
          });
          cellType = 'markdown';
          cellStartLine = line + 1;
        }
      }
      line++;
    }

    return {
      languages: ['r', 'yaml'],
      metadata: { },
      cells: cells,
    };
  }

  // The following are dummy implementations not relevant to this example.
  onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentEditEvent>().event;
  async resolveNotebook(): Promise<void> { }
  async saveNotebook(document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> { }
  async saveNotebookAs(targetResource: vscode.Uri, document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> { }
  async backupNotebook(document: vscode.NotebookDocument, context: vscode.NotebookDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.NotebookDocumentBackup> { return { id: '', delete: () => { } }; }
  async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell) {
    const notebook = this.notebooks.get(document.uri.toString());

    if (!cell) {  
      if (notebook) {
        notebook.restartKernel();
      }

      for (const cell of document.cells) {
        if (cell.cellKind === vscode.CellKind.Code && cell.metadata.runnable) {
          await this.executeCell(document, cell);
        }
      }

      return;
    }

    let output = '';
    let error: Error;

    if (notebook) {
      try {
        output = await notebook.eval(cell);
      } catch (e) {
        error = e;
      }
    }

    if (error) {
      cell.outputs = [{
        outputKind: vscode.CellOutputKind.Error,
        evalue: error.toString(),
        ename: '',
        traceback: [],
      }];
    } else {
      cell.outputs = [{
        outputKind: vscode.CellOutputKind.Text,
        text: output,
      }];
    }
  }

  async executeAllCells(document: vscode.NotebookDocument): Promise<void> {
    for (const cell of document.cells) {
      await this.executeCell(document, cell);
    }
  }

  async cancelCellExecution(document: vscode.NotebookDocument, cell: vscode.NotebookCell) {

  }

  async cancelAllCellsExecution(document: vscode.NotebookDocument) {

  }

  public dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
