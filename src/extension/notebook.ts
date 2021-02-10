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

interface RKernelResult {
  text?: string,
  plot?: string,
  url?: string,
  file?: string,
  error?: string,
  data?: any,
  markdown?: string
}

interface RKernelResponse {
  id: number;
  type: 'text' | 'plot' | 'viewer' | 'browser' | 'error' | 'table';
  result: RKernelResult
}

interface OutputCacheCells {
  [cellIndex: string]: OutputCacheCell
}

interface OutputCacheCell {
  outputs: vscode.CellOutput[];
  metadata: vscode.NotebookCellMetadata;
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

class RNotebookCellEdit {
  private uri: vscode.Uri;
  private cellIndex: number;

  constructor(uri: vscode.Uri, cellIndex: number) {
    this.uri = uri;
    this.cellIndex = cellIndex
  }

  apply(outputs?: (vscode.NotebookCellOutput | vscode.CellOutput)[], metadata?: vscode.NotebookCellMetadata, outputAppend: boolean = false) {
    const edit = new vscode.WorkspaceEdit();

    if (outputs) {
      if (outputAppend) {
        edit.appendNotebookCellOutput(this.uri, this.cellIndex, outputs)
      } else {
        edit.replaceNotebookCellOutput(this.uri, this.cellIndex, outputs)
      }
    }

    if (metadata) {
      edit.replaceNotebookCellMetadata(this.uri, this.cellIndex, metadata)
    }

    vscode.workspace.applyEdit(edit)
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

    const outputUri = vscode.Uri.parse(uri.toString() + ".json")
    let outputContent: OutputCacheCells = {}
    try {
        outputContent = JSON.parse((await vscode.workspace.fs.readFile(outputUri)).toString())
    } catch {}

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
          const cacheCell = outputContent[cells.length]
          cells.push({
            cellKind: vscode.CellKind.Code,
            source: lines.slice(cellStartLine + 1, line).join('\n'),
            language: 'r',
            outputs: cacheCell?.outputs || [],
            metadata: {
              ...cacheCell?.metadata || {},
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
    let outputContent = {}

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

        // save output as-is
        outputContent[cell.index] = {
          outputs: cell.outputs,
          metadata: cell.metadata
        }
      }
    }
    await vscode.workspace.fs.writeFile(targetResource, Buffer.from(content));
    await vscode.workspace.fs.writeFile(vscode.Uri.parse(targetResource.toString() + ".json"), Buffer.from(JSON.stringify(outputContent)));
  }
  async renderPlotOutput(response: RKernelResponse): Promise<vscode.CellDisplayOutput> {
    const content = (await vscode.workspace.fs.readFile(vscode.Uri.parse(response.result.plot))).toString();

    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'image/svg+xml': content,
      },
    };
  }

  async renderTextOutput(response: RKernelResponse): Promise<vscode.CellDisplayOutput> {
    // Text may contain html, so render as such.
    const isXml = response.result.text.match(/^<.+>$/gms) != null

    if (isXml) {
      return {
        outputKind: vscode.CellOutputKind.Rich,
        data: {
          'text/html': response.result.text
        }
      }
    } else {
      return {
        outputKind: vscode.CellOutputKind.Rich,
        data: {
          'text/plain': response.result.text
        }
      }
    }
  }

  async renderHtmlOutput(response: RKernelResponse): Promise<vscode.CellDisplayOutput> {
    const html = (await vscode.workspace.fs.readFile(vscode.Uri.parse(response.result.file))).toString();
    const htmlDir = dirname(response.result.file)
    const htmlInline = await inlineAll(html, htmlDir)

    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'ms-vscode.r-notebook/viewer': htmlInline
      },
    }
  }

  async renderTableOutput(response: RKernelResponse): Promise<vscode.CellDisplayOutput> {
    return {
      outputKind: vscode.CellOutputKind.Rich,
      data: {
        'ms-vscode.r-notebook/table': response.result.data
        // TODO: make the html table default, no clue how to do this.
        // 'text/markdown': response.result.markdown,
        // 'application/json': response.result.data,
      },
    }
  }

  async renderOutput(response: RKernelResponse): Promise<vscode.CellOutput[]> {

    switch (response.type) {
      case 'text': {
        return [await this.renderTextOutput(response)];
      }
      case 'plot': {
        return [await this.renderPlotOutput(response)]
      }
      case 'viewer': {
        return [await this.renderHtmlOutput(response)];
      }
      case 'browser': {
        return [{
          outputKind: vscode.CellOutputKind.Rich,
          data: {
            'text/plain': response.result,
          },
        }];
      }
      case 'table': {
        return [await this.renderTableOutput(response)];
      }
      case 'error': {
        return [{
          outputKind: vscode.CellOutputKind.Error,
          evalue: response.result.error,
          ename: 'Error',
          traceback: [],
        }];
      }
    }
  }

  async resolveNotebook(): Promise<void> {  }

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

    const cellEdit = new RNotebookCellEdit(document.uri, cell.index)

    if (notebook && cell.metadata.runState !== vscode.NotebookCellRunState.Running) {
      try {
        const startTime = +new Date()

        cellEdit.apply(undefined, {
          runState: vscode.NotebookCellRunState.Running,
          runStartTime: startTime,
          executionOrder: ++this.runIndex,
        })

        const response = await notebook.eval(cell);

        console.log(`uri: ${cell.uri}, id: ${response.id}, type: ${response.type}, result: ${response.result}`);

        const outputs = await this.renderOutput(response)

        const runState = (outputs[0].outputKind === vscode.CellOutputKind.Error) ? vscode.NotebookCellRunState.Error : vscode.NotebookCellRunState.Success

        cellEdit.apply(outputs, {
          runStartTime: +new Date(),
          executionOrder: ++this.runIndex,
          runState,
          lastRunDuration: +new Date() - startTime,
        })


      } catch (e) {
        cellEdit.apply([{
          outputKind: vscode.CellOutputKind.Error,
          evalue: e.toString(),
          ename: '',
          traceback: [],
        }], {
          runState: vscode.NotebookCellRunState.Error,
          lastRunDuration: undefined
        })
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
