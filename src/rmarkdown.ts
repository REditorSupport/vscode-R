import {
  CancellationToken, CodeLens, CodeLensProvider,
  CompletionItem, CompletionItemProvider,
  Event, EventEmitter, Position, Range, TextDocument, TextEditorDecorationType, window
} from 'vscode';
import { runChunksInTerm } from './rTerminal';

function isChunkStartLine(text: string) {
  if (text.match(/^\s*```+\s*\{\w+\s*.*$/g)) {
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

function getChunkLanguage(text: string) {
  return text.replace(/^\s*```+\s*\{(\w+)\s*.*\}\s*$/g, '$1').toLowerCase();
}

function getChunkOptions(text: string) {
  return text.replace(/^\s*```+\s*\{\w+\s*,?\s*(.*)\s*\}\s*$/g, '$1');
}

function getChunkEval(chunkOptions: string) {
  if (chunkOptions.match(/eval\s*=\s*(F|FALSE)/g)) {
    return false;
  }
  return true;
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
    let chunkLanguage: string = undefined;
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
          chunkLanguage = getChunkLanguage(lines[line]);
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
          if (chunkLanguage === 'r') {
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
                codeRanges.slice()
              ]
            }));
            if (getChunkEval(chunkOptions)) {
              codeRanges.push(codeRange);
            }
          }
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
  let chunkLanguage: string = undefined;

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (line > selection.end.line) {
        break;
      }
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (line >= selection.end.line) {
          if (chunkLanguage === 'r') {
            const codeRange = new Range(
              new Position(chunkStartLine + 1, 0),
              new Position(line - 1, lines[line - 1].length)
            );

            return runChunksInTerm([codeRange]);
          }
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
}

export async function runAboveChunks() {
  const selection = window.activeTextEditor.selection;
  const currentDocument = window.activeTextEditor.document;
  const lines = currentDocument.getText().split(/\r?\n/);
  const codeRanges: Range[] = [];

  let line = 0;
  let chunkStartLine: number = undefined;
  let chunkLanguage: string = undefined;
  let chunkOptions: string = undefined;

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (line > selection.end.line) {
        break;
      }
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
        chunkOptions = getChunkOptions(lines[line]);
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (line >= selection.end.line) {
          return runChunksInTerm(codeRanges);
        }

        if (chunkLanguage === 'r') {
          if (getChunkEval(chunkOptions)) {
            const codeRange = new Range(
              new Position(chunkStartLine + 1, 0),
              new Position(line - 1, lines[line - 1].length)
            );

            codeRanges.push(codeRange);
          }
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
}

export async function runFromCurrentToBelowChunks() {
  const selection = window.activeTextEditor.selection;
  const currentDocument = window.activeTextEditor.document;
  const lines = currentDocument.getText().split(/\r?\n/);
  const codeRanges: Range[] = [];

  let chunkStartLine: number = undefined;
  let chunkLanguage: string = undefined;
  let chunkOptions: string = undefined;

  // Find 'chunk start line' of the 'current' chunk, covering cases for within and outside of chunk. When the cursor is outside the chunk, the 'current' chunk is next chunk below the cursor.

  let line = selection.start.line;
  let chunkStartLineAtOrAbove = line;
  // `- 1` to cover edge case when cursor is at 'chunk end line'
  let chunkEndLineAbove = line - 1;

  while (chunkStartLineAtOrAbove >= 0 && !isChunkStartLine(lines[chunkStartLineAtOrAbove])) {
    chunkStartLineAtOrAbove--;
  }

  while (chunkEndLineAbove >= 0 && !isChunkEndLine(lines[chunkEndLineAbove])) {
    chunkEndLineAbove--;
  }

  // Case: Cursor is within chunk
  if (chunkEndLineAbove < chunkStartLineAtOrAbove) {
    line = chunkStartLineAtOrAbove;
  } else {
  // Cases: Cursor is above the first chunk, at the first chunk or outside of chunk. Find the 'chunk start line' of the next chunk below the cursor.
    let chunkStartLineBelow = line;
    while (!isChunkStartLine(lines[chunkStartLineBelow])) {
      chunkStartLineBelow++;
    }
    line = chunkStartLineBelow;
  }

  // Start finding and run codes from the current to all the chunks below

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
        chunkOptions = getChunkOptions(lines[line]);
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (chunkLanguage === 'r') {
          if (getChunkEval(chunkOptions)) {
            const codeRange = new Range(
              new Position(chunkStartLine + 1, 0),
              new Position(line - 1, lines[line - 1].length)
            );

            codeRanges.push(codeRange);
          }
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
  runChunksInTerm(codeRanges);
}

export async function runBelowChunks() {
  const selection = window.activeTextEditor.selection;
  const currentDocument = window.activeTextEditor.document;
  const lines = currentDocument.getText().split(/\r?\n/);
  const codeRanges: Range[] = [];

  let chunkStartLine: number = undefined;
  let chunkLanguage: string = undefined;
  let chunkOptions: string = undefined;

  // Find 'chunk start line' from next chunk onwards (excluding the chunk where the cursor is positioned), covering cases for within and outside of chunk.

  let line = selection.start.line;
  let chunkStartLineBelow = line + 1 ;

  while (!isChunkStartLine(lines[chunkStartLineBelow])) {
    chunkStartLineBelow++;
  }

  line = chunkStartLineBelow;

  // Start finding and run codes from the one chunk below to all the chunks below it

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
        chunkOptions = getChunkOptions(lines[line]);
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (chunkLanguage === 'r') {
          if (getChunkEval(chunkOptions)) {
            const codeRange = new Range(
              new Position(chunkStartLine + 1, 0),
              new Position(line - 1, lines[line - 1].length)
            );

            codeRanges.push(codeRange);
          }
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
  runChunksInTerm(codeRanges);
}


export async function runAllChunks() {
  const currentDocument = window.activeTextEditor.document;
  const lines = currentDocument.getText().split(/\r?\n/);
  const codeRanges: Range[] = [];

  let line = 0;
  let chunkStartLine: number = undefined;
  let chunkLanguage: string = undefined;
  let chunkOptions: string = undefined;

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (isChunkStartLine(lines[line])) {
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
        chunkOptions = getChunkOptions(lines[line]);
      }
    } else {
      if (isChunkEndLine(lines[line])) {
        if (chunkLanguage === 'r') {
          if (getChunkEval(chunkOptions)) {
            const codeRange = new Range(
              new Position(chunkStartLine + 1, 0),
              new Position(line - 1, lines[line - 1].length)
            );

            codeRanges.push(codeRange);
          }
        }

        chunkStartLine = undefined;
      }
    }
    line++;
  }
  runChunksInTerm(codeRanges);
}
export class RMarkdownCompletionItemProvider implements CompletionItemProvider {

  // obtained from R code
  // paste0("[", paste0(paste0("'", names(knitr:: opts_chunk$merge(NULL)), "'"), collapse = ", "), "]")
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
    const line = document.lineAt(position).text;
    if (isChunkStartLine(line) && getChunkLanguage(line) === 'r') {
      return this.chunkOptionCompletionItems;
    }

    return undefined;
  }
}
