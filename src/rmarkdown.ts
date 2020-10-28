import {
  CancellationToken, CodeLens, CodeLensProvider,
  CompletionItem, CompletionItemProvider,
  Event, EventEmitter, Position, Range, TextDocument, TextEditorDecorationType, window
} from 'vscode';
import { runChunksInTerm } from './rTerminal';

function isChunkStartLine(text: string) {
  if (text.match(/^\s*```+\s*\{[Rr]\s*.*$/g)) {
    return true;
  }
  return false;
}

function isChunkEndLine(text: string) {
  if (text.match(/^\s*```+\s*$/g)) {
    return true;
  }
  return false;
}

function getChunkOptions(text: string) {
  return text.replace(/^\s*```+\s*\{[Rr]\s*,?\s*(.*)\s*\}\s*$/g, '$1');
}

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
    let chunkStartLine: number = undefined;
    let chunkOptions: string = undefined;
    const chunkRanges: Range[] = [];
    const codeRanges: Range[] = [];

    while (line < lines.length) {
      if (token.isCancellationRequested) {
        break;
      }
      if (chunkStartLine === undefined) {
        if (isChunkStartLine(lines[line])) {
          chunkStartLine = line;
          chunkOptions = getChunkOptions(lines[line]);
        }
      } else {
        if (isChunkEndLine(lines[line])) {
          const chunkRange = new Range(
            new Position(chunkStartLine, 0),
            new Position(line, lines[line].length)
          );
          const codeRange = new Range(
            new Position(chunkStartLine + 1, 0),
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
          chunkStartLine = undefined;
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

export async function runCurrentChunk() {
  const selection = window.activeTextEditor.selection;
  const currentDocument = window.activeTextEditor.document;
  const lines = currentDocument.getText().split(/\r?\n/);

  let line = 0;
  let chunkStartLine: number = undefined;

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (line > selection.end.line) {
        break;
      }
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (line >= selection.end.line) {
          const codeRange = new Range(
            new Position(chunkStartLine + 1, 0),
            new Position(line - 1, lines[line - 1].length)
          );

          return runChunksInTerm([codeRange]);
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
}

export class RMarkdownCompletionItemProvider implements CompletionItemProvider {

  // obtained from jsonlite::toJSON(names(knitr::opts_chunk$merge(NULL)))
  public readonly chunkOptions = ['eval', 'echo', 'results', 'tidy', 'tidy.opts', 'collapse',
    'prompt', 'comment', 'highlight', 'strip.white', 'size', 'background',
    'cache', 'cache.path', 'cache.vars', 'cache.lazy', 'dependson',
    'autodep', 'cache.rebuild', 'fig.keep', 'fig.show', 'fig.align',
    'fig.path', 'dev', 'dev.args', 'dpi', 'fig.ext', 'fig.width',
    'fig.height', 'fig.env', 'fig.cap', 'fig.scap', 'fig.lp', 'fig.subcap',
    'fig.pos', 'out.width', 'out.height', 'out.extra', 'fig.retina',
    'external', 'sanitize', 'interval', 'aniopts', 'warning', 'error',
    'message', 'render', 'ref.label', 'child', 'engine', 'split',
    'include', 'purl'];
  public readonly chunkOptionCompletionItems: CompletionItem[];

  constructor() {
    this.chunkOptionCompletionItems = this.chunkOptions.map((x: string) => {
      const item = new CompletionItem(`${x}`);
      item.insertText = `${x}=`;
      return item;
    });
  }

  public provideCompletionItems(document: TextDocument, position: Position) {
    if (isChunkStartLine(document.lineAt(position).text)) {
      return this.chunkOptionCompletionItems;
    }

    return undefined;
  }
}
