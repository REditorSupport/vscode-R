/**
 * Like vscode's Position class, but allows negative values.
 */
class PositionNeg {
    line: number;
    character: number;
    constructor(_line: number, _character: number) {
        this.line = _line;
        this.character = _character;
    }
}

/**
 * Class to hold lines that have been fetched from the document after they have been preprocessed.
 */
class LineCache {
    lineCache: Map<number, string>;
    endsInOperatorCache: Map<number, boolean>;
    getLine: (number) => string;
    lineCount: number;
    constructor(_getLine: (number) => string, _lineCount: number) {
        this.getLine = _getLine;
        this.lineCount = _lineCount;
        this.lineCache = new Map<number, string>();
        this.endsInOperatorCache = new Map<number, boolean>();
    }
    getLineFromCache(line: number) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.lineCache.get(line);
        return (s);
    }
    getEndsInOperatorFromCache(line: number) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.endsInOperatorCache.get(line);
        return (s);
    }
    addLineToCache(line: number) {
        const cleaned = cleanLine(this.getLine(line));
        const endsInOperator = doesLineEndInOperator(cleaned);
        this.lineCache.set(line, cleaned);
        this.endsInOperatorCache.set(line, endsInOperator);
    }
}

function doBracketsMatch(a: string, b: string): boolean {
    const matches = { "(":")", "[":"]", "{":"}", ")":"(", "]":"[", "}":"{" };
    return matches[a] === b;
}

function isBracket(c: string, lookingForward: boolean) {
    if (lookingForward) {
        return ((c === "(") || (c === "[") || (c === "{"));
    } else {
        return ((c === ")") || (c === "]") || (c === "}"));
    }
}

function cleanLine(text: string) {
    const cleaned = text.replace(/\s*\#.*/, ""); // Remove comments and preceeding spaces
    return (cleaned);
}

function doesLineEndInOperator(text: string) {
    const endingOperatorIndex = text.search(/(,|\+|!|\$|\^|&|\*|-|=|:|\'|~|\||\/|\?|%.*%)(\s*|\s*\#.*)$/);
    const spacesOnlyIndex = text.search(/^\s*$/); // Space-only lines also counted.
    return ((0 <= endingOperatorIndex) || (0 <= spacesOnlyIndex));
}

/**
 * From a given position, return the 'next' character, its position in the document,
 * whether it is start/end of a code line (possibly broken over multiple text lines), and whether it is the 
 * start/end of the file. Considers the start and end of each line to be special distinct characters.
 * @param p The starting position.
 * @param lookingForward true if the 'next' character is toward the end of the document, false if toward the start of the document.
 * @param getLine A function that returns the string at the given line of the document.
 * @param getEndsInOperator A function that returns whether the given line ends in an operator.
 * @param lineCount The number of lines in the document.
 */
function getNextChar(p: PositionNeg, lookingForward: boolean, getLine: (number) => string, getEndsInOperator: (number) => boolean, lineCount) {
    const s = getLine(p.line);
    let nextPos: PositionNeg = null;
    let isEndOfCodeLine = false;
    let isEndOfFile = false;
    if (lookingForward) {
        if (p.character != s.length) {
            nextPos = new PositionNeg(p.line, p.character + 1);
        } else if (p.line < (lineCount - 1)) {
            nextPos = new PositionNeg(p.line + 1, -1);
        } else {
            // At end of document. Return same character.
            isEndOfFile = true;
            nextPos = new PositionNeg(p.line, p.character);
        }
        const nextLine: string = getLine(nextPos.line);
        if (nextPos.character === nextLine.length) {
            if ((nextPos.line === (lineCount - 1)) || !getEndsInOperator(nextPos.line)) {
                isEndOfCodeLine = true;
            }
        }
    } else {
        if (p.character != -1) {
            nextPos = new PositionNeg(p.line, p.character - 1);
        } else if (p.line > 0) { 
            nextPos = new PositionNeg(p.line - 1, getLine(p.line - 1).length - 1);
        } else {
            // At start of document. Return same character.
            isEndOfFile = true;
            nextPos = new PositionNeg(p.line, p.character);
        }
        if (nextPos.character === -1) {
            if ((nextPos.line <= 0) || !getEndsInOperator(nextPos.line - 1)) {
                isEndOfCodeLine = true;
            }
        }
    }
    const nextChar = getLine(nextPos.line)[nextPos.character];
    return ({ nextChar: nextChar, nextPos: nextPos, isEndOfCodeLine: isEndOfCodeLine, isEndOfFile: isEndOfFile });
}

/**
 * Given a line number, gets the text of that line and determines the first and last lines of the 
 * file required to make a complete line of code, by matching brackets and extending over
 * broken lines (single lines of code split into multiple text lines, joined by operators).
 * 
 * The algorithm:
 * From the start of the given line, proceed forward looking for the end of the code line. 
 * If a bracket is encountered, look for the match of that bracket (possibly changing direction to do so),
 * from the farthest point reached in that direction. 
 * Once the bracket is found, proceed in the same direction looking for the completion of the code line.
 * Once the end of the code line has been matched, proceed in the other direction. 
 * Repeat until all encountered brackets are matched, and the completions of the code lines have been reached in 
 * both directions. The lines of the completions are the lines returned.
 * 
 * Example:
 * Let's say we have the following R code file:
 * 
 *     library(magrittr) # For %>%    Line 1
 *     list(x = 1,       #            Line 2
 *          y = 2) %>%   #            Line 3
 *         print()       #            Line 4
 * 
 * Let's say the cursor is on Line 3. We proceed forward until we hit the ')'. We look for the match, which 
 * means looking backwards from the end of Line 2. We find the match, '(', on Line 2. We continue along 
 * Line 2 until we reach the start of the line. The previous line, Line 1, does not end in an operator,
 * so we have reached the completion of the code line. Now, we proceed forward again from the farthest point reached
 * in the other direction: the ')' on Line 3. We encounter the end of the TEXT line, but it ends in an operator '%>%', 
 * so it is not the end of the CODE line. Therefore, we continue onto Line 4. We encounter a '(' on Line 4, and continue 
 * forward to find its match, which is the next character. Then we're at the end of Line 4, which doesn't
 * end in an operator. Now we've found the completions in both directions, so we're finished. The farthest lines
 * reached were Line 2 and Line 4, so those are the values returned.
 * @param line The line of the document at which to start.
 * @param getLine A function that returns the string at the given line of the document.
 * @param lineCount The number of lines in the document.
 */
export function extendSelection(line: number, getLine: (number) => string, lineCount: number) {
    const lc = new LineCache(getLine, lineCount);
    const getLineFromCache = function(x) { return (lc.getLineFromCache(x)); }
    const getEndsInOperatorFromCache = function(x) { return (lc.getEndsInOperatorFromCache(x)); }
    let lookingForward = true;
    // poss[1] is the farthest point reached looking forward from line,
    // and poss[0] is the farthest point reached looking backward from line.
    let poss = { 0: new PositionNeg(line, 0), 1: new PositionNeg(line, -1) };
    let flagsFinish = { 0: false, 1: false }; // 1 represents looking forward, 0 represents looking back.
    let flagAbort = false;
    let unmatched = { 0: <string[]>[], 1: <string[]>[]};
    while (!flagAbort && !(flagsFinish[0] && flagsFinish[1])) {
        let { nextChar, nextPos, isEndOfCodeLine, isEndOfFile } = getNextChar(poss[lookingForward ? 1 : 0], lookingForward, getLineFromCache, getEndsInOperatorFromCache, lineCount);
        poss[lookingForward ? 1 : 0] = nextPos;
        if (isBracket(nextChar, lookingForward)) {
            unmatched[lookingForward ? 1 : 0].push(nextChar);
        } else if (isBracket(nextChar, !lookingForward)) {
            if (unmatched[lookingForward ? 1 : 0].length === 0) {
                lookingForward = !lookingForward;
                unmatched[lookingForward ? 1 : 0].push(nextChar);
                flagsFinish[lookingForward ? 1 : 0] = false; 
            } else {
                let needsToMatch = unmatched[lookingForward ? 1 : 0].pop();
                if (!doBracketsMatch(nextChar, needsToMatch)) {
                    flagAbort = true;
                }
            }
        } else if (isEndOfCodeLine) { 
            if (unmatched[lookingForward ? 1 : 0].length === 0) {
                // We have found everything we need to in this direction. Continue looking in the other direction.
                flagsFinish[lookingForward ? 1 : 0] = true;
                lookingForward = !lookingForward; 
            } else if (isEndOfFile) {
                // Have hit the start or end of the file without finding the matching bracket.
                flagAbort = true;
            }
        }
    }
    if (flagAbort) {
        return ({ startLine: line, endLine: line });
    } else {
        return ({ startLine: poss[0].line, endLine: poss[1].line });
    }
}
