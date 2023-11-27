import * as vscode from 'vscode';
import { config } from '../util';
import { 
    shouldDisplayChunkOptions, getChunks, getCurrentChunk,
    getCodeLenses, isRDocument,
    type RMarkdownChunk
} from './chunks';

// reexports
export { knitDir, RMarkdownKnitManager } from './knit';
export { RMarkdownPreviewManager } from './preview';
export { newDraft } from './draft';
export { getChunks, runCurrentChunk, runCurrentChunkAndMove, runPreviousChunk, runNextChunk, runAboveChunks, runBelowChunks, runCurrentAndBelowChunks, runAllChunks, goToPreviousChunk, goToNextChunk, selectCurrentChunk } from './chunks';

export class RMarkdownCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    private readonly decoration: vscode.TextEditorDecorationType;
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private readonly currentCellTop: vscode.TextEditorDecorationType;
    private readonly currentCellBottom: vscode.TextEditorDecorationType;
    private onDidChangeTextEditorSelectionHandler: vscode.Disposable | undefined;

    constructor() {
        this.decoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: config().get('rmarkdown.chunkBackgroundColor'),
        });
        // From https://github.com/microsoft/vscode-jupyter/blob/f8c0f925d855a45240fd06875b17216e47eb08f8/src/interactive-window/editor-integration/decorator.ts#L84
        this.currentCellTop = vscode.window.createTextEditorDecorationType({
            borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
            borderWidth: '2px 0px 0px 0px',
            borderStyle: 'solid',
            isWholeLine: true
        });
        this.currentCellBottom = vscode.window.createTextEditorDecorationType({
            borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
            borderWidth: '0px 0px 1px 0px',
            borderStyle: 'solid',
            isWholeLine: true
        });

        // Register the event listener and store the disposable
        this.onDidChangeTextEditorSelectionHandler = vscode.window.onDidChangeTextEditorSelection(
            () => this.onDidChangeTextEditorSelection()
        );
    }

    // Event handler for text editor selection change
    private onDidChangeTextEditorSelection() {
        // Get the active editor
        const editor = vscode.window.activeTextEditor;
        
        if (editor) {
            const document = editor.document;
            const chunks = getChunks(document);

            // Call highlightCurrentChunk with the updated chunks and document
            this.highlight(chunks, document);
        }
    }

    private highlightCurrentChunk(chunks: RMarkdownChunk[], document: vscode.TextDocument) {
        for (const editor of vscode.window.visibleTextEditors) {  
            if (editor.document.uri.toString() === document.uri.toString()) {
                const lines = document.getText().split(/\r?\n/);
                const currentLine = editor.selection.active.line;
                const currentChunk = getCurrentChunk(chunks, currentLine);      
                
                if (currentChunk) {
                    // set top border
                    const currentChunkStart = new vscode.Range(
                        new vscode.Position(currentChunk.startLine, 0),
                        new vscode.Position(currentChunk.startLine, lines[currentChunk.startLine].length)
                    );
                    editor.setDecorations(this.currentCellTop, [currentChunkStart]);

                    // set bottom border
                    const currentChunkEnd = new vscode.Range(
                        new vscode.Position(currentChunk.endLine, 0),
                        new vscode.Position(currentChunk.endLine, lines[currentChunk.endLine].length)
                    );
                    editor.setDecorations(this.currentCellBottom, [currentChunkEnd]);
                }
            }
        }
    }

    private highlightChunks(chunks: RMarkdownChunk[], document: vscode.TextDocument) {
        const chunkRanges = chunks.map((chunk) => chunk.chunkRange);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === document.uri.toString()) {
                editor.setDecorations(this.decoration, chunkRanges);
            }
        }
    }

    private highlight(chunks: RMarkdownChunk[], document: vscode.TextDocument) {
        if (!chunks) {
            return;
        }
        
        // Highlight differently for `.R` and `.Rmd` files
        const isRDoc = isRDocument(document);
        if (isRDoc) {
            this.highlightCurrentChunk(chunks, document);
        } else {
            this.highlightChunks(chunks, document);
        }
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        
        const chunks = getChunks(document);

        // Highlight chunks
        this.highlight(chunks, document);        

        // Loop through chunks and setup
        const codeLenses = getCodeLenses(
            chunks, token
        );

        return codeLenses;
    }
    public resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
        return codeLens;
    }
    
    // Clean-up
    dispose() {
        // Unregister the event listener when the provider is disposed
        if (this.onDidChangeTextEditorSelectionHandler) {
            this.onDidChangeTextEditorSelectionHandler.dispose();
        }
    }
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

    public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
        if (shouldDisplayChunkOptions(document, position)) {
            return this.chunkOptionCompletionItems;
        }

        return undefined;
    }
}

// Fold code chunks
export class RChunkFoldingProvider implements vscode.FoldingRangeProvider {
    constructor() { this; }

    provideFoldingRanges(document: vscode.TextDocument): vscode.ProviderResult<vscode.FoldingRange[]> {
        const chunks = getChunks(document);
        if (chunks) {
            return chunks.map((chunk) => {
                return new vscode.FoldingRange(chunk.startLine, chunk.endLine, vscode.FoldingRangeKind.Region);
            });
        }
        return undefined;
    }
}
