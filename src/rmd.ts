import * as vscode from 'vscode';

export class RMarkdownCodeLensProvider implements vscode.CodeLensProvider {
  private codeLenses: vscode.CodeLens[] = [];
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor() {
  }

  public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    this.codeLenses = [];
    const lines = document.getText().split(/\r?\n/);
    let line = 0;
    let chunkHeaderLine = undefined;
    while (line < lines.length) {
      if (chunkHeaderLine === undefined) {
        if (lines[line].startsWith('```{r')) {
          chunkHeaderLine = line;
        }
      } else {
        if (lines[line].startsWith('```')) {
          const range = new vscode.Range(new vscode.Position(chunkHeaderLine, 0), new vscode.Position(line, lines[line].length));
          this.codeLenses.push(new vscode.CodeLens(range, {
            title: 'Run Chunk',
            tooltip: '',
            command: 'r.rmdRunChunk',
            arguments: [
              {
                type: 'RunChunk',
                chunkStart: chunkHeaderLine + 1,
                chunkEnd: line - 1,
              }
            ]
          }), new vscode.CodeLens(range, {
            title: 'Run Above',
            tooltip: '',
            command: 'r.rmdRunAbove',
            arguments: [
              {
                type: 'RunAbove',
                chunkStart: chunkHeaderLine + 1,
                chunkEnd: line - 1,
              }
            ]
          }));
          chunkHeaderLine = undefined;
        }
      }
      line++;
    }
    return this.codeLenses;
  }

  public resolveCodeLens(codeLens: vscode.CodeLens, token: vscode.CancellationToken) {
    return codeLens;
  }
}
