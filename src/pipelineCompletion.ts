interface Token {
    text: string;
    symbol?: string;
}

interface Expression {
    source?: string;
    // null denotes a pipeline whose source cannot be resolved. It must not
    // inherit suggestions from a surrounding pipeline.
    pipeline?: string | null;
}

interface ScanContext {
    offset: number;
    tokens: Token[];
    brackets: { close: string; contentStart: number }[];
    previous?: string;
}

interface ScanResult {
    tokens?: Token[];
    checkpoint: ScanContext;
}

const scanQuantum = 8192;
const maxExpressionTokens = 4096;
const emptyContext = (): ScanContext => ({ offset: 0, tokens: [], brackets: [] });
const copyContext = (context: ScanContext): ScanContext => ({
    ...context,
    tokens: [...context.tokens],
    brackets: context.brackets.map((bracket) => ({ ...bracket })),
});

const pipes = new Set(['|>', '%>%', '%<>%', '%T>%', '%$%']);
const precedence = new Map([
    ['?', 1],
    ['=', 2],
    ['<-', 3],
    ['<<-', 3],
    ['->', 4],
    ['->>', 4],
    ['~', 5],
    ['||', 6],
    ['|', 6],
    ['&&', 7],
    ['&', 7],
    ['<', 9],
    ['>', 9],
    ['<=', 9],
    ['>=', 9],
    ['==', 9],
    ['!=', 9],
    ['+', 10],
    ['-', 10],
    ['*', 11],
    ['/', 11],
    ['|>', 12],
    [':', 13],
    ['^', 15],
    ['$', 16],
    ['@', 16],
    ['::', 17],
    [':::', 17],
]);

function binding(operator: string | undefined): number | undefined {
    return operator?.startsWith('%') ? 12 : precedence.get(operator ?? '');
}

function* tokenize(
    text: string,
    initial = emptyContext(),
    canceled = () => false,
): Generator<void, ScanResult | undefined> {
    const context = copyContext(initial);
    const tokens = context.tokens;
    let checkpoint = initial;
    let nextYield = initial.offset + scanQuantum;
    const unknown = () => ({ checkpoint });
    for (let i = initial.offset; i < text.length;) {
        if (i >= nextYield) {
            yield;
            nextYield = i + scanQuantum;
        }
        if (canceled()) {
            return undefined;
        }
        const tokenStart = tokens.length;
        const rest = text.slice(i);
        const char = text[i];
        if (char === '\n') {
            tokens.push({ text: '\n' });
            i++;
        } else if (/\s/.test(char)) {
            i++;
        } else if (char === '#') {
            const end = text.indexOf('\n', i);
            if (end < 0) {
                return unknown();
            }
            i = end;
        } else {
            const raw = /^[rR](["'])(-*)([([{])/.exec(rest);
            if (raw) {
                const close = { '(': ')', '[': ']', '{': '}' }[raw[3]];
                const ending = close + raw[2] + raw[1];
                const end = text.indexOf(ending, i + raw[0].length);
                if (end < 0) {
                    return unknown();
                }
                tokens.push({ text: 'literal' });
                i = end + ending.length;
            } else if (char === '"' || char === "'" || char === '`') {
                let end = i + 1;
                let symbol = '';
                while (end < text.length && text[end] !== char) {
                    if (end >= nextYield) {
                        yield;
                        nextYield = end + scanQuantum;
                        if (canceled()) {
                            return undefined;
                        }
                    }
                    if (text[end] === '\\') {
                        end++;
                        const escaped = text[end];
                        const escapes: Record<string, string> = {
                            a: '\x07',
                            b: '\b',
                            f: '\f',
                            n: '\n',
                            r: '\r',
                            t: '\t',
                            v: '\v',
                        };
                        const encoded =
                            /^(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|u\{([\da-fA-F]{1,4})\}|U\{([\da-fA-F]{1,8})\}|([0-7]{1,3}))/.exec(
                                text.slice(end),
                            );
                        if (encoded) {
                            const digits = encoded.slice(1).find((value) => value !== undefined)!;
                            const value = parseInt(digits, encoded[6] ? 8 : 16);
                            if (value === 0 || value > 0x10ffff) {
                                return unknown();
                            }
                            symbol += String.fromCodePoint(value);
                            end += encoded[0].length - 1;
                        } else if (escaped in escapes || ['\\', '`', '"', "'"].includes(escaped)) {
                            symbol += escapes[escaped] ?? escaped;
                        } else {
                            return unknown();
                        }
                    } else {
                        symbol += text[end];
                    }
                    end++;
                }
                if (end >= text.length) {
                    return unknown();
                }
                tokens.push(char === '`' ? { text: 'symbol', symbol } : { text: 'literal' });
                i = end + 1;
            } else {
                const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[Li]?/.exec(rest);
                const name = /^[\p{L}._][\p{L}\p{N}._]*/u.exec(rest);
                const operator =
                    /^(?:%[^%\n]*%|:::|::|<<-|->>|<-|->|\|>|\|\||&&|<=|>=|==|!=|\[\[)/.exec(rest);
                if (number) {
                    tokens.push({ text: 'literal' });
                    i += number[0].length;
                } else if (name) {
                    tokens.push({ text: 'symbol', symbol: name[0] });
                    i += name[0].length;
                } else if (operator) {
                    tokens.push({ text: operator[0] });
                    i += operator[0].length;
                } else {
                    tokens.push({ text: char });
                    i++;
                }
            }
        }
        if (tokens.length === tokenStart) {
            continue;
        }
        const token = tokens[tokens.length - 1].text;
        const close = { '(': ')', '[': ']', '[[': ']]', '{': '}' }[token];
        if (close) {
            context.brackets.push({ close, contentStart: tokens.length });
        } else if ([')', ']', '}'].includes(token)) {
            const bracket = context.brackets.at(-1);
            if (token === ']' && bracket?.close === ']]') {
                bracket.close = ']';
            } else if (bracket?.close === token) {
                context.brackets.pop();
            }
        }
        const bracket = context.brackets.at(-1);
        // Completed statements and earlier call arguments cannot supply the
        // active pipeline. Retain their enclosing expression, not their contents.
        const boundary =
            token === ';' ||
            token === ',' ||
            (token === '\n' &&
                binding(context.previous) === undefined &&
                (!bracket || bracket.close === '}'));
        if (token !== '\n') {
            context.previous = token;
        }
        if (boundary) {
            tokens.length = bracket?.contentStart ?? 0;
            context.offset = i;
            checkpoint = copyContext(context);
        }
        if (context.brackets.length > 128) {
            return unknown();
        }
    }
    return { tokens, checkpoint };
}

/**
 * Recover a pipeline's initial session symbol from the code before the cursor.
 * Only expression structure is inspected: calls, members and computed values
 * are never evaluated. Incomplete calls and grouping are expected while typing.
 */
export function getPipelineSource(text: string, canceled = () => false): string | undefined {
    if (canceled()) {
        return undefined;
    }
    const scan = tokenize(text, emptyContext(), canceled);
    let result = scan.next();
    while (!result.done) {
        result = scan.next();
    }
    return result.value?.tokens ? resolveTokens(result.value.tokens, canceled) : undefined;
}

function resolveTokens(tokens: Token[], canceled: () => boolean): string | undefined {
    if (
        canceled() ||
        tokens.length > maxExpressionTokens ||
        !tokens.some((token) => pipes.has(token.text))
    ) {
        return undefined;
    }
    let index = 0;
    let depth = 0;
    const current = () => tokens[index]?.text;
    const skipNewlines = () => {
        while (current() === '\n') {
            index++;
        }
    };

    function sequence(close?: string, continuation = false): Expression {
        let result: Expression = {};
        while (index < tokens.length && current() !== close) {
            if (canceled()) {
                return { pipeline: null };
            }
            if (current() === '\n' || current() === ';' || current() === ',') {
                index++;
                result = {};
                continue;
            }
            const start = index;
            result = expression(0, continuation);
            if (index === start) {
                index++;
            }
        }
        return result;
    }

    function expression(minimum: number, continuation: boolean): Expression {
        // Bound recovery for malformed or deeply nested editor input.
        if (++depth > 128 || canceled()) {
            index = tokens.length;
            depth--;
            return { pipeline: null };
        }
        skipNewlines();
        const token = tokens[index++];
        let left: Expression = {};
        if (token?.symbol !== undefined) {
            left.source = token.symbol;
        } else if (token?.text === '(' || token?.text === '{') {
            const close = token.text === '(' ? ')' : '}';
            left = sequence(close, token.text === '(');
            if (current() === close) {
                index++;
                left.pipeline = undefined;
            }
            if (token.text === '{') {
                left.source = undefined;
            }
        } else if (token && ['+', '-', '!', '~', '?'].includes(token.text)) {
            left = expression(token.text === '!' ? 8 : token.text === '~' ? 5 : 14, continuation);
            left.source = undefined;
        }

        while (index < tokens.length) {
            if (canceled()) {
                return { pipeline: null };
            }
            if (current() === '\n' && continuation) {
                let next = index;
                while (tokens[next]?.text === '\n') {
                    next++;
                }
                if (binding(tokens[next]?.text) !== undefined) {
                    index = next;
                }
            }
            const operator = current();
            if (operator === '(' || operator === '[' || operator === '[[') {
                if (18 < minimum) {
                    break;
                }
                index++;
                const close = operator === '(' ? ')' : ']';
                const args = sequence(close, true);
                if (current() === close) {
                    index++;
                    if (operator === '[[' && current() === ']') {
                        index++;
                    }
                    left = {};
                } else {
                    left = { pipeline: args.pipeline };
                }
                continue;
            }
            const power = binding(operator);
            if (power === undefined || power < minimum) {
                break;
            }
            index++;
            const right = expression(
                power + (['^', '<-', '<<-', '='].includes(operator!) ? 0 : 1),
                continuation,
            );
            if (pipes.has(operator!)) {
                // A nested magrittr pipeline can start from the surrounding
                // pipeline's dot placeholder rather than another session object.
                const pipeline =
                    right.pipeline === '.' && ['%>%', '%<>%', '%T>%'].includes(operator!)
                        ? (left.source ?? null)
                        : right.pipeline;
                left = {
                    source: left.source,
                    pipeline: pipeline !== undefined ? pipeline : (left.source ?? null),
                };
            } else {
                left = { pipeline: right.pipeline };
            }
        }
        depth--;
        return left;
    }

    const source = sequence().pipeline;
    return canceled() ? undefined : (source ?? undefined);
}

/**
 * Cache only an unchanged lexical prefix and its enclosing pipeline context.
 * Edits before that prefix or cursor moves into it restart the scan. The cold
 * scan yields between chunks; source resolution is bounded to 4096 retained
 * tokens and deliberately does not perform general R analysis or evaluation.
 */
export class PipelineSourceCache {
    private prefix = '';
    private checkpoint = emptyContext();
    private request = 0;

    async resolve(text: string, canceled = () => false): Promise<string | undefined> {
        const request = ++this.request;
        if (canceled()) {
            return undefined;
        }
        const initial = text.startsWith(this.prefix) ? this.checkpoint : emptyContext();
        const scan = tokenize(text, initial, canceled);
        let result = scan.next();
        while (!result.done) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (canceled()) {
                return undefined;
            }
            result = scan.next();
        }
        if (!result.value || canceled()) {
            return undefined;
        }
        if (request === this.request) {
            this.checkpoint = result.value.checkpoint;
            this.prefix = text.slice(0, this.checkpoint.offset);
        }
        return result.value.tokens ? resolveTokens(result.value.tokens, canceled) : undefined;
    }
}
