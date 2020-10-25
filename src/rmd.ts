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
    const codeRanges: vscode.Range[] = [];

    while (line < lines.length) {
      if (chunkHeaderLine === undefined) {
        if (lines[line].startsWith('```{r')) {
          chunkHeaderLine = line;
        }
      } else {
        if (lines[line].startsWith('```')) {
          const chunkRange = new vscode.Range(
            new vscode.Position(chunkHeaderLine, 0),
            new vscode.Position(line, lines[line].length)
          );
          const codeRange = new vscode.Range(
            new vscode.Position(chunkHeaderLine + 1, 0),
            new vscode.Position(line - 1, lines[line-1].length)
          );
          codeRanges.push(codeRange);
          this.codeLenses.push(new vscode.CodeLens(chunkRange, {
            title: 'Run Chunk',
            tooltip: 'Run current chunk',
            command: 'r.runChunks',
            arguments: [
              [
                codeRange
              ]
            ]
          }), new vscode.CodeLens(chunkRange, {
            title: 'Run Above',
            tooltip: 'Run all chunks above',
            command: 'r.runChunks',
            arguments: [
              codeRanges.slice(0, codeRanges.length - 1)
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
