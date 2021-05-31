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
    public addLineToCache(line: number): void {
        const cleaned = cleanLine(this.getLine(line));
        const endsInOperator = doesLineEndInOperator(cleaned);
        this.lineCache.set(line, cleaned);
        this.endsInOperatorCache.set(line, endsInOperator);
    }
    public getEndsInOperatorFromCache(line: number): boolean {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.endsInOperatorCache.get(line);

        return (s);
    }
    public getLineFromCache(line: number): string {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.lineCache.get(line);

        return (s);
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
            withinQuotes = (withinQuotes === c) ? null : c;
        }
        if (isComment(c) && !withinQuotes) {
            break;
        }

        cleaned += c;
    }

    return (cleaned.trimEnd());
}

function doesLineEndInOperator(text: string) {
    const endingOperatorIndex = text.search(/(,|\+|!|\$|\^|&|\*|-|=|:|~|\||\/|\?|<|>|%.*%)(\s*|\s*#.*)$/);
    const spacesOnlyIndex = text.search(/^\s*$/);

    return ((endingOperatorIndex >= 0) || (spacesOnlyIndex >= 0));
}
