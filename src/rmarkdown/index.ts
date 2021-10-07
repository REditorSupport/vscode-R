import * as vscode from 'vscode';
import { runChunksInTerm } from '../rTerminal';
import { config } from '../util';

// reexports
export { knitDir, RMarkdownKnitManager } from './knit';
export { RMarkdownPreviewManager } from './preview';

function isRDocument(document: vscode.TextDocument) {
  return (document.languageId === 'r');
}

function isRChunkLine(text: string) {
  return (!!text.match(/^#+\s*%%/g));
}

function isChunkStartLine(text: string, isRDoc: boolean) {
  if (isRDoc) {
    return (isRChunkLine(text));
  } else {
    return (!!text.match(/^\s*```+\s*\{\w+\s*.*$/g));
  }
}

function isChunkEndLine(text: string, isRDoc: boolean) {
  if (isRDoc) {
    return (isRChunkLine(text));
  } else {
    return (!!text.match(/^\s*```+\s*$/g));
  }
}

function getChunkLanguage(text: string) {
  return text.replace(/^\s*```+\s*\{(\w+)\s*.*\}\s*$/g, '$1').toLowerCase();
}

function getChunkOptions(text: string) {
  return text.replace(/^\s*```+\s*\{\w+\s*,?\s*(.*)\s*\}\s*$/g, '$1');
}

function getChunkEval(chunkOptions: string) {
  return (!chunkOptions.match(/eval\s*=\s*(F|FALSE)/g));
}

export class RMarkdownCodeLensProvider implements vscode.CodeLensProvider {
  private codeLenses: vscode.CodeLens[] = [];
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  private readonly decoration: vscode.TextEditorDecorationType;
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor() {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: config().get('rmarkdown.chunkBackgroundColor'),
    });
  }

  public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    this.codeLenses = [];
    const chunks = getChunks(document);
    const chunkRanges: vscode.Range[] = [];
    const rmdCodeLensCommands: string[] = config().get('rmarkdown.codeLensCommands');

    // Iterate through all code chunks for getting chunk information for both CodeLens and chunk background color (set by `editor.setDecorations`)
    for (let i = 1; i <= chunks.length; i++) {
      const chunk = chunks.find(e => e.id === i);
      const chunkRange = chunk.chunkRange;
      const line = chunk.startLine;
      chunkRanges.push(chunkRange);

      // Enable/disable only CodeLens, without affecting chunk background color.
      if (config().get<boolean>('rmarkdown.enableCodeLens') && (chunk.language === 'r') || isRDocument(document)) {
        if (token.isCancellationRequested) {
          break;
        }
        this.codeLenses.push(
          new vscode.CodeLens(chunkRange, {
            title: 'Run Chunk',
            tooltip: 'Run current chunk',
            command: 'r.runCurrentChunk',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run Above',
            tooltip: 'Run all chunks above',
            command: 'r.runAboveChunks',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run Current & Below',
            tooltip: 'Run current and all chunks below',
            command: 'r.runCurrentAndBelowChunks',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run Below',
            tooltip: 'Run all chunks below',
            command: 'r.runBelowChunks',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run Previous',
            tooltip: 'Run previous chunk',
            command: 'r.runPreviousChunk',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run Next',
            tooltip: 'Run next chunk',
            command: 'r.runNextChunk',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Run All',
            tooltip: 'Run all chunks',
            command: 'r.runAllChunks',
            arguments: [chunks]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Go Previous',
            tooltip: 'Go to previous chunk',
            command: 'r.goToPreviousChunk',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Go Next',
            tooltip: 'Go to next chunk',
            command: 'r.goToNextChunk',
            arguments: [chunks, line]
          }),
          new vscode.CodeLens(chunkRange, {
            title: 'Select Chunk',
            tooltip: 'Select current chunk',
            command: 'r.selectCurrentChunk',
            arguments: [chunks, line]
          }),
        );
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === document.uri.toString()) {
        editor.setDecorations(this.decoration, chunkRanges);
      }
    }

    // For default options, both options and sort order are based on options specified in package.json.
    // For user-specified options, both options and sort order are based on options specified in settings UI or settings.json.
    return this.codeLenses.
      filter(e => rmdCodeLensCommands.includes(e.command.command)).
      sort(function (a, b) {
        const sorted = rmdCodeLensCommands.indexOf(a.command.command) -
          rmdCodeLensCommands.indexOf(b.command.command);
        return sorted;
      });
  }
  public resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
    return codeLens;
  }
}

interface RMarkdownChunk {
  id: number;
  startLine: number;
  endLine: number;
  language: string;
  options: string;
  eval: boolean;
  chunkRange: vscode.Range;
  codeRange: vscode.Range;
}

// Scan document and return chunk info (e.g. ID, chunk range) from all chunks
export function getChunks(document: vscode.TextDocument): RMarkdownChunk[] {
  const lines = document.getText().split(/\r?\n/);
  const chunks: RMarkdownChunk[] = [];

  let line = 0;
  let chunkId = 0;  // One-based index
  let chunkStartLine: number = undefined;
  let chunkEndLine: number = undefined;
  let chunkLanguage: string = undefined;
  let chunkOptions: string = undefined;
  let chunkEval: boolean = undefined;
  const isRDoc = isRDocument(document);

  while (line < lines.length) {
    if (chunkStartLine === undefined) {
      if (isChunkStartLine(lines[line], isRDoc)) {
        chunkId++;
        chunkStartLine = line;
        chunkLanguage = getChunkLanguage(lines[line]);
        chunkOptions = getChunkOptions(lines[line]);
        chunkEval = getChunkEval(chunkOptions);
      }
    } else {
      if (isChunkEndLine(lines[line], isRDoc)) {
        chunkEndLine = line;

        const chunkRange = new vscode.Range(
          new vscode.Position(chunkStartLine, 0),
          new vscode.Position(line, lines[line].length)
        );
        const codeRange = new vscode.Range(
          new vscode.Position(chunkStartLine + 1, 0),
          new vscode.Position(line - 1, lines[line - 1].length)
        );

        chunks.push({
          id: chunkId, // One-based index
          startLine: chunkStartLine,
          endLine: chunkEndLine,
          language: chunkLanguage,
          options: chunkOptions,
          eval: chunkEval,
          chunkRange: chunkRange,
          codeRange: codeRange
        });

        chunkStartLine = undefined;
      }
    }
    line++;
  }
  return chunks;
}

function getCurrentChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk {
  const lines = vscode.window.activeTextEditor.document.getText().split(/\r?\n/);

  let chunkStartLineAtOrAbove = line;
  // `- 1` to cover edge case when cursor is at 'chunk end line'
  let chunkEndLineAbove = line - 1;

  const isRDoc = isRDocument(vscode.window.activeTextEditor.document);

  while (chunkStartLineAtOrAbove >= 0 && !isChunkStartLine(lines[chunkStartLineAtOrAbove], isRDoc)) {
    chunkStartLineAtOrAbove--;
  }

  while (chunkEndLineAbove >= 0 && !isChunkEndLine(lines[chunkEndLineAbove], isRDoc)) {
    chunkEndLineAbove--;
  }

  // Case: Cursor is within chunk
  if (chunkEndLineAbove < chunkStartLineAtOrAbove) {
    line = chunkStartLineAtOrAbove;
  } else {
    // Cases: Cursor is above the first chunk, at the first chunk or outside of chunk. Find the 'chunk start line' of the next chunk below the cursor.
    let chunkStartLineBelow = line + 1;
    while (!isChunkStartLine(lines[chunkStartLineBelow], isRDoc)) {
      chunkStartLineBelow++;
    }
    line = chunkStartLineBelow;
  }
  const currentChunk = chunks.find(i => i.startLine <= line && i.endLine >= line);
  return currentChunk;
}

// Alternative `getCurrentChunk` for cases:
// - commands (e.g. `selectCurrentChunk`) only make sense when cursor is within chunk
// - when cursor is outside of chunk, no response is triggered for chunk navigation commands (e.g. `goToPreviousChunk`) and chunk running commands (e.g. `runAboveChunks`)
function getCurrentChunk__CursorWithinChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk {
  return chunks.find(i => i.startLine <= line && i.endLine >= line);
}

function getPreviousChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk {
  const currentChunk = getCurrentChunk(chunks, line);
  if (currentChunk.id !== 1) {
    // When cursor is below the last 'chunk end line', the definition of the previous chunk is the last chunk
    const previousChunkId = currentChunk.endLine < line ? currentChunk.id : currentChunk.id - 1;
    const previousChunk = chunks.find(i => i.id === previousChunkId);
    return previousChunk;
  } else {
    return (currentChunk);
  }
}

function getNextChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk {
  const currentChunk = getCurrentChunk(chunks, line);
  if (currentChunk.id !== chunks.length) {
    // When cursor is above the first 'chunk start line', the definition of the next chunk is the first chunk
    const nextChunkId = line < currentChunk.startLine ? currentChunk.id : currentChunk.id + 1;
    const nextChunk = chunks.find(i => i.id === nextChunkId);
    return nextChunk;
  } else {
    return currentChunk;
  }

}

// Helpers
function _getChunks() {
  return getChunks(vscode.window.activeTextEditor.document);
}
function _getStartLine() {
  return vscode.window.activeTextEditor.selection.start.line;
}

export async function runCurrentChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {
  const currentChunk = getCurrentChunk(chunks, line);
  await runChunksInTerm([currentChunk.codeRange]);
}

export async function runPreviousChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {
  const currentChunk = getCurrentChunk(chunks, line);
  const previousChunk = getPreviousChunk(chunks, line);

  if (previousChunk !== currentChunk) {
    await runChunksInTerm([previousChunk.codeRange]);
  }

}

export async function runNextChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {
  const currentChunk = getCurrentChunk(chunks, line);
  const nextChunk = getNextChunk(chunks, line);

  if (nextChunk !== currentChunk) {
    await runChunksInTerm([nextChunk.codeRange]);
  }
}

export async function runAboveChunks(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {
  const currentChunk = getCurrentChunk(chunks, line);
  const previousChunk = getPreviousChunk(chunks, line);
  const firstChunkId = 1;
  const previousChunkId = previousChunk.id;

  const codeRanges: vscode.Range[] = [];

  if (previousChunk !== currentChunk) {
    for (let i = firstChunkId; i <= previousChunkId; i++) {
      const chunk = chunks.find(e => e.id === i);
      if (chunk.eval) {
        codeRanges.push(chunk.codeRange);
      }
    }
    await runChunksInTerm(codeRanges);
  }
}

export async function runBelowChunks(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {

  const currentChunk = getCurrentChunk(chunks, line);
  const nextChunk = getNextChunk(chunks, line);
  const nextChunkId = nextChunk.id;
  const lastChunkId = chunks.length;

  const codeRanges: vscode.Range[] = [];
  if (nextChunk !== currentChunk) {
    for (let i = nextChunkId; i <= lastChunkId; i++) {
      const chunk = chunks.find(e => e.id === i);
      if (chunk.eval) {
        codeRanges.push(chunk.codeRange);
      }
    }
    await runChunksInTerm(codeRanges);
  }
}

export async function runCurrentAndBelowChunks(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): Promise<void> {
  const currentChunk = getCurrentChunk(chunks, line);
  const currentChunkId = currentChunk.id;
  const lastChunkId = chunks.length;

  const codeRanges: vscode.Range[] = [];

  for (let i = currentChunkId; i <= lastChunkId; i++) {
    const chunk = chunks.find(e => e.id === i);
    codeRanges.push(chunk.codeRange);
  }
  await runChunksInTerm(codeRanges);
}

export async function runAllChunks(chunks: RMarkdownChunk[] = _getChunks()): Promise<void> {

  const firstChunkId = 1;
  const lastChunkId = chunks.length;

  const codeRanges: vscode.Range[] = [];

  for (let i = firstChunkId; i <= lastChunkId; i++) {
    const chunk = chunks.find(e => e.id === i);
    if (chunk.eval) {
      codeRanges.push(chunk.codeRange);
    }
  }
  await runChunksInTerm(codeRanges);
}

async function goToChunk(chunk: RMarkdownChunk) {
  // Move cursor 1 line below 'chunk start line'
  const line = chunk.startLine + 1;
  vscode.window.activeTextEditor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand('revealLine', { lineNumber: line, at: 'center' });
}

export function goToPreviousChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): void {
  const previousChunk = getPreviousChunk(chunks, line);
  void goToChunk(previousChunk);
}

export function goToNextChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): void {
  const nextChunk = getNextChunk(chunks, line);
  void goToChunk(nextChunk);
}

export function selectCurrentChunk(chunks: RMarkdownChunk[] = _getChunks(),
  line: number = _getStartLine()): void {
  const editor = vscode.window.activeTextEditor;
  const currentChunk = getCurrentChunk__CursorWithinChunk(chunks, line);
  const lines = editor.document.getText().split(/\r?\n/);

  editor.selection = new vscode.Selection(
    currentChunk.startLine, 0,
    currentChunk.endLine, lines[currentChunk.endLine].length
  );
}

export class RMarkdownCompletionItemProvider implements vscode.CompletionItemProvider {

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
  public readonly chunkOptionCompletionItems: vscode.CompletionItem[];

  constructor() {
    this.chunkOptionCompletionItems = this.chunkOptions.map((x: string) => {
      const item = new vscode.CompletionItem(`${x}`);
      item.insertText = `${x}=`;
      return item;
    });
  }

  public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const line = document.lineAt(position).text;
    if (isChunkStartLine(line, false) && getChunkLanguage(line) === 'r') {
      return this.chunkOptionCompletionItems;
    }

    return undefined;
  }
}
