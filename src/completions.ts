/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */


import * as vscode from 'vscode';

import * as session from './session';
import { extendSelection } from './selection';
import { cleanLine } from './lineCache';
import { globalRHelp } from './extension';
import { config } from './util';
import { getChunks } from './rmarkdown';
import { CompletionItemKind } from 'vscode-languageclient';


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
    'title', 'usage'
].map((x: string) => new vscode.CompletionItem(`${x} `));


export class HoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
        if(!session.workspaceData?.globalenv){
            return null;
        }

        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find((chunk) => chunk.language === 'r' && chunk.startLine < position.line && chunk.endLine > position.line);
            if (!chunk) {
                return null;
            }
        }

        let hoverRange = document.getWordRangeAtPosition(position);
        let hoverText = null;

        if (session.server) {
            const exprRegex = /([a-zA-Z0-9._$@ ])+(?<![@$])/;
            hoverRange = document.getWordRangeAtPosition(position, exprRegex)?.with({ end: hoverRange?.end });
            const expr = document.getText(hoverRange);
            const response = await session.sessionRequest(session.server, {
                type: 'hover',
                expr: expr
            });

            if (response) {
                hoverText = response.str;
            }

        } else {
            const symbol = document.getText(hoverRange);
            const str = session.workspaceData.globalenv[symbol]?.str;

            if (str) {
                hoverText = str;
            }
        }

        if (hoverText) {
            return new vscode.Hover(`\`\`\`\n${hoverText}\n\`\`\``, hoverRange);
        }

        return null;
    }
}

export class HelpLinkHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
        if(!config().get<boolean>('helpPanel.enableHoverLinks')){
            return null;
        }

        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find((chunk) => chunk.language === 'r' && chunk.startLine < position.line && chunk.endLine > position.line);
            if (!chunk) {
                return null;
            }
        }

        const re = /([a-zA-Z0-9._:])+/;
        const wordRange = document.getWordRangeAtPosition(position, re);
        const token = document.getText(wordRange);
        const aliases = await globalRHelp?.getMatchingAliases(token) || [];
        const mds = aliases.map(a => {
            const cmdText = `${a.package}::${a.alias}`;
            const args = [`/library/${a.package}/html/${a.name}.html`];
            const encodedArgs = encodeURIComponent(JSON.stringify(args));
            const cmd = 'command:r.helpPanel.openForPath';
            const cmdUri = vscode.Uri.parse(`${cmd}?${encodedArgs}`);
            return `[\`${cmdText}\`](${cmdUri})`;
        });
        const md = new vscode.MarkdownString(mds.join('  \n'));
        md.isTrusted = true;
        return new vscode.Hover(md, wordRange);
    }
}


export class StaticCompletionItemProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find((chunk) => chunk.language === 'r' && chunk.startLine < position.line && chunk.endLine > position.line);
            if (!chunk) {
                return undefined;
            }
        }

        if (document.lineAt(position).text.startsWith('#\'')) {
            return roxygenTagCompletionItems;
        }

        return undefined;
    }
}


export class LiveCompletionItemProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        completionContext: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        if (token.isCancellationRequested || !session.workspaceData?.globalenv) {
            return items;
        }

        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find((chunk) => chunk.language === 'r' && chunk.startLine < position.line && chunk.endLine > position.line);
            if (!chunk) {
                return items;
            }
        }

        const trigger = completionContext.triggerCharacter;

        if (trigger === undefined) {
            Object.keys(session.workspaceData.globalenv).forEach((key) => {
                const obj = session.workspaceData.globalenv[key];
                const item = new vscode.CompletionItem(
                    key,
                    obj.type === 'closure' || obj.type === 'builtin'
                        ? vscode.CompletionItemKind.Function
                        : vscode.CompletionItemKind.Field
                );
                item.detail = '[session]';
                item.documentation = new vscode.MarkdownString(`\`\`\`r\n${obj.str}\n\`\`\``);
                items.push(item);
            });
        } else if(trigger === '$' || trigger === '@') {
            const symbolPosition = new vscode.Position(position.line, position.character - 1);
            if (session.server) {
                const startPosition = new vscode.Position(0, 0);
                const exprRange = new vscode.Range(startPosition, symbolPosition);
                const expr = document.getText(exprRange);
                const response: RObjectElement[] = await session.sessionRequest(session.server, {
                    type: 'complete',
                    expr: expr,
                    trigger: completionContext.triggerCharacter
                });
                if (response) {
                    items.push(...getCompletionItemsFromElements(response, '[session]'));
                }
            } else {
                const symbolRange = document.getWordRangeAtPosition(symbolPosition);
                const symbol = document.getText(symbolRange);
                const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
                const obj = session.workspaceData.globalenv[symbol];
                let names: string[] | undefined;
                if (obj !== undefined) {
                    if (completionContext.triggerCharacter === '$') {
                        names = obj.names;
                    } else if (completionContext.triggerCharacter === '@') {
                        names = obj.slots;
                    }
                }

                if (names) {
                    items.push(...getCompletionItems(names, vscode.CompletionItemKind.Variable, '[session]', doc));
                }
            }

        }

        if (trigger === undefined || trigger === '[' || trigger === ',' || trigger === '"' || trigger === '\'') {
            items.push(...getBracketCompletionItems(document, position, token));
        }

        if (trigger === undefined || trigger === '(' || trigger === ',') {
            items.push(...getPipelineCompletionItems(document, position, token));
        }

        return items;
    }
}

interface RObjectElement {
    name: string;
    type: string;
    str: string;
}

function getCompletionItemsFromElements(elements: RObjectElement[], detail: string): vscode.CompletionItem[] {
    const len = elements.length.toString().length;
    let index = 0;
    return elements.map((e) => {
        const item = new vscode.CompletionItem(e.name, (e.type === 'closure' || e.type === 'builtin') ? CompletionItemKind.Function : vscode.CompletionItemKind.Variable);
        item.detail = detail;
        item.documentation = new vscode.MarkdownString(`\`\`\`r\n${e.str}\n\`\`\``);
        item.sortText = `0-${index.toString().padStart(len, '0')}`;
        index++;
        return item;
    });
}

function getCompletionItems(names: string[], kind: vscode.CompletionItemKind, detail: string, documentation: vscode.MarkdownString): vscode.CompletionItem[] {
    const len = names.length.toString().length;
    let index = 0;
    return names.map((name) => {
        const item = new vscode.CompletionItem(name, kind);
        item.detail = detail;
        item.documentation = documentation;
        item.sortText = `0-${index.toString().padStart(len, '0')}`;
        index++;
        return item;
    });
}

function getBracketCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    let range: vscode.Range | undefined = new vscode.Range(new vscode.Position(position.line, 0), position);
    let expectOpenBrackets = 0;
    let symbol: string | undefined = undefined;

    while (range) {
        if (token.isCancellationRequested) { return []; }
        const text = document.getText(range);
        for (let i = text.length - 1; i >= 0; i -= 1) {
            const chr = text.charAt(i);
            if (chr === ']') {
                expectOpenBrackets += 1;
            } else if (chr === '[') {
                if (expectOpenBrackets === 0) {
                    const symbolPosition = new vscode.Position(range.start.line, i - 1);
                    const symbolRange = document.getWordRangeAtPosition(symbolPosition);
                    symbol = document.getText(symbolRange);
                    range = undefined;
                    break;
                } else {
                    expectOpenBrackets -= 1;
                }
            }
        }
        if (range?.start?.line !== undefined && range.start.line > 0) {
            range = document.lineAt(range.start.line - 1).range; // check previous line
        } else {
            range = undefined;
        }
    }

    if (!token.isCancellationRequested && symbol !== undefined) {
        const obj = session.workspaceData.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            items.push(...getCompletionItems(obj.names, vscode.CompletionItemKind.Variable, '[session]', doc));
        }
    }
    return items;
}

function getPipelineCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const range = extendSelection(position.line, (x) => document.lineAt(x).text, document.lineCount);
    let symbol: string | undefined = undefined;

    for (let i = range.startLine; i <= range.endLine; i++) {
        if (token.isCancellationRequested) {
            break;
        }

        const line = document.lineAt(i);
        if (line.isEmptyOrWhitespace) {
            continue;
        }

        const cleanedLine = cleanLine(line.text);
        if (cleanedLine.length === 0) {
            continue;
        }

        const pipeSymbolIndex = line.text.search(/([\w_.]+)\s*(%.+%|\|>)/);
        if (pipeSymbolIndex < 0) {
            break;
        }

        const symbolPosition = new vscode.Position(i, pipeSymbolIndex);
        const symbolRange = document.getWordRangeAtPosition(symbolPosition);

        if (symbolRange !== undefined) {
            symbol = document.getText(symbolRange);
        }

        break;
    }

    if (!token.isCancellationRequested && symbol !== undefined) {
        const obj = session.workspaceData.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            items.push(...getCompletionItems(obj.names, vscode.CompletionItemKind.Variable, '[session]', doc));
        }
    }
    return items;
}
