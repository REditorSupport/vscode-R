import * as vscode from 'vscode';
import { sessionForDocument } from './session';
import { getChunks } from './rmarkdown';

interface Token {
    text: string;
    start: number;
    end: number;
    name?: string;
}
interface Call {
    name: string;
    label: string;
    arguments: string[];
}

/** Only lexical structure is needed. Never evaluate a call or its default arguments. */
function tokens(text: string): Token[] {
    const result: Token[] = [];
    for (let i = 0; i < text.length;) {
        const start = i,
            char = text[i];
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        if (char === '#') {
            const end = text.indexOf('\n', i);
            i = end < 0 ? text.length : end + 1;
            continue;
        }
        const raw = /^[rR](["'])(-*)([([{])/.exec(text.slice(i));
        if (raw) {
            const closing = ')]}'['([{'.indexOf(raw[3])];
            const delimiter = `${closing}${raw[2]}${raw[1]}`;
            const end = text.indexOf(delimiter, i + raw[0].length);
            i = end < 0 ? text.length : end + delimiter.length;
        } else if ('"\'`'.includes(char)) {
            i++;
            while (i < text.length) {
                if (text[i] === '\\') {
                    i += 2;
                } else if (text[i++] === char) {
                    break;
                }
            }
            if (char === '`' && text[i - 1] === '`') {
                result.push({
                    text: text.slice(start, i),
                    start,
                    end: i,
                    name: text.slice(start + 1, i - 1).replace(/\\([\\`])/g, '$1'),
                });
                continue;
            }
        } else {
            const name = /^[\p{L}_.][\p{L}\p{N}._]*/u.exec(text.slice(i))?.[0];
            if (name) {
                i += name.length;
                result.push({ text: name, name, start, end: i });
                continue;
            }
            i++;
        }
        result.push({ text: text.slice(start, i), start, end: i });
    }
    return result;
}

function openCall(text: string): Call | undefined {
    const stack: {
        bracket: string;
        name?: string;
        label: string;
        start: number;
        arguments: string[];
    }[] = [];
    const parsed = tokens(text);
    for (let i = 0; i < parsed.length; i++) {
        const token = parsed[i];
        if (['(', '[', '{'].includes(token.text)) {
            const previous = parsed[i - 1];
            const accessor = parsed[i - 2]?.text;
            stack.push({
                bracket: token.text,
                start: token.end,
                arguments: [],
                label: previous?.text ?? '',
                name:
                    token.text === '(' && !['$', '@', ':'].includes(accessor)
                        ? previous?.name
                        : undefined,
            });
        } else if ([')', ']', '}'].includes(token.text)) {
            const frame = stack.pop();
            if (!frame || '([{'.indexOf(frame.bracket) !== ')]}'.indexOf(token.text)) {
                return;
            }
        } else if (token.text === ',') {
            const frame = stack.at(-1);
            if (frame) {
                frame.arguments.push(text.slice(frame.start, token.start));
                frame.start = token.end;
            }
        }
    }
    const frame = stack.at(-1);
    if (frame?.bracket === '(' && frame.name) {
        return {
            name: frame.name,
            label: frame.label,
            arguments: [...frame.arguments, text.slice(frame.start)],
        };
    }
}

export interface LiveSignature {
    label: string;
    parameters: [number, number][];
    activeParameter: number;
}

export function liveSignature(
    text: string,
    summaries: Record<string, { type: string; str: string }>,
): LiveSignature | undefined {
    const call = openCall(text);
    const summary = call && summaries[call.name];
    if (!call || !summary || !['closure', 'builtin'].includes(summary.type)) {
        return;
    }
    const prefix = /^function\s*\(/.exec(summary.str);
    if (!prefix) {
        return;
    }
    const parsed = tokens(summary.str);
    const parameters: string[] = [];
    let depth = 0,
        start = prefix[0].length,
        end: number | undefined;
    for (const token of parsed) {
        if (['(', '[', '{'].includes(token.text)) {
            depth++;
        } else if ([')', ']', '}'].includes(token.text)) {
            if (--depth === 0) {
                end = token.start;
                break;
            }
        } else if (token.text === ',' && depth === 1) {
            parameters.push(summary.str.slice(start, token.start).trim());
            start = token.end;
        }
    }
    if (end === undefined) {
        return;
    } // str() can truncate long signatures; let languageserver handle those.
    const last = summary.str.slice(start, end).trim();
    if (last) {
        parameters.push(last);
    }
    const names = parameters.map((parameter) => tokens(parameter)[0]?.name);
    const dots = names.indexOf('...');
    const assigned = new Set<number>();
    const matched = call.arguments.map((argument) => {
        const parts = tokens(argument);
        return parts[0]?.name && parts[1]?.text === '=' && parts[2]?.text !== '='
            ? parts[0].name
            : undefined;
    });
    const positions = matched.map((name) => {
        const index = name === undefined ? -1 : names.indexOf(name);
        if (index >= 0) {
            assigned.add(index);
        }
        return index;
    });
    // R matches exact names, then unique partial names before ..., then positional arguments.
    matched.forEach((name, i) => {
        if (name === undefined || positions[i] >= 0) {
            return;
        }
        const matches = names.flatMap((parameter, index) =>
            parameter?.startsWith(name) && !assigned.has(index) && (dots < 0 || index < dots)
                ? [index]
                : [],
        );
        if (matches.length === 1) {
            positions[i] = matches[0];
            assigned.add(matches[0]);
        } else {
            positions[i] = dots;
        }
    });
    let positional = 0;
    matched.forEach((name, i) => {
        if (name !== undefined) {
            return;
        }
        while (assigned.has(positional)) {
            positional++;
        }
        positions[i] = dots >= 0 && positional >= dots ? dots : positional++;
    });
    const label = `${call.label}(${parameters.join(', ')})`;
    let offset = call.label.length + 1;
    return {
        label,
        activeParameter: Math.max(0, Math.min(positions.at(-1) ?? 0, parameters.length - 1)),
        parameters: parameters.map((parameter) => {
            const range: [number, number] = [offset, offset + parameter.length];
            offset += parameter.length + 2;
            return range;
        }),
    };
}

export class SessionSignatureHelpProvider implements vscode.SignatureHelpProvider {
    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.SignatureHelp | undefined {
        if (!['r', 'rmd'].includes(document.languageId)) {
            return;
        }
        const target = sessionForDocument(document.uri);
        if (token.isCancellationRequested || !target || target.workspaceUnavailable) {
            return;
        }
        let start = new vscode.Position(0, 0);
        if (document.languageId === 'rmd') {
            const chunk = getChunks(document).find(
                (chunk) =>
                    chunk.language === 'r' &&
                    chunk.startLine < position.line &&
                    chunk.endLine > position.line,
            );
            if (!chunk) {
                return;
            }
            start = new vscode.Position(chunk.startLine + 1, 0);
        }
        const text = document.getText(new vscode.Range(start, position));
        if (text.length > 200000) {
            return;
        }
        const live = liveSignature(text, target.workspaceData.globalenv);
        if (!live) {
            return;
        }
        const help = new vscode.SignatureHelp();
        const signature = new vscode.SignatureInformation(live.label, 'Function in this R session');
        signature.parameters = live.parameters.map(
            (range) => new vscode.ParameterInformation(range),
        );
        help.signatures = [signature];
        help.activeSignature = 0;
        help.activeParameter = live.activeParameter;
        return help;
    }
}
