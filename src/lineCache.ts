'use strict';

/**
 * Class to hold lines that have been fetched from the document after they have been preprocessed.
 */
export class LineCache {
    public endsInOperatorCache: Map<number, boolean>;
    public getLine: (line: number) => string;
    public lineCache: Map<number, string>;
    public lineCount: number;
    public constructor(getLine: (line: number) => string, lineCount: number) {
        this.getLine = getLine;
        this.lineCount = lineCount;
        this.lineCache = new Map<number, string>();
        this.endsInOperatorCache = new Map<number, boolean>();
    }
    // Returns [Line, EndsInOperator]
    public addLineToCache(line: number): [string, boolean] {
        const cleaned = cleanLine(this.getLine(line));
        const endsInOperator = doesLineEndInOperator(cleaned);
        this.lineCache.set(line, cleaned);
        this.endsInOperatorCache.set(line, endsInOperator);
        return [cleaned, endsInOperator];
    }
    public getEndsInOperatorFromCache(line: number): boolean {
        const lineInCache = this.endsInOperatorCache.get(line);
        if (lineInCache === undefined) {
            return this.addLineToCache(line)[1];
        }
        return lineInCache;
    }
    public getLineFromCache(line: number): string {
        const lineInCache = this.lineCache.get(line);
        if (lineInCache === undefined) {
            return this.addLineToCache(line)[0];
        }
        return lineInCache;
    }
}

function isQuote(c: string) {
    return c === '"' || c === '\'' || c === '`';
}

function isComment(c: string) {
    return c === '#';
}

export function cleanLine(text: string): string {
    let cleaned = '';
    let withinQuotes = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (isQuote(c)) {
            if (withinQuotes === null) {
                withinQuotes = c;
            } else if (withinQuotes === c) {
                withinQuotes = null;
            }
        }
        if (isComment(c) && !withinQuotes) {
            break;
        }

        cleaned += c;
    }
    return (cleaned.trimEnd());
}

function doesLineEndInOperator(text: string) {
    const endingOperatorIndex = text.search(/(\(|,|\+|!|\$|\^|&|\*|-|=|:|~|\||\/|\?|<|>|%.*%)(\s*|\s*#.*)$/);
    const spacesOnlyIndex = text.search(/^\s*$/);

    return ((endingOperatorIndex >= 0) || (spacesOnlyIndex >= 0));
}
