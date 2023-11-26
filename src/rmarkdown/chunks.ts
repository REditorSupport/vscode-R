import * as vscode from 'vscode';
import { config } from '../util';
import { runChunksInTerm } from '../rTerminal';

export function isRDocument(document: vscode.TextDocument) {
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
        const isSectionHeader = text.match(/^#+\s*.*[-#+=*]{4,}/g);
        return (isRChunkLine(text) || isSectionHeader);
    } else {
        return (!!text.match(/^\s*```+\s*$/g));
    }
}

function getChunkLanguage(text: string, isRDoc: boolean = false) {
    if (isRDoc) {
        return 'r';
    }  
    return text.replace(/^\s*```+\s*\{(\w+)\s*.*\}\s*$/g, '$1').toLowerCase();
}

function getChunkOptions(text: string, isRDoc: boolean = false) {
    if (isRDoc) {
        return text.replace(/^#+\s*%%/g, '');
    } else {
        return text.replace(/^\s*```+\s*\{\w+\s*,?\s*(.*)\s*\}\s*$/g, '$1');
    }
}

function getChunkEval(chunkOptions: string) {
    return (!chunkOptions.match(/eval\s*=\s*(F|FALSE)/g));
}

// This is for #| style chunk options
function isOptionComment(text: string) {
    return (!!text.match(/^#+\|/g));
}
export function shouldDisplayChunkOptions(document: vscode.TextDocument, position: vscode.Position) {
    const line = document.lineAt(position).text;
    const isRDoc = isRDocument(document);
    const currentChunk = getCurrentChunk(getChunks(document), position.line);
    const withinChunk = currentChunk && isWithinChunk(currentChunk, position.line);
    if (!withinChunk) {
        return false;
    }

    const isRChunk = isRDoc ? 
        true : 
        getChunkLanguage(document.lineAt(currentChunk?.startLine).text, isRDoc) === 'r';
    
    return isRChunk && (isChunkStartLine(line, isRDoc) || isOptionComment(line));
}

export interface RMarkdownChunk {
    id: number;
    startLine: number;
    endLine: number;
    language: string | undefined;
    options: string | undefined;
    eval: boolean | undefined;
    chunkRange: vscode.Range;
    codeRange: vscode.Range;
}

// Scan document and return chunk info (e.g. ID, chunk range) from all chunks
export function getChunks(document: vscode.TextDocument): RMarkdownChunk[] {
    const lines = document.getText().split(/\r?\n/);
    const chunks: RMarkdownChunk[] = [];

    let line = 0;
    let chunkId = 0;  // One-based index
    let chunkStartLine: number | undefined = undefined;
    let chunkEndLine: number | undefined = undefined;
    let codeEndLine: number | undefined = undefined;
    let chunkLanguage: string | undefined = undefined;
    let chunkOptions: string | undefined = undefined;
    let chunkEval: boolean | undefined = undefined;
    const isRDoc = isRDocument(document);

    while (line < lines.length) {
        if (chunkStartLine === undefined) {
            if (isChunkStartLine(lines[line], isRDoc)) {
                chunkId++;
                chunkStartLine = line;
                chunkLanguage = getChunkLanguage(lines[line], isRDoc);
                chunkOptions = getChunkOptions(lines[line], isRDoc);
                chunkEval = getChunkEval(chunkOptions);
            }
        } else {
            // Second condition is for the last chunk in an .R file
            const isRDocAndFinalLine = (isRDoc && line === lines.length - 1);
            if (isChunkEndLine(lines[line], isRDoc) || isRDocAndFinalLine) {
                chunkEndLine = line;
                codeEndLine = line - 1;
                
                // isChunkEndLine looks for `# %%` in `.R` files, so if found, then need to go back one line to mark end of code chunk. 
                if (isRDoc && !isRDocAndFinalLine) {
                    chunkEndLine = chunkEndLine - 1;
                    codeEndLine = chunkEndLine;
                    line = line - 1;
                }
                
                const chunkRange = new vscode.Range(
                    new vscode.Position(chunkStartLine, 0),
                    new vscode.Position(line, lines[line].length)
                );
                const codeRange = new vscode.Range(
                    new vscode.Position(chunkStartLine + 1, 0),
                    new vscode.Position(codeEndLine, lines[codeEndLine].length)
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

export function getCurrentChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk | undefined {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        void vscode.window.showWarningMessage('No text editor active.');
        return;
    }

    // Case: If `chunks` is empty, return undefined
    if (chunks.length === 0) {
        return undefined;
    }
    
    // Case: Cursor is above first chunk, use first chunk
    if (line < chunks[0].startLine) {
        return chunks[0];
    }
    // Case: Cursor is below last chunk, return last chunk
    if (line > chunks[chunks.length - 1].endLine) {
        return chunks[chunks.length - 1];
    }
    // chunks.filter(i => line >= i.startLine)[0];
    for (const chunk of chunks) {
        // Case: Cursor is within chunk, use current chunk
        // Case: Cursor is between, use next chunk below cursor
        if (chunk.endLine >= line) {
            return chunk;
        }
    }
}

function getPreviousChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk | undefined {
    const currentChunk = getCurrentChunk(chunks, line);
    if (!currentChunk) {
        return undefined;
    }
    if (currentChunk.id !== 1) {
        // When cursor is below the last 'chunk end line', the definition of the previous chunk is the last chunk
        const previousChunkId = currentChunk.endLine < line ? currentChunk.id : currentChunk.id - 1;
        const previousChunk = chunks.find(i => i.id === previousChunkId);
        return previousChunk;
    } else {
        return (currentChunk);
    }
}

function getNextChunk(chunks: RMarkdownChunk[], line: number): RMarkdownChunk | undefined {
    const currentChunk = getCurrentChunk(chunks, line);
    if (!currentChunk) {
        return undefined;
    }
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
function _getChunks(): RMarkdownChunk[] {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return [];
    }
    return getChunks(textEditor.document);
}
function _getStartLine(): number {
    const textEditor = vscode.window.activeTextEditor;
    if (!textEditor) {
        return 0;
    }
    return textEditor.selection.start.line;
}
export function isWithinChunk(chunk: RMarkdownChunk, line: number = _getStartLine()): boolean {
    return (line >= chunk.startLine && line <= chunk.endLine);
}

export async function runCurrentChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    if (currentChunk) {
        await runChunksInTerm([currentChunk.codeRange]);
    }
}

export async function runCurrentChunkAndMove(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    if (currentChunk) {
        await runChunksInTerm([currentChunk.codeRange]);
    }
    const nextChunk = getNextChunk(chunks, line);
    if (nextChunk) {
        void goToChunk(nextChunk);
    }
}

export async function runPreviousChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    const previousChunk = getPreviousChunk(chunks, line);

    // Case: cursor is below the last chunk, run last chunk
    if (currentChunk && line > currentChunk.endLine) {
        await(runChunksInTerm([currentChunk.codeRange]));
    // Case: currentChunk is not the first chunk, so run previousChunk
    } else if (previousChunk && previousChunk !== currentChunk) {
        await runChunksInTerm([previousChunk.codeRange]);
    }

}

export async function runNextChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    const nextChunk = getNextChunk(chunks, line);

    // Case: currentChunk is not the last chunk, so run nextChunk
    if (nextChunk && nextChunk !== currentChunk) {
        await runChunksInTerm([nextChunk.codeRange]);
    }
}

export async function runAboveChunks(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    const previousChunk = getPreviousChunk(chunks, line);
    if (!currentChunk || !previousChunk) {
        return;
    }
    const firstChunkId = 1;
    const previousChunkId = previousChunk.id;

    const codeRanges: vscode.Range[] = [];

    // Only do something if current chunk is not the first chunk
    if (currentChunk.id > 1) {
        for (let i = firstChunkId; i <= previousChunkId; i++) {
            const chunk = chunks.find(e => e.id === i);
            if (chunk?.eval) {
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
    if (!currentChunk || !nextChunk) {
        return;
    }
    const nextChunkId = nextChunk.id;
    const lastChunkId = chunks.length;

    const codeRanges: vscode.Range[] = [];

    // Only do something if current chunk is not the last chunk
    if (currentChunk.id < lastChunkId) {
        for (let i = nextChunkId; i <= lastChunkId; i++) {
            const chunk = chunks.find(e => e.id === i);
            if (chunk?.eval) {
                codeRanges.push(chunk.codeRange);
            }
        }
        await runChunksInTerm(codeRanges);
    }
}

export async function runCurrentAndBelowChunks(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): Promise<void> {
    const currentChunk = getCurrentChunk(chunks, line);
    if (!currentChunk) {
        return;
    }
    const currentChunkId = currentChunk.id;
    const lastChunkId = chunks.length;

    const codeRanges: vscode.Range[] = [];

    for (let i = currentChunkId; i <= lastChunkId; i++) {
        const chunk = chunks.find(e => e.id === i);
        if (chunk) {
            codeRanges.push(chunk.codeRange);
        }
    }
    await runChunksInTerm(codeRanges);
}

export async function runAllChunks(chunks: RMarkdownChunk[] = _getChunks()): Promise<void> {

    const firstChunkId = 1;
    const lastChunkId = chunks.length;

    const codeRanges: vscode.Range[] = [];

    for (let i = firstChunkId; i <= lastChunkId; i++) {
        const chunk = chunks.find(e => e.id === i);
        if (chunk?.eval) {
            codeRanges.push(chunk.codeRange);
        }
    }
    await runChunksInTerm(codeRanges);
}

async function goToChunk(chunk: RMarkdownChunk) {
    // Move cursor 1 line below 'chunk start line'
    const line = chunk.startLine + 1;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('revealLine', { lineNumber: line, at: 'center' });
}

export function goToPreviousChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): void {
    const previousChunk = getPreviousChunk(chunks, line);
    if (previousChunk) {
        void goToChunk(previousChunk);
    }
}

export function goToNextChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): void {
    const nextChunk = getNextChunk(chunks, line);
    if (nextChunk) {
        void goToChunk(nextChunk);
    }
}

export function selectCurrentChunk(chunks: RMarkdownChunk[] = _getChunks(),
    line: number = _getStartLine()): void {
    const editor = vscode.window.activeTextEditor;
    const currentChunk = getCurrentChunk(chunks, line);
    if (!editor || !currentChunk || !isWithinChunk(currentChunk, line)) {
        return;
    }
    const lines = editor.document.getText().split(/\r?\n/);

    editor.selection = new vscode.Selection(
        currentChunk.startLine, 0,
        currentChunk.endLine, lines[currentChunk.endLine].length
    );
}

export function getCodeLenses(chunks: RMarkdownChunk[], token: vscode.CancellationToken): vscode.CodeLens[] {

    const enabledCodeLens = config().get<boolean>('rmarkdown.enableCodeLens');
    if (enabledCodeLens === false) {
        return [];
    }
    
    // Iterate through all code chunks for getting chunk information for both CodeLens and chunk background color (set by `editor.setDecorations`)
    let codeLenses: vscode.CodeLens[] = [];
    for (let i = 1; i <= chunks.length; i++) {
        const chunk = chunks.find(e => e.id === i);
        if (!chunk) {
            continue;
        }
        const chunkRange = chunk.chunkRange;
        const line = chunk.startLine;

        // Enable/disable only CodeLens, without affecting chunk background color.
        if (chunk.language === 'r') {
            if (token.isCancellationRequested) {
                break;
            }
            codeLenses.push(
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

    // For default options, both options and sort order are based on options specified in package.json.
    // For user-specified options, both options and sort order are based on options specified in settings UI or settings.json.
    const rmdCodeLensCommands: string[] = config().get('rmarkdown.codeLensCommands', []);
    codeLenses = codeLenses.
        filter(e => e.command && rmdCodeLensCommands.includes(e.command.command)).
        sort(function (a, b) {
            if (!a.command || !b.command) { return 0; }
            const sorted = rmdCodeLensCommands.indexOf(a.command.command) -
                rmdCodeLensCommands.indexOf(b.command.command);
            return sorted;
        });

    return codeLenses;
}
