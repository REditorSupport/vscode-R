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

function tokenize(text: string): Token[] | undefined {
    const tokens: Token[] = [];
    for (let i = 0; i < text.length;) {
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
                return undefined;
            }
            i = end;
        } else {
            const raw = /^[rR](["'])(-*)([([{])/.exec(rest);
            if (raw) {
                const close = { '(': ')', '[': ']', '{': '}' }[raw[3]];
                const ending = close + raw[2] + raw[1];
                const end = text.indexOf(ending, i + raw[0].length);
                if (end < 0) {
                    return undefined;
                }
                tokens.push({ text: 'literal' });
                i = end + ending.length;
            } else if (char === '"' || char === "'" || char === '`') {
                let end = i + 1;
                let symbol = '';
                while (end < text.length && text[end] !== char) {
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
                                return undefined;
                            }
                            symbol += String.fromCodePoint(value);
                            end += encoded[0].length - 1;
                        } else if (escaped in escapes || ['\\', '`', '"', "'"].includes(escaped)) {
                            symbol += escapes[escaped] ?? escaped;
                        } else {
                            return undefined;
                        }
                    } else {
                        symbol += text[end];
                    }
                    end++;
                }
                if (end >= text.length) {
                    return undefined;
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
    }
    return tokens;
}

/**
 * Recover a pipeline's initial session symbol from the code before the cursor.
 * Only expression structure is inspected: calls, members and computed values
 * are never evaluated. Incomplete calls and grouping are expected while typing.
 */
export function getPipelineSource(text: string): string | undefined {
    const tokens = tokenize(text);
    if (!tokens) {
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
    const binding = (operator: string | undefined) =>
        operator?.startsWith('%') ? 12 : precedence.get(operator ?? '');

    function sequence(close?: string, continuation = false): Expression {
        let result: Expression = {};
        while (index < tokens!.length && current() !== close) {
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
        if (++depth > 128) {
            index = tokens!.length;
            depth--;
            return { pipeline: null };
        }
        skipNewlines();
        const token = tokens![index++];
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

        while (index < tokens!.length) {
            if (current() === '\n' && continuation) {
                let next = index;
                while (tokens![next]?.text === '\n') {
                    next++;
                }
                if (binding(tokens![next]?.text) !== undefined) {
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

    return sequence().pipeline ?? undefined;
}
