import * as vscode from 'vscode';
import { getSelection, moveAfterSelection } from '../selection';
import {
    createChunkCommands,
    getChunks,
    getCodeLenses,
    goToNextChunk,
    goToPreviousChunk,
    selectCurrentChunk,
} from '../rmarkdown/chunks';
import { BrowserInteractive } from './interactive';
import { BrowserLanguageService } from './languageService';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'r.webExtension', true);
    const interactive = new BrowserInteractive(context);
    context.subscriptions.push(interactive, new BrowserLanguageService(context.globalStorageUri));

    const runSource = async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await interactive.submit(editor.document.getText());
        }
    };
    const runSelection = async (move: boolean) => {
        const editor = vscode.window.activeTextEditor;
        const selection = getSelection();
        if (!editor || !selection) {
            return;
        }
        await interactive.submit(selection.selectedText);
        if (move) {
            await moveAfterSelection(editor, selection);
        }
    };
    const chunks = createChunkCommands(async (ranges) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await interactive.submit(
                ranges
                    .filter((range) =>
                        getChunks(editor.document).some(
                            (chunk) => chunk.language === 'r' && chunk.codeRange.isEqual(range),
                        ),
                    )
                    .map((range) => editor.document.getText(range))
                    .join('\n'),
            );
        }
    }, runSource);
    const commands = {
        'r.newFileDocument': async () =>
            vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument({ language: 'r' }),
            ),
        'r.runSource': runSource,
        'r.runSourcewithEcho': chunks.runSourceWithEcho,
        'r.runSelection': () => runSelection(true),
        'r.runSelectionRetainCursor': () => runSelection(false),
        'r.runCommand': (code: string) => interactive.submit(code),
        'r.runCurrentChunk': chunks.runCurrentChunk,
        'r.runCurrentChunkAndMove': chunks.runCurrentChunkAndMove,
        'r.runPreviousChunk': chunks.runPreviousChunk,
        'r.runNextChunk': chunks.runNextChunk,
        'r.runAboveChunks': chunks.runAboveChunks,
        'r.runBelowChunks': chunks.runBelowChunks,
        'r.runCurrentAndBelowChunks': chunks.runCurrentAndBelowChunks,
        'r.runAllChunks': chunks.runAllChunks,
        'r.goToPreviousChunk': goToPreviousChunk,
        'r.goToNextChunk': goToNextChunk,
        'r.selectCurrentChunk': selectCurrentChunk,
        'r.interactive.new': () => interactive.open(true),
        'r.interactive.open': () => interactive.open(),
        'r.interactive.interrupt': () => interactive.interrupt(),
        'r.interactive.stop': () => interactive.stop(),
        'r.interactive.stopAll': () => interactive.stopAll(),
        'r.interactive.restart': () => interactive.stop(),
        'r.interactive.sessionActions': () => interactive.actions(),
        'r.webR.importFiles': (uris?: vscode.Uri[]) => interactive.import(uris),
        'r.webR.exportFile': (source?: string, uri?: vscode.Uri) => interactive.export(source, uri),
    };
    for (const [id, handler] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider([{ language: 'r' }, { language: 'rmd' }], {
            provideCodeLenses: (doc, token) => getCodeLenses(getChunks(doc), token),
        }),
    );
}
