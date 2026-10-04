import { ExecutionRecord } from './protocol';

export interface HistoryPage { executions: ExecutionRecord[]; more: boolean }

/** Search admitted code without loading output journals or assets. Bound every response. */
export function searchHistory(records: Iterable<ExecutionRecord>, query = '', before = Number.MAX_SAFE_INTEGER, limit = 100): HistoryPage {
    const needle = query.toLocaleLowerCase();
    const matches = [...records].filter(record => record.order < before && record.code.toLocaleLowerCase().includes(needle))
        .sort((a, b) => b.order - a.order);
    const executions: ExecutionRecord[] = [];
    let bytes = 0;
    for (const record of matches) {
        const size = Buffer.byteLength(JSON.stringify(record));
        if (executions.length >= limit || bytes + size > 2 * 1024 * 1024) { break; }
        executions.push(record); bytes += size;
    }
    return { executions, more: matches.length > executions.length };
}
