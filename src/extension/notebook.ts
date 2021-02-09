import * as vscode from 'vscode';
import net = require('net');
import { spawn, ChildProcess } from 'child_process';
import { dirname } from 'path';
import { inlineAll } from './inlineScripts';

interface RKernelRequest {
  id: number;
  type: 'eval' | 'cancel';
  expr?: any;
}

interface RKernelResponse {
  id: number;
  type: 'text' | 'plot' | 'viewer' | 'browser' | 'error';
  result: string;
}

class RKernel {
  private kernelScript: string;
  private doc: vscode.NotebookDocument;
  private cwd: string;
  private process: ChildProcess;
  private port: number;
  private socket: net.Socket;

  constructor(kernelScript: string, doc: vscode.NotebookDocument) {
    this.kernelScript = kernelScript;
    this.cwd = dirname(doc.uri.fsPath);
    this.doc = doc;
  }

  private request(request: RKernelRequest) {
    if (this.socket) {
      const json = JSON.stringify(request);
      this.socket.write(`Content-Length: ${json.length}\n${json}`);
    }
  }

  public async start() {
    if (this.process) {
      return;
    }

    const env = Object.create(process.env);
    env.LANG = 'en_US.UTF-8';

    return new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        console.log('socket connected');
        this.socket = socket;
        resolve(undefined);

        socket.on('end', () => {
          console.log('socket disconnected');
          this.socket = undefined;
          reject(undefined);
        });
        server.close();
      });

      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as net.AddressInfo).port;
        // FIXME: grab R path from settings
        const childProcess = spawn('R', ['--quiet', '--slave', '-f', this.kernelScript, '--args', `port=${this.port}`],
          { cwd: this.cwd, env: env });
        childProcess.stderr.on('data', (chunk: Buffer) => {
          const str = chunk.toString();
          console.log(`R stderr (${childProcess.pid}): ${str}`);
        });
        childProcess.stdout.on('data', (chunk: Buffer) => {
          const str = chunk.toString();
          console.log(`R stdout (${childProcess.pid}): ${str}`);
        });
        childProcess.on('exit', (code, signal) => {
          console.log(`R exited with code ${code}`);
          reject(undefined);
        });
        this.process = childProcess;
        return childProcess;
      });
    });
  }

  public stop() {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
      this.socket = undefined;
    }
  }

  public async restart() {
    this.stop();
    await this.start();
  }

  public async eval(cell: vscode.NotebookCell): Promise<RKernelResponse> {
    if (this.socket) {
      return new Promise((resolve, reject) => {
        const handler = async (data: Buffer) => {
          const response: RKernelResponse = JSON.parse(data.toString());
          resolve(response);
          this.socket.removeListener('data', handler);
        };

        this.socket.on('data', handler);

        this.request({
          id: cell.metadata.executionOrder,
          type: 'eval',
          expr: cell.document.getText(),
        });
      });
    }
  }

  public cancel(cell: vscode.NotebookCell) {
    if (this.socket) {
      this.request({
        id: cell ? cell.metadata.executionOrder : 0,
        type: 'cancel',
      });
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

  public async eval(cell: vscode.NotebookCell): Promise<RKernelResponse> {
    await this.kernel.start();
    return this.kernel.eval(cell);
  }

  public async cancel(cell: vscode.NotebookCell): Promise<void> {
    return this.kernel.cancel(cell);
  }
}

export class RNotebookProvider implements vscode.NotebookContentProvider, vscode.NotebookKernel {
  public label = 'R Kernel';
  private kernelScript: string;
  private disposables: vscode.Disposable[] = [];
  private readonly notebooks = new Map<string, RNotebook>();

  private runIndex: number = 0;

  constructor(kernelScript: string) {
    this.kernelScript = kernelScript;
    this.disposables.push(
      vscode.notebook.registerNotebookKernelProvider({
        viewType: 'r-notebook'
      }, {
        provideKernels: () => {
          return [this];
        }
      }),
      vscode.notebook.onDidOpenNotebookDocument(document => {
        const docKey = document.uri.toString();
        if (!this.notebooks.has(docKey)) {
          const notebook = new RNotebook(this.kernelScript, document);
          notebook.restartKernel();
          this.notebooks.set(docKey, notebook);
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

  lookupNotebook(uri: vscode.Uri): RNotebook {
    return this.notebooks.get(uri.toString())
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
          if (line > cellStartLine) {
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
          cellType = 'r';
          cellStartLine = line;
        } else if (line === lines.length - 1) {
          if (line > cellStartLine) {
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
        }
      } else if (cellType === 'yaml') {
        if (lines[line].startsWith('---')) {
          cells.push({
            cellKind: vscode.CellKind.Code,
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
              custom: {
                header: lines[cellStartLine],
                footer: lines[line],
              }
            },
          });
          cellType = 'markdown';
          cellStartLine = line + 1;
        }
      }
      line++;
    }

    return {
      languages: ['r'],
      metadata: {},
      cells: cells,
    };
  }

  async save(document: vscode.NotebookDocument, targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    let content = '';
    for (const cell of document.cells) {
      if (cancellation.isCancellationRequested) {
        return;
      }
      if (cell.cellKind === vscode.CellKind.Markdown) {
        content += cell.document.getText() + '\n';
      } else if (cell.cellKind === vscode.CellKind.Code) {
        if (cell.language === 'r') {
          if (cell.metadata.custom === undefined) {
            cell.metadata.custom = {
              header: '```{r}',
              footer: '```'
            };
          }
          content += cell.metadata.custom.header + '\n' + cell.document.getText() + '\n' + cell.metadata.custom.footer + '\n';
        } else if (cell.language === 'yaml') {
          content += cell.document.getText() + '\n\n';
        } else {
          content += '```{' + cell.language + '}\n' + cell.document.getText() + '\n```\n';
        }
      }
    }
    await vscode.workspace.fs.writeFile(targetResource, Buffer.from(content));
  }

  async renderPlotOutput(response) {
    const content = (await vscode.workspace.fs.readFile(vscode.Uri.parse(response.result))).toString();

    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'image/svg+xml': content,
      },
    };
  }

  async renderTextOutput(response) {
    // Text may contain html, so render as such.
    const isXml = response.result.match(/^<.+>$/gms) != null

    if (isXml) {
      return {
        outputKind: vscode.CellOutputKind.Rich,
        data: {
          'text/html': response.result
        }
      }
    } else {
      return {
        outputKind: vscode.CellOutputKind.Text,
        text: response.result,
      }
    }
  }

  async renderHtmlOutput(response) {
  	const html = (await vscode.workspace.fs.readFile(vscode.Uri.parse(response.result))).toString();
    const htmlDir = dirname(response.result)
    const htmlInline = await inlineAll(html, htmlDir)
    const htmlWrapped = `
    <iframe id="plotly" frameborder="0" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>
    <script>
    var iframe = document.getElementById("plotly")
    iframe.srcdoc = unescape("${escape(htmlInline)}")
    </script>
    `
    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'text/html': htmlWrapped
      },
    }
  }

  async renderTableOutput(response) {
    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'ms-vscode.r-notebook/table': response.result.data,
        'text/markdown': response.result.markdown,
        'application/json': response.result.data,
      },
    }
  }

  async renderOutput(cell, response) {

    switch (response.type) {
      case 'text': {
        cell.outputs = [await this.renderTextOutput(response)];
        break;
      }
      case 'plot': {
        cell.outputs = [await this.renderPlotOutput(response)]
        break;
      }
      case 'viewer': {
        cell.outputs = [await this.renderHtmlOutput(response)];
        break;
      }
      case 'browser': {
        cell.outputs = [{
          outputKind: vscode.CellOutputKind.Rich,
          data: {
            'text/plain': response.result,
          },
        }];
        break;
      }
      case 'table': {
        cell.outputs = [await this.renderTableOutput(response)];
        break;
      }
      case 'error': {
        cell.metadata.runState = vscode.NotebookCellRunState.Error;
        cell.outputs = [{
          outputKind: vscode.CellOutputKind.Error,
          evalue: response.result,
          ename: 'Error',
          traceback: [],
        }];
        break;
      }
    }
  }

  onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentEditEvent>().event;

  async resolveNotebook(): Promise<void> { }

  async saveNotebook(document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await this.save(document, document.uri, cancellation);
  }

  async saveNotebookAs(targetResource: vscode.Uri, document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await this.save(document, targetResource, cancellation);
  }

  async backupNotebook(document: vscode.NotebookDocument, context: vscode.NotebookDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.NotebookDocumentBackup> {
    await this.save(document, context.destination, cancellation);
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination)
    };
  }

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

    if (notebook && cell.metadata.runState !== vscode.NotebookCellRunState.Running) {
      try {
        cell.metadata.runState = vscode.NotebookCellRunState.Running;
        const start = +new Date();
        cell.metadata.runStartTime = start;
        cell.metadata.executionOrder = ++this.runIndex;
        const response = await notebook.eval(cell);
        cell.metadata.runState = vscode.NotebookCellRunState.Success;
        cell.metadata.lastRunDuration = +new Date() - cell.metadata.runStartTime;

        console.log(`uri: ${cell.uri}, id: ${response.id}, type: ${response.type}, result: ${response.result}`);

        await this.renderOutput(cell, response)
      } catch (e) {
        cell.outputs = [{
          outputKind: vscode.CellOutputKind.Error,
          evalue: e.toString(),
          ename: '',
          traceback: [],
        }];
        cell.metadata.runState = vscode.NotebookCellRunState.Error;
        cell.metadata.lastRunDuration = undefined;
      }
    }
  }

  async executeAllCells(document: vscode.NotebookDocument): Promise<void> {
    for (const cell of document.cells) {
      await this.executeCell(document, cell);
    }
  }

  async cancelCellExecution(document: vscode.NotebookDocument, cell: vscode.NotebookCell) {
    if (cell.metadata.runState === vscode.NotebookCellRunState.Running) {
      const notebook = this.notebooks.get(document.uri.toString());
      await notebook.cancel(cell);
    }
  }

  async cancelAllCellsExecution(document: vscode.NotebookDocument) {
    const notebook = this.notebooks.get(document.uri.toString());
    await notebook.cancel(undefined);
  }

  public dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
