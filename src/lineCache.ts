"use strict";

/**
 * Class to hold lines that have been fetched from the document after they have been preprocessed.
 */
export class LineCache {
    public lineCache: Map<number, string>;
    public endsInOperatorCache: Map<number, boolean>;
    public getLine: (line: number) => string;
    public lineCount: number;
    public constructor(getLine: (line: number) => string, lineCount: number) {
        this.getLine = getLine;
        this.lineCount = lineCount;
        this.lineCache = new Map<number, string>();
        this.endsInOperatorCache = new Map<number, boolean>();
    }
    public getLineFromCache(line: number) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.lineCache.get(line);

        return (s);
    }
    public getEndsInOperatorFromCache(line: number) {
        const lineInCache = this.lineCache.has(line);
        if (!lineInCache) {
            this.addLineToCache(line);
        }
        const s = this.endsInOperatorCache.get(line);

        return (s);
    }
    public addLineToCache(line: number) {
        const cleaned = cleanLine(this.getLine(line));
        const endsInOperator = doesLineEndInOperator(cleaned);
        this.lineCache.set(line, cleaned);
        this.endsInOperatorCache.set(line, endsInOperator);
    }
}

function cleanLine(text: string) {
    const cleaned = text.replace(/\s*\#.*/, "");

    return (cleaned);
}

function doesLineEndInOperator(text: string) {
    const endingOperatorIndex = text.search(/(,|\+|!|\$|\^|&|\*|-|=|:|\'|~|\||\/|\?|%.*%)(\s*|\s*\#.*)$/);
    const spacesOnlyIndex = text.search(/^\s*$/);

    return ((0 <= endingOperatorIndex) || (0 <= spacesOnlyIndex));
}
