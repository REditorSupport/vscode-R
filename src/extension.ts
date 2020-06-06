'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { CancellationToken, commands, CompletionContext, CompletionItem, CompletionItemKind,
         ExtensionContext, Hover, IndentAction, languages, MarkdownString, Position, Range,
         StatusBarAlignment, TextDocument, window } from 'vscode';

import { previewDataframe, previewEnvironment } from './preview';
import { createGitignore } from './rGitignore';
import { chooseTerminal, chooseTerminalAndSendText, createRTerm, deleteTerminal,
         runSelectionInTerm, runTextInTerm } from './rTerminal';
import { getWordOrSelection, surroundSelection } from './selection';
import { attachActive, deploySessionWatcher, globalenv, showPlotHistory, startRequestWatcher } from './session';
import { config, ToRStringLiteral } from './util';

const wordPattern = /(-?\d*\.\d\w*)|([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\<\>\/\s]+)/g;

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

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json

    async function saveDocument(document: TextDocument) {
        if (document.isUntitled) {
            window.showErrorMessage('Document is unsaved. Please save and retry running R command.');

            return false;
        }

        const isSaved: boolean = document.isDirty ? (await document.save()) : true;
        if (!isSaved) {
            window.showErrorMessage('Cannot run R command: document could not be saved.');

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
            chooseTerminalAndSendText(`source(${rPath})`);
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
                chooseTerminalAndSendText(`rmarkdown::render(${rPath})`);
            } else {
                chooseTerminalAndSendText(`rmarkdown::render(${rPath}, "${outputFormat}")`);
            }
        }
    }

    async function runSelection() {
        const callableTerminal = await chooseTerminal();
        if (callableTerminal === undefined) {
            return;
        }
        runSelectionInTerm(callableTerminal, true);
    }

    async function runSelectionInActiveTerm() {
        const callableTerminal = await chooseTerminal(true);
        if (callableTerminal === undefined) {
            return;
        }
        runSelectionInTerm(callableTerminal, true);
    }

    async function runSelectionRetainCursor() {
        const callableTerminal = await chooseTerminal();
        if (callableTerminal === undefined) {
            return;
        }
        runSelectionInTerm(callableTerminal, false);
    }

    async function runSelectionOrWord(rFunctionName: string[]) {
        const callableTerminal = await chooseTerminal();
        if (callableTerminal === undefined) {
            return;
        }
        const text = getWordOrSelection();
        const wrappedText = surroundSelection(text, rFunctionName);
        runTextInTerm(callableTerminal, wrappedText);
    }

    async function runCommandWithSelectionOrWord(rCommand: string) {
        const text = getWordOrSelection();
        const callableTerminal = await chooseTerminal();
        const call = rCommand.replace(/\$\$/g, text);
        runTextInTerm(callableTerminal, call);
    }

    async function runCommandWithEditorPath(rCommand: string) {
        const wad: TextDocument = window.activeTextEditor.document;
        const isSaved = await saveDocument(wad);
        if (isSaved) {
            const callableTerminal = await chooseTerminal();
            const rPath = ToRStringLiteral(wad.fileName, '');
            const call = rCommand.replace(/\$\$/g, rPath);
            runTextInTerm(callableTerminal, call);
        }
    }

    async function runCommand(rCommand: string) {
        const callableTerminal = await chooseTerminal();
        runTextInTerm(callableTerminal, rCommand);
    }

    async function runFromBeginningToLine() {
        const callableTerminal = await chooseTerminal(true);
        if (callableTerminal === undefined) {
            return;
        }
        const endLine = window.activeTextEditor.selection.end.line;
        const charactersOnLine = window.activeTextEditor.document.lineAt(endLine).text.length;
        const endPos = new Position(endLine, charactersOnLine);
        const range = new Range(new Position(0, 0), endPos);
        const text = window.activeTextEditor.document.getText(range);
        runTextInTerm(callableTerminal, text);
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
        commands.registerCommand('r.runSource', () => { runSource(false); }),
        commands.registerCommand('r.knitRmd', () => { knitRmd(false, undefined); }),
        commands.registerCommand('r.knitRmdToPdf', () => { knitRmd(false, 'pdf_document'); }),
        commands.registerCommand('r.knitRmdToHtml', () => { knitRmd(false, 'html_document'); }),
        commands.registerCommand('r.knitRmdToAll', () => { knitRmd(false, 'all'); }),
        commands.registerCommand('r.createRTerm', createRTerm),
        commands.registerCommand('r.runSourcewithEcho', () => { runSource(true); }),
        commands.registerCommand('r.runSelection', runSelection),
        commands.registerCommand('r.runSelectionInActiveTerm', runSelectionInActiveTerm),
        commands.registerCommand('r.runFromBeginningToLine', runFromBeginningToLine),
        commands.registerCommand('r.runSelectionRetainCursor', runSelectionRetainCursor),
        commands.registerCommand('r.createGitignore', createGitignore),
        commands.registerCommand('r.previewDataframe', previewDataframe),
        commands.registerCommand('r.previewEnvironment', previewEnvironment),
        commands.registerCommand('r.loadAll', () => chooseTerminalAndSendText('devtools::load_all()')),
        commands.registerCommand('r.test', () => chooseTerminalAndSendText('devtools::test()')),
        commands.registerCommand('r.install', () => chooseTerminalAndSendText('devtools::install()')),
        commands.registerCommand('r.build', () => chooseTerminalAndSendText('devtools::build()')),
        commands.registerCommand('r.document', () => chooseTerminalAndSendText('devtools::document()')),
        commands.registerCommand('r.attachActive', attachActive),
        commands.registerCommand('r.showPlotHistory', showPlotHistory),
        commands.registerCommand('r.runCommandWithSelectionOrWord', runCommandWithSelectionOrWord),
        commands.registerCommand('r.runCommandWithEditorPath', runCommandWithEditorPath),
        commands.registerCommand('r.runCommand', runCommand),
        window.onDidCloseTerminal(deleteTerminal),
    );

    if (config().get<boolean>('sessionWatcher')) {
        console.info('Initialize session watcher');
        languages.registerHoverProvider('r', {
            provideHover(document, position, token) {
                const wordRange = document.getWordRangeAtPosition(position);
                const text = document.getText(wordRange);

                return new Hover(`\`\`\`\n${globalenv[text].str}\n\`\`\``);
            },
        });

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
                        item.documentation = new MarkdownString('```r\n' + obj.str + '\n```');
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
    }
}

// This method is called when your extension is deactivated
// Export function deactivate() {

// }
