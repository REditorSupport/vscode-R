/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { CancellationToken, commands, CompletionContext, CompletionItem, CompletionItemKind,
         ExtensionContext, Hover, IndentAction, languages, MarkdownString, Position, Range,
         StatusBarAlignment, TextDocument, window, workspace } from 'vscode';

import { previewDataframe, previewEnvironment } from './preview';
import { createGitignore } from './rGitignore';
import { createRTerm, deleteTerminal,
    runChunksInTerm,
         runSelectionInTerm, runTextInTerm } from './rTerminal';
import { getWordOrSelection, surroundSelection } from './selection';
import { attachActive, deploySessionWatcher, globalenv, showPlotHistory, startRequestWatcher } from './session';
import { config, ToRStringLiteral, getRpathFromSystem } from './util';
import { launchAddinPicker, trackLastActiveTextEditor } from './rstudioapi';
import { RMarkdownCodeLensProvider, RMarkdownCompletionItemProvider, selectCurrentChunk, runCurrentChunk, runAboveChunks, runCurrentAndBelowChunks, runBelowChunks, runPreviousChunk, runNextChunk, runAllChunks, goToPreviousChunk, goToNextChunk } from './rmarkdown';

import * as path from 'path';

import { HelpPanel, HelpPanelOptions, HelpProvider, AliasProviderArgs, HelpSubMenu } from './rHelpPanel';
import { RHelpClient } from './rHelpProviderBuiltin';
import { RHelp } from './rHelpProviderCustom';
import { AliasProvider } from './rHelpAliases';
import { RExtensionImplementation as RExtension } from './apiImplementation';

const wordPattern = /(-?\d*\.\d\w*)|([^`~!@$^&*()=+[{\]}\\|;:'",<>/\s]+)/g;

// Get with names(roxygen2:::default_tags())
const roxygenTagCompletionItems = [
    'export', 'exportClass', 'exportMethod', 'exportPattern', 'import', 'importClassesFrom',
    'importFrom', 'importMethodsFrom', 'rawNamespace', 'S3method', 'useDynLib', 'aliases',
    'author', 'backref', 'concept', 'describeIn', 'description', 'details',
    'docType', 'encoding', 'evalRd', 'example', 'examples', 'family',
    'field', 'format', 'inherit', 'inheritParams', 'inheritDotParams', 'inheritSection',
    'keywords', 'method', 'name', 'md', 'noMd', 'noRd',
    'note', 'param', 'rdname', 'rawRd', 'references', 'return',
    'section', 'seealso', 'slot', 'source', 'template', 'templateVar',
    'title', 'usage'].map((x: string) => new CompletionItem(`${x} `));


export let globalRHelpPanel: HelpPanel | null = null;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: ExtensionContext): Promise<RExtension> {

    // used to export an interface to the help panel
    // used e.g. by vscode-r-debugger to show the help panel from within debug sessions
    const rExtension = new RExtension();

    // get the "vanilla" R path from config
    let rPath = config().get<string>('helpPanel.rpath', '') || await getRpathFromSystem();
    if(/^[^'"].* .*[^'"]$/.exec(rPath)){
        rPath = `"${rPath}"`;
    }
    const rHelpProviderOptions = {
        rPath: rPath,
        cwd: ((workspace.workspaceFolders !== undefined && workspace.workspaceFolders.length > 0) ? workspace.workspaceFolders[0].uri.fsPath : undefined)
    };

    // which helpProvider to use.
    const helpProviderType = config().get<'custom'|'Rserver'>('helpPanel.helpProvider');

    // launch help provider (provides the html for requested entries)
    let helpProvider: HelpProvider = undefined;
    try{
        if(helpProviderType === 'custom'){
            helpProvider = new RHelp(rHelpProviderOptions);
        } else {
            helpProvider = new RHelpClient(rHelpProviderOptions);
        }
    } catch(e) {
        void window.showErrorMessage(`Help Panel not available`);
    }

    // launch alias-provider. Is used to implement `?`
    const aliasProviderArgs: AliasProviderArgs = {
        rPath: rPath,
        rScriptFile: context.asAbsolutePath('R/getAliases.R')
    };
    const aliasProvider = new AliasProvider(aliasProviderArgs);

    // launch the help panel (displays the html provided by helpProvider)
    const rHelpPanelOptions: HelpPanelOptions = {
        webviewScriptPath: path.join(context.extensionPath, path.normalize('/html/script.js')),
        webviewStylePath: path.join(context.extensionPath, path.normalize('/html/theme.css'))
    };
    const rHelpPanel = new HelpPanel(helpProvider, rHelpPanelOptions, aliasProvider);
    globalRHelpPanel = rHelpPanel;

    rExtension.helpPanel = rHelpPanel;

    context.subscriptions.push(rHelpPanel);

    context.subscriptions.push(commands.registerCommand('r.showHelp', (subMenu?: HelpSubMenu) => {
        void rHelpPanel.showHelpMenu(subMenu);
    }));

    context.subscriptions.push(commands.registerCommand('r.helpPanel.back', () =>{
        rHelpPanel.goBack();
    }));

    context.subscriptions.push(commands.registerCommand('r.helpPanel.forward', () =>{
        rHelpPanel.goForward();
    }));




    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json

    async function saveDocument(document: TextDocument) {
        if (document.isUntitled) {
            void window.showErrorMessage('Document is unsaved. Please save and retry running R command.');

            return false;
        }

        const isSaved: boolean = document.isDirty ? (await document.save()) : true;
        if (!isSaved) {
            void window.showErrorMessage('Cannot run R command: document could not be saved.');

            return false;
        }

        return true;
    }

    async function runSource(echo: boolean)  {
        const wad = window.activeTextEditor.document;
        const isSaved = await saveDocument(wad);
        if (isSaved) {
            let rPath: string = ToRStringLiteral(wad.fileName, '"');
            let encodingParam = config().get<string>('source.encoding');
            encodingParam = `encoding = "${encodingParam}"`;
            rPath = [rPath, encodingParam].join(', ');
            if (echo) {
                rPath = [rPath, 'echo = TRUE'].join(', ');
            }
            void runTextInTerm(`source(${rPath})`);
        }
    }

    async function knitRmd(echo: boolean, outputFormat: string)  {
        const wad: TextDocument = window.activeTextEditor.document;
        const isSaved = await saveDocument(wad);
        if (isSaved) {
            let rPath = ToRStringLiteral(wad.fileName, '"');
            let encodingParam = config().get<string>('source.encoding');
            encodingParam = `encoding = "${encodingParam}"`;
            rPath = [rPath, encodingParam].join(', ');
            if (echo) {
                rPath = [rPath, 'echo = TRUE'].join(', ');
            }
            if (outputFormat === undefined) {
                void runTextInTerm(`rmarkdown::render(${rPath})`);
            } else {
                void runTextInTerm(`rmarkdown::render(${rPath}, "${outputFormat}")`);
            }
        }
    }

    async function runSelection() {
        await runSelectionInTerm(true);
    }

    async function runSelectionRetainCursor() {
        await runSelectionInTerm(false);
    }

    async function runSelectionOrWord(rFunctionName: string[]) {
        const text = getWordOrSelection();
        const wrappedText = surroundSelection(text, rFunctionName);
        await runTextInTerm(wrappedText);
    }

    async function runCommandWithSelectionOrWord(rCommand: string) {
        const text = getWordOrSelection();
        const call = rCommand.replace(/\$\$/g, text);
        await runTextInTerm(call);
    }

    async function runCommandWithEditorPath(rCommand: string) {
        const wad: TextDocument = window.activeTextEditor.document;
        const isSaved = await saveDocument(wad);
        if (isSaved) {
            const rPath = ToRStringLiteral(wad.fileName, '');
            const call = rCommand.replace(/\$\$/g, rPath);
            await runTextInTerm(call);
        }
    }

    async function runCommand(rCommand: string) {
        await runTextInTerm(rCommand);
    }

    async function runFromBeginningToLine() {
        const endLine = window.activeTextEditor.selection.end.line;
        const charactersOnLine = window.activeTextEditor.document.lineAt(endLine).text.length;
        const endPos = new Position(endLine, charactersOnLine);
        const range = new Range(new Position(0, 0), endPos);
        const text = window.activeTextEditor.document.getText(range);
        await runTextInTerm(text);
    }

    async function runFromLineToEnd() {
        const startLine = window.activeTextEditor.selection.start.line;
        const startPos = new Position(startLine, 0);
        const endLine = window.activeTextEditor.document.lineCount;
        const range = new Range(startPos, new Position(endLine, 0));
        const text = window.activeTextEditor.document.getText(range);
        await runTextInTerm(text);
    }

    languages.registerCompletionItemProvider('r', {
        provideCompletionItems(document: TextDocument, position: Position) {
            if (document.lineAt(position).text
                        .substr(0, 2) === '#\'') {
                return roxygenTagCompletionItems;
            }

            return undefined;
        },
    },                                       '@'); // Trigger on '@'

    languages.setLanguageConfiguration('r', {
        onEnterRules: [{ // Automatically continue roxygen comments: #'
        action: { indentAction: IndentAction.None, appendText: '#\' ' },
        beforeText: /^#'.*/,
        }],
        wordPattern,
    });

    context.subscriptions.push(
        commands.registerCommand('r.nrow', () => runSelectionOrWord(['nrow'])),
        commands.registerCommand('r.length', () => runSelectionOrWord(['length'])),
        commands.registerCommand('r.head', () => runSelectionOrWord(['head'])),
        commands.registerCommand('r.thead', () => runSelectionOrWord(['t', 'head'])),
        commands.registerCommand('r.names', () => runSelectionOrWord(['names'])),
        commands.registerCommand('r.runSource', () => { void runSource(false); }),
        commands.registerCommand('r.knitRmd', () => { void knitRmd(false, undefined); }),
        commands.registerCommand('r.knitRmdToPdf', () => { void knitRmd(false, 'pdf_document'); }),
        commands.registerCommand('r.knitRmdToHtml', () => { void knitRmd(false, 'html_document'); }),
        commands.registerCommand('r.knitRmdToAll', () => { void knitRmd(false, 'all'); }),
        commands.registerCommand('r.createRTerm', createRTerm),
        commands.registerCommand('r.runSourcewithEcho', () => { void runSource(true); }),
        commands.registerCommand('r.runSelection', runSelection),
        commands.registerCommand('r.runFromBeginningToLine', runFromBeginningToLine),
        commands.registerCommand('r.runFromLineToEnd', runFromLineToEnd),
        commands.registerCommand('r.runSelectionRetainCursor', runSelectionRetainCursor),
        commands.registerCommand('r.selectCurrentChunk', selectCurrentChunk),
        commands.registerCommand('r.runCurrentChunk', runCurrentChunk),
        commands.registerCommand('r.runPreviousChunk', runPreviousChunk),
        commands.registerCommand('r.runNextChunk', runNextChunk),
        commands.registerCommand('r.runAboveChunks', runAboveChunks),
        commands.registerCommand('r.runCurrentAndBelowChunks', runCurrentAndBelowChunks),
        commands.registerCommand('r.runBelowChunks', runBelowChunks),
        commands.registerCommand('r.runAllChunks', runAllChunks),
        commands.registerCommand('r.goToPreviousChunk', goToPreviousChunk),
        commands.registerCommand('r.goToNextChunk', goToNextChunk),
        commands.registerCommand('r.runChunks', runChunksInTerm),
        commands.registerCommand('r.createGitignore', createGitignore),
        commands.registerCommand('r.previewDataframe', previewDataframe),
        commands.registerCommand('r.previewEnvironment', previewEnvironment),
        commands.registerCommand('r.loadAll', () => runTextInTerm('devtools::load_all()')),
        commands.registerCommand('r.test', () => runTextInTerm('devtools::test()')),
        commands.registerCommand('r.install', () => runTextInTerm('devtools::install()')),
        commands.registerCommand('r.build', () => runTextInTerm('devtools::build()')),
        commands.registerCommand('r.document', () => runTextInTerm('devtools::document()')),
        commands.registerCommand('r.attachActive', attachActive),
        commands.registerCommand('r.showPlotHistory', showPlotHistory),
        commands.registerCommand('r.runCommandWithSelectionOrWord', runCommandWithSelectionOrWord),
        commands.registerCommand('r.runCommandWithEditorPath', runCommandWithEditorPath),
        commands.registerCommand('r.runCommand', runCommand),
        commands.registerCommand('r.launchAddinPicker', launchAddinPicker),
        window.onDidCloseTerminal(deleteTerminal),
    );

    const rmdCodeLensProvider = new RMarkdownCodeLensProvider();
    languages.registerCodeLensProvider('rmd', rmdCodeLensProvider);

    const rmdCompletionProvider = new RMarkdownCompletionItemProvider();
    languages.registerCompletionItemProvider('rmd', rmdCompletionProvider, ' ', ',');

    if (config().get<boolean>('sessionWatcher')) {
        console.info('Initialize session watcher');
        languages.registerHoverProvider('r', {
            provideHover(document, position, ) {
                const wordRange = document.getWordRangeAtPosition(position);
                const text = document.getText(wordRange);

                return new Hover(`\`\`\`\n${globalenv[text].str}\n\`\`\``);
            },
        });

        languages.registerCompletionItemProvider('r', {
            provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken, completionContext: CompletionContext) {
                const items = [];
                if (token.isCancellationRequested) { return items; }

                if (completionContext.triggerCharacter === undefined) {
                    Object.keys(globalenv).map((key) => {
                        const obj = globalenv[key];
                        const item = new CompletionItem(key,
                                                        obj.type === 'closure' || obj.type === 'builtin' ?
                                CompletionItemKind.Function :
                                CompletionItemKind.Field);
                        item.detail = '[session]';
                        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                        item.documentation = new MarkdownString(`\`\`\`r\n${obj.str}\n\`\`\``);
                        items.push(item);
                    });
                } else if (completionContext.triggerCharacter === '$' || completionContext.triggerCharacter === '@') {
                    const symbolPosition = new Position(position.line, position.character - 1);
                    const symbolRange = document.getWordRangeAtPosition(symbolPosition);
                    const symbol = document.getText(symbolRange);
                    const doc = new MarkdownString('Element of `' + symbol + '`');
                    const obj = globalenv[symbol];
                    let elements: string[];
                    if (obj !== undefined) {
                        if (completionContext.triggerCharacter === '$') {
                            elements = obj.names;
                        } else if (completionContext.triggerCharacter === '@') {
                            elements = obj.slots;
                        }
                    }
                    elements.map((key) => {
                        const item = new CompletionItem(key, CompletionItemKind.Field);
                        item.detail = '[session]';
                        item.documentation = doc;
                        items.push(item);
                    });
                }

                if (completionContext.triggerCharacter === undefined ||
                    completionContext.triggerCharacter === '"' ||
                    completionContext.triggerCharacter === '\'') {
                    getBracketCompletionItems(document, position, token, items);
                }

                return items;
            },
        },                                       '', '$', '@', '"', '\'');

        console.info('Create sessionStatusBarItem');
        const sessionStatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
        sessionStatusBarItem.command = 'r.attachActive';
        sessionStatusBarItem.text = 'R: (not attached)';
        sessionStatusBarItem.tooltip = 'Attach Active Terminal';
        context.subscriptions.push(sessionStatusBarItem);
        sessionStatusBarItem.show();

        deploySessionWatcher(context.extensionPath);
        startRequestWatcher(sessionStatusBarItem);
        trackLastActiveTextEditor(window.activeTextEditor);
        window.onDidChangeActiveTextEditor(trackLastActiveTextEditor);
    }

    console.log('vscode-r: returning R extension...');
    return rExtension;
}

function getBracketCompletionItems(document: TextDocument, position: Position, token: CancellationToken, items: CompletionItem[]) {
    let range = new Range(new Position(position.line, 0), position);
    let expectOpenBrackets = 0;
    let symbol: string;

    loop1:
    while (range.start.line >= 0) {
        if (token.isCancellationRequested) { return; }
        const text = document.getText(range);
        for (let i = text.length - 1; i >= 0; i -= 1) {
            const chr = text.charAt(i);
            if (chr === ']') {
                expectOpenBrackets += 1;
            // tslint:disable-next-line: triple-equals
            } else if (chr === '[') {
                if (expectOpenBrackets === 0) {
                    const symbolPosition = new Position(range.start.line, i - 1);
                    const symbolRange = document.getWordRangeAtPosition(symbolPosition);
                    symbol = document.getText(symbolRange);
                    break loop1;
                } else {
                    expectOpenBrackets -= 1;
                }
            }
        }
        if (range.start.line > 0) {
            range = document.lineAt(range.start.line - 1).range;
        } else {
            break;
        }
    }

    if (!token.isCancellationRequested && symbol !== undefined) {
        const obj = globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new MarkdownString('Element of `' + symbol + '`');
            obj.names.map((name: string) => {
                const item = new CompletionItem(name, CompletionItemKind.Field);
                item.detail = '[session]';
                item.documentation = doc;
                items.push(item);
            });
        }
    }
}

// This method is called when your extension is deactivated
// Export function deactivate() {

// }
