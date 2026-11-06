import * as vscode from 'vscode';
import { config } from '../util';
import {
    shouldDisplayChunkOptions,
    getChunks,
    getCurrentChunk,
    getCodeLenses,
    isRDocument,
    type RMarkdownChunk,
} from './chunks';

// reexports
export { knitDir, RMarkdownKnitManager } from './knit';
export { RMarkdownPreviewManager } from './preview';
export { newDraft } from './draft';
export {
    getChunks,
    runCurrentChunk,
    runCurrentChunkAndMove,
    runPreviousChunk,
    runNextChunk,
    runAboveChunks,
    runBelowChunks,
    runCurrentAndBelowChunks,
    runAllChunks,
    goToPreviousChunk,
    goToNextChunk,
    selectCurrentChunk,
} from './chunks';

export class RMarkdownCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    private readonly decoration: vscode.TextEditorDecorationType;
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    private readonly currentCellTop: vscode.TextEditorDecorationType;
    private readonly currentCellBottom: vscode.TextEditorDecorationType;
    private readonly listeners: vscode.Disposable[] = [];
    private readonly chunkBackgroundEnabled: boolean;
    private readonly highlightedCells = new WeakMap<
        vscode.TextEditor,
        { version: number; chunk: RMarkdownChunk | undefined }
    >();
    private readonly highlightedBackgrounds = new WeakMap<
        vscode.TextEditor,
        { document: vscode.TextDocument; version: number; languageId: string }
    >();
    private readonly backgroundRanges = new WeakMap<RMarkdownChunk[], vscode.Range[]>();

    constructor() {
        const backgroundColor = config().get<string>('rmarkdown.chunkBackgroundColor');
        this.chunkBackgroundEnabled = Boolean(backgroundColor);
        this.decoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor,
        });
        // From https://github.com/microsoft/vscode-jupyter/blob/f8c0f925d855a45240fd06875b17216e47eb08f8/src/interactive-window/editor-integration/decorator.ts#L84
        this.currentCellTop = vscode.window.createTextEditorDecorationType({
            borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
            borderWidth: '2px 0px 0px 0px',
            borderStyle: 'solid',
            isWholeLine: true,
        });
        this.currentCellBottom = vscode.window.createTextEditorDecorationType({
            borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
            borderWidth: '0px 0px 1px 0px',
            borderStyle: 'solid',
            isWholeLine: true,
        });

        // Decorations have their own setting and must also update when VS Code
        // does not request CodeLens. Cache both document scans and editor writes.
        this.listeners.push(
            vscode.window.onDidChangeTextEditorSelection(({ textEditor }) =>
                this.updateEditorDecorations(textEditor),
            ),
            vscode.window.onDidChangeVisibleTextEditors((editors) =>
                editors.forEach((editor) => this.updateEditorDecorations(editor)),
            ),
            vscode.workspace.onDidChangeTextDocument(({ document }) => {
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === document) {
                        this.updateEditorDecorations(editor);
                    }
                }
            }),
        );
        vscode.window.visibleTextEditors.forEach((editor) => this.updateEditorDecorations(editor));
    }

    private updateEditorDecorations(editor: vscode.TextEditor, chunks?: RMarkdownChunk[]): void {
        const document = editor.document;
        if (document.languageId !== 'rmd' && this.highlightedBackgrounds.has(editor)) {
            editor.setDecorations(this.decoration, []);
            this.highlightedBackgrounds.delete(editor);
        }
        if (!isRDocument(document) && this.highlightedCells.has(editor)) {
            editor.setDecorations(this.currentCellTop, []);
            editor.setDecorations(this.currentCellBottom, []);
            this.highlightedCells.delete(editor);
        }
        if (isRDocument(document)) {
            this.highlightCurrentChunk(chunks ?? getChunks(document), editor);
        } else if (document.languageId === 'rmd' && this.chunkBackgroundEnabled) {
            const previous = this.highlightedBackgrounds.get(editor);
            if (
                previous?.document === document &&
                previous.version === document.version &&
                previous.languageId === document.languageId
            ) {
                return;
            }
            chunks ??= getChunks(document);
            let ranges = this.backgroundRanges.get(chunks);
            if (!ranges) {
                ranges = chunks.map((chunk) => chunk.chunkRange);
                this.backgroundRanges.set(chunks, ranges);
            }
            editor.setDecorations(this.decoration, ranges);
            this.highlightedBackgrounds.set(editor, {
                document,
                version: document.version,
                languageId: document.languageId,
            });
        }
    }

    private highlightCurrentChunk(chunks: RMarkdownChunk[], editor: vscode.TextEditor) {
        const document = editor.document;
        const currentChunk = getCurrentChunk(chunks, editor.selection.active.line);
        const previous = this.highlightedCells.get(editor);
        if (previous?.version === document.version && previous.chunk === currentChunk) {
            return;
        }
        this.highlightedCells.set(editor, { version: document.version, chunk: currentChunk });
        editor.setDecorations(
            this.currentCellTop,
            currentChunk ? [document.lineAt(currentChunk.startLine).range] : [],
        );
        editor.setDecorations(
            this.currentCellBottom,
            currentChunk ? [document.lineAt(currentChunk.endLine).range] : [],
        );
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const chunks = getChunks(document);

        // Highlight chunks
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === document) {
                this.updateEditorDecorations(editor, chunks);
            }
        }

        // Loop through chunks and setup
        const codeLenses = getCodeLenses(chunks, token);

        return codeLenses;
    }
    public resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
        return codeLens;
    }

    // Clean-up
    dispose() {
        // Unregister the event listener when the provider is disposed
        this.listeners.forEach((listener) => {
            listener.dispose();
        });
        this.decoration.dispose();
        this.currentCellTop.dispose();
        this.currentCellBottom.dispose();
        this._onDidChangeCodeLenses.dispose();
    }
}

export class RMarkdownCompletionItemProvider implements vscode.CompletionItemProvider {
    // obtained from R code
    // paste0("[", paste0(paste0("'", names(knitr:: opts_chunk$merge(NULL)), "'"), collapse = ", "), "]")
    public readonly chunkOptions = [
        'eval',
        'echo',
        'results',
        'tidy',
        'tidy.opts',
        'collapse',
        'prompt',
        'comment',
        'highlight',
        'strip.white',
        'size',
        'background',
        'cache',
        'cache.path',
        'cache.vars',
        'cache.lazy',
        'dependson',
        'autodep',
        'cache.rebuild',
        'fig.keep',
        'fig.show',
        'fig.align',
        'fig.path',
        'dev',
        'dev.args',
        'dpi',
        'fig.ext',
        'fig.width',
        'fig.height',
        'fig.env',
        'fig.cap',
        'fig.scap',
        'fig.lp',
        'fig.subcap',
        'fig.pos',
        'out.width',
        'out.height',
        'out.extra',
        'fig.retina',
        'external',
        'sanitize',
        'interval',
        'aniopts',
        'warning',
        'error',
        'message',
        'render',
        'ref.label',
        'child',
        'engine',
        'split',
        'include',
        'purl',
    ];
    public readonly chunkOptionCompletionItems: vscode.CompletionItem[];

    constructor() {
        this.chunkOptionCompletionItems = this.chunkOptions.map((x: string) => {
            const item = new vscode.CompletionItem(`${x}`);
            item.insertText = `${x}=`;
            return item;
        });
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        if (shouldDisplayChunkOptions(document, position)) {
            return this.chunkOptionCompletionItems;
        }

        return undefined;
    }
}

// Fold code chunks
export class RChunkFoldingProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
        document: vscode.TextDocument,
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
        const chunks = getChunks(document);
        if (chunks) {
            return chunks.map((chunk) => {
                return new vscode.FoldingRange(
                    chunk.startLine,
                    chunk.endLine,
                    vscode.FoldingRangeKind.Region,
                );
            });
        }
        return undefined;
    }
}
