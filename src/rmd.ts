import {
  CancellationToken, CodeLens, CodeLensProvider,
  Event, EventEmitter, Position, Range, TextDocument, TextEditorDecorationType, window
} from 'vscode';

export class RMarkdownCodeLensProvider implements CodeLensProvider {
  private codeLenses: CodeLens[] = [];
  private _onDidChangeCodeLenses: EventEmitter<void> = new EventEmitter<void>();
  private readonly decoration: TextEditorDecorationType;
  public readonly onDidChangeCodeLenses: Event<void> = this._onDidChangeCodeLenses.event;

  constructor() {
    this.decoration = window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(128, 128, 128, 0.1)',
    });
  }

  public provideCodeLenses(document: TextDocument, token: CancellationToken): CodeLens[] | Thenable<CodeLens[]> {
    this.codeLenses = [];
    const lines = document.getText().split(/\r?\n/);
    let line = 0;
    let chunkHeaderLine = undefined;
    let chunkOptions: string = undefined;
    const chunkRanges: Range[] = [];
    const codeRanges: Range[] = [];

    while (line < lines.length) {
      if (token.isCancellationRequested) {
        break;
      }
      if (chunkHeaderLine === undefined) {
        if (lines[line].match(/^\s*```+\s*\{[Rr]\s*.*$/g)) {
          chunkHeaderLine = line;
          chunkOptions = lines[line].replace(/^\s*```+\s*\{[Rr]\s*,?\s*(.*)\s*\}\s*$/g, '$1');
        }
      } else {
        if (lines[line].match(/^\s*```+\s*$/g)) {
          const chunkRange = new Range(
            new Position(chunkHeaderLine, 0),
            new Position(line, lines[line].length)
          );
          const codeRange = new Range(
            new Position(chunkHeaderLine + 1, 0),
            new Position(line - 1, lines[line - 1].length)
          );
          chunkRanges.push(chunkRange);
          if (!chunkOptions.match(/eval\s*=\s*(F|FALSE)/g)) {
            codeRanges.push(codeRange);
          }
          this.codeLenses.push(new CodeLens(chunkRange, {
            title: 'Run Chunk',
            tooltip: 'Run current chunk',
            command: 'r.runChunks',
            arguments: [
              [
                codeRange
              ]
            ]
          }), new CodeLens(chunkRange, {
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

    for (const editor of window.visibleTextEditors) {
      if (editor.document.uri.toString() === document.uri.toString()) {
        editor.setDecorations(this.decoration, chunkRanges);
      }
    }

    return this.codeLenses;
  }

  public resolveCodeLens(codeLens: CodeLens, token: CancellationToken) {
    return codeLens;
  }
}
