'use strict';
import * as vscode from 'vscode';

import * as session from './session';
import { PipelineSourceCache } from './pipelineCompletion';
import { withRpcCancellation } from './nativeRpc';
import { globalRHelp } from './extension';
import { config } from './util';
import { getChunks } from './rmarkdown';
import { CompletionItemKind } from 'vscode-languageclient';

// Get with names(roxygen2:::default_tags())
const roxygenTagCompletionItems = [
    'export',
    'exportClass',
    'exportMethod',
    'exportPattern',
    'import',
    'importClassesFrom',
    'importFrom',
    'importMethodsFrom',
    'rawNamespace',
    'S3method',
    'useDynLib',
    'aliases',
    'author',
    'backref',
    'concept',
    'describeIn',
    'description',
    'details',
    'docType',
    'encoding',
    'evalRd',
    'example',
    'examples',
    'family',
    'field',
    'format',
    'inherit',
    'inheritParams',
    'inheritDotParams',
    'inheritSection',
    'keywords',
    'method',
    'name',
    'md',
    'noMd',
    'noRd',
    'note',
    'param',
    'rdname',
    'rawRd',
    'references',
    'return',
    'section',
    'seealso',
    'slot',
    'source',
    'template',
    'templateVar',
    'title',
    'usage',
].map((x: string) => new vscode.CompletionItem(`${x} `));

async function cancellableSessionRequest(
    data: Record<string, unknown>,
    target: session.Session,
    token?: vscode.CancellationToken,
): Promise<unknown> {
    if (!token) {
        return session.sessionRequest(data, target);
    }
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) {
        controller.abort();
    }
    try {
        return await session.sessionRequest(data, target, { signal: controller.signal });
    } finally {
        cancellation.dispose();
    }
}

async function ensureWorkspace(
    target: session.Session,
    token?: vscode.CancellationToken,
): Promise<boolean> {
    const controller = token && new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller?.abort());
    if (token?.isCancellationRequested) {
        controller?.abort();
    }
    try {
        await withRpcCancellation(() => session.ensureSessionWorkspace(target), controller?.signal);
        return !token?.isCancellationRequested;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return false;
        }
        throw error;
    } finally {
        cancellation?.dispose();
    }
}

export class HoverProvider implements vscode.HoverProvider {
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): Promise<vscode.Hover | null> {
        if (token?.isCancellationRequested) {
            return null;
        }
        const version = document.version;
        const target = session.sessionForDocument(document.uri);
        if (!target?.workspaceData?.globalenv) {
            return null;
        }

        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find(
                (chunk) =>
                    chunk.language === 'r' &&
                    chunk.startLine < position.line &&
                    chunk.endLine > position.line,
            );
            if (!chunk) {
                return null;
            }
        }

        let hoverRange = document.getWordRangeAtPosition(position);
        if (!hoverRange || target.workspaceUnavailable) {
            return null;
        }
        let hoverText = null;

        const symbol = document.getText(hoverRange);
        const prefix = document
            .lineAt(position.line)
            .text.slice(0, hoverRange.start.character)
            .trimEnd();
        // Workspace snapshots already contain simple-symbol summaries and function
        // formals. Use those while R is busy, and avoid an IPC round trip on every hover.
        const functionHover = (): vscode.Hover | undefined => {
            const cached = /[$@:]/.test(prefix.slice(-1))
                ? undefined
                : target.workspaceData.globalenv[symbol];
            if (cached && ['closure', 'builtin'].includes(cached.type)) {
                return new vscode.Hover(
                    new vscode.MarkdownString().appendCodeblock(cached.str, 'r'),
                    hoverRange,
                );
            }
        };
        const immediate = functionHover();
        if (immediate) {
            return immediate;
        }
        if (
            !(await ensureWorkspace(target, token)) ||
            document.version !== version ||
            session.sessionForDocument(document.uri) !== target
        ) {
            return null;
        }
        const refreshed = functionHover();
        if (refreshed) {
            return refreshed;
        }

        if (session.globalPipePath || target.requester) {
            const exprRegex = /([a-zA-Z0-9._$@ ])+(?<![@$])/;
            hoverRange = document
                .getWordRangeAtPosition(position, exprRegex)
                ?.with({ end: hoverRange?.end });
            if (!hoverRange) {
                return null;
            }
            const expr = document.getText(hoverRange);
            const response = (await cancellableSessionRequest(
                {
                    method: 'hover',
                    params: { expr: expr },
                },
                target,
                token,
            )) as { str: string };

            if (
                token?.isCancellationRequested ||
                document.version !== version ||
                session.sessionForDocument(document.uri) !== target
            ) {
                return null;
            }
            if (response) {
                hoverText = response.str;
            }
        } else {
            const symbol = document.getText(hoverRange);
            const str = target.workspaceData.globalenv[symbol]?.str;

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
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        cancellation?: vscode.CancellationToken,
    ): Promise<vscode.Hover | null> {
        if (
            cancellation?.isCancellationRequested ||
            !config().get<boolean>('helpPanel.enableHoverLinks')
        ) {
            return null;
        }

        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find(
                (chunk) =>
                    chunk.language === 'r' &&
                    chunk.startLine < position.line &&
                    chunk.endLine > position.line,
            );
            if (!chunk) {
                return null;
            }
        }

        const re = /([a-zA-Z0-9._:])+/;
        const wordRange = document.getWordRangeAtPosition(position, re);
        if (!wordRange) {
            return null;
        }
        const version = document.version;
        const token = document.getText(wordRange);
        const aliases = (await globalRHelp?.getMatchingAliases(token)) || [];
        if (
            !aliases.length ||
            cancellation?.isCancellationRequested ||
            document.isClosed ||
            document.version !== version
        ) {
            return null;
        }
        const mds = aliases.map((a) => {
            const cmdText = `${a.package}::${a.alias}`;
            const args = [`/library/${a.package}/html/${a.name}.html`];
            const encodedArgs = encodeURIComponent(JSON.stringify(args));
            const cmd = 'command:r.helpPanel.openForPath';
            const cmdUri = vscode.Uri.parse(`${cmd}?${encodedArgs}`);
            return `[\`${cmdText}\`](${cmdUri.toString()})`;
        });
        const md = new vscode.MarkdownString(mds.join('  \n'));
        md.isTrusted = true;
        return new vscode.Hover(md, wordRange);
    }
}

export class StaticCompletionItemProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find(
                (chunk) =>
                    chunk.language === 'r' &&
                    chunk.startLine < position.line &&
                    chunk.endLine > position.line,
            );
            if (!chunk) {
                return undefined;
            }
        }

        if (document.lineAt(position).text.startsWith("#'")) {
            return roxygenTagCompletionItems;
        }

        return undefined;
    }
}

export class LiveCompletionItemProvider implements vscode.CompletionItemProvider {
    private readonly pipelineSources = new WeakMap<vscode.TextDocument, PipelineSourceCache>();

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        completionContext: vscode.CompletionContext,
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        const version = document.version;
        const activeSession = session.sessionForDocument(document.uri);
        if (token.isCancellationRequested || !activeSession?.workspaceData?.globalenv) {
            return items;
        }

        let codeStartLine = 0;
        if (document.languageId === 'rmd') {
            const chunks = getChunks(document);
            const chunk = chunks.find(
                (chunk) =>
                    chunk.language === 'r' &&
                    chunk.startLine < position.line &&
                    chunk.endLine > position.line,
            );
            if (!chunk) {
                return items;
            }
            codeStartLine = chunk.startLine + 1;
        }

        // Existing metadata stays usable while R is busy. The document lookup
        // starts dirty refreshes in the background; only an empty cache must wait.
        if (!Object.keys(activeSession.workspaceData.globalenv).length) {
            if (
                !(await ensureWorkspace(activeSession, token)) ||
                document.version !== version ||
                session.sessionForDocument(document.uri) !== activeSession
            ) {
                return items;
            }
        }
        const trigger = completionContext.triggerCharacter;

        if (trigger === undefined) {
            const globalenv: session.GlobalEnv = activeSession.workspaceData.globalenv;
            Object.keys(globalenv).forEach((key) => {
                const obj = globalenv[key];
                const item = new vscode.CompletionItem(
                    key,
                    obj.type === 'closure' || obj.type === 'builtin'
                        ? vscode.CompletionItemKind.Function
                        : vscode.CompletionItemKind.Field,
                );
                item.detail = '[session]';
                item.documentation = new vscode.MarkdownString(`\`\`\`r\n${obj.str}\n\`\`\``);
                items.push(item);
            });
        } else if (trigger === '$' || trigger === '@') {
            const symbolPosition = new vscode.Position(position.line, position.character - 1);
            if (session.globalPipePath || activeSession.requester) {
                const re = /([a-zA-Z0-9._$@ ])+(?<![@$])/;
                const exprRange = document
                    .getWordRangeAtPosition(symbolPosition, re)
                    ?.with({ end: symbolPosition });
                if (exprRange) {
                    const expr = document.getText(exprRange);
                    const response = (await cancellableSessionRequest(
                        {
                            method: 'completion',
                            params: { expr: expr, trigger: trigger },
                        },
                        activeSession,
                        token,
                    )) as RObjectElement[];

                    if (response) {
                        items.push(...getCompletionItemsFromElements(response, '[session]'));
                    }
                }
            } else {
                const symbolRange = document.getWordRangeAtPosition(symbolPosition);
                const symbol = document.getText(symbolRange);
                const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
                const obj = activeSession.workspaceData.globalenv[symbol];
                let names: string[] | undefined;
                if (obj !== undefined) {
                    if (completionContext.triggerCharacter === '$') {
                        names = obj.names;
                    } else if (completionContext.triggerCharacter === '@') {
                        names = obj.slots;
                    }
                }

                if (names) {
                    items.push(
                        ...getCompletionItems(
                            names,
                            vscode.CompletionItemKind.Variable,
                            '[session]',
                            doc,
                        ),
                    );
                }
            }
        }

        if (
            trigger === undefined ||
            trigger === '[' ||
            trigger === ',' ||
            trigger === '"' ||
            trigger === "'"
        ) {
            items.push(...getBracketCompletionItems(document, position, token, activeSession));
        }

        if (trigger === undefined || trigger === '(' || trigger === ',') {
            let cache = this.pipelineSources.get(document);
            if (!cache) {
                cache = new PipelineSourceCache();
                this.pipelineSources.set(document, cache);
            }
            items.push(
                ...(await getPipelineCompletionItems(
                    document,
                    position,
                    token,
                    activeSession,
                    codeStartLine,
                    cache,
                )),
            );
        }

        return token.isCancellationRequested ||
            document.version !== version ||
            session.sessionForDocument(document.uri) !== activeSession
            ? []
            : items;
    }
}

interface RObjectElement {
    name: string;
    type: string;
    str: string;
}

function getCompletionItemsFromElements(
    elements: RObjectElement[],
    detail: string,
): vscode.CompletionItem[] {
    const len = elements.length.toString().length;
    let index = 0;
    return elements.map((e) => {
        const item = new vscode.CompletionItem(
            e.name,
            e.type === 'closure' || e.type === 'builtin'
                ? CompletionItemKind.Function
                : vscode.CompletionItemKind.Variable,
        );
        item.detail = detail;
        item.documentation = new vscode.MarkdownString(`\`\`\`r\n${e.str}\n\`\`\``);
        item.sortText = `0-${index.toString().padStart(len, '0')}`;
        index++;
        return item;
    });
}

function getCompletionItems(
    names: string[],
    kind: vscode.CompletionItemKind,
    detail: string,
    documentation: vscode.MarkdownString,
): vscode.CompletionItem[] {
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

function getBracketCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    activeSession: session.Session,
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    let range: vscode.Range | undefined = new vscode.Range(
        new vscode.Position(position.line, 0),
        position,
    );
    let expectOpenBrackets = 0;
    let symbol: string | undefined = undefined;

    while (range) {
        if (token.isCancellationRequested) {
            return [];
        }
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
        const obj = activeSession.workspaceData.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            items.push(
                ...getCompletionItems(
                    obj.names,
                    vscode.CompletionItemKind.Variable,
                    '[session]',
                    doc,
                ),
            );
        }
    }
    return items;
}

async function getPipelineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    activeSession: session.Session,
    startLine: number,
    cache: PipelineSourceCache,
): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];
    if (token.isCancellationRequested) {
        return items;
    }
    const version = document.version;
    const text = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
    const symbol = await cache.resolve(
        text,
        () => token.isCancellationRequested || document.version !== version,
    );

    if (!token.isCancellationRequested && document.version === version && symbol !== undefined) {
        const obj = activeSession.workspaceData.globalenv[symbol];
        if (obj !== undefined && obj.names !== undefined) {
            const doc = new vscode.MarkdownString('Element of `' + symbol + '`');
            items.push(
                ...getCompletionItems(
                    obj.names,
                    vscode.CompletionItemKind.Variable,
                    '[session]',
                    doc,
                ),
            );
        }
    }
    return items;
}
