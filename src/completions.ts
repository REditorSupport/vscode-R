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
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover {
        if(!session.globalenv){
            return null;
        }
        const wordRange = document.getWordRangeAtPosition(position);
        const text = document.getText(wordRange);
        return new vscode.Hover(`\`\`\`\n${session.globalenv[text].str}\n\`\`\``);
    }
}

export class HelpLinkHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover> {
        if(!config().get<boolean>('helpPanel.enableHoverLinks')){
            return null;
        }
        const re = /([a-zA-Z0-9._:])+/;
        const wordRange = document.getWordRangeAtPosition(position, re);
        const token = document.getText(wordRange);
        const aliases = await globalRHelp?.getMatchingAliases(token) || [];
        const mds = aliases.map(a => {
            const cmdText = `${a.package}::${a.name}`;
            const args = [`/library/${a.package}/html/${a.alias}.html`];
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
        if (document.lineAt(position).text
                    .substr(0, 2) === '#\'') {
            return roxygenTagCompletionItems;
        }

        return undefined;
    }
}


export class LiveCompletionItemProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        completionContext: vscode.CompletionContext
    ): vscode.CompletionItem[] {
        const items = [];
        if (token.isCancellationRequested) {
            return items;
        }

        const trigger = completionContext.triggerCharacter;

        if (trigger === undefined) {
            Object.keys(session.globalenv).map((key) => {
                const obj = session.globalenv[key];
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
            const symbolRange = document.getWordRangeAtPosition(symbolPosition);
            const symbol = document.getText(symbolRange);
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            const obj = session.globalenv[symbol];
            let elements: string[];
            if (obj !== undefined) {
                if (completionContext.triggerCharacter === '$') {
                    elements = obj.names;
                } else if (completionContext.triggerCharacter === '@') {
                    elements = obj.slots;
                }
            }
            elements.map((key) => {
                const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
                item.detail = '[session]';
                item.documentation = doc;
                items.push(item);
            });
        }

        if (trigger === undefined || trigger === '[' || trigger === ',' || trigger === '"' || trigger === '\'') {
            const bracketItems = getBracketCompletionItems(document, position, token);
            items.push(...bracketItems);
        }

        if (trigger === undefined || trigger === '(' || trigger === ',') {
            const pipelineItems = getPipelineCompletionItems(document, position, token);
            items.push(...pipelineItems);
        }

        return items;
    }
}


function getBracketCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
    const items: vscode.CompletionItem[] = [];
    let range = new vscode.Range(new vscode.Position(position.line, 0), position);
    let expectOpenBrackets = 0;
    let symbol: string;

    while (range) {
        if (token.isCancellationRequested) { return; }
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
        if (range?.start.line > 0) {
            range = document.lineAt(range.start.line - 1).range; // check previous line
        } else {
            range = undefined;
        }
    }

    if (!token.isCancellationRequested && symbol !== undefined) {
        const obj = session.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            obj.names.map((name: string) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
                item.detail = '[session]';
                item.documentation = doc;
                items.push(item);
            });
        }
    }
    return items;
}

function getPipelineCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
    const items: vscode.CompletionItem[] = [];
    const range = extendSelection(position.line, (x) => document.lineAt(x).text, document.lineCount);
    let symbol: string;

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
        const obj = session.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            obj.names.map((name: string) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
                item.detail = '[session]';
                item.documentation = doc;
                items.push(item);
            });
        }
    }
    return items;
}
