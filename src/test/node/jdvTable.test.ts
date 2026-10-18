import * as assert from 'node:assert/strict';
import { createListAdapter, isJdvOutput, listRequest, normalizeJdvDisplay, queryJdvTablePage } from '../../interactive/jdvTable';
import { columnOperators, TableColumn } from '../../interactive/tableQuery';

const capabilities = { seek: true, sort: true, filter: true, known_total: true, next: false, children: false, refresh: false, track: false };
const gridDescriptor = {
    view: 'h-1', generation: 1, kind: 'grid', access: 'random', encoding: 'jdv-json', capabilities, collation: 'C', nrow: 50, ncol: 3,
    columns: [
        { position: 0, name: 'n', type: 'integer', sortable: true, filterable: true },
        { position: 1, name: 'd', type: 'date', sortable: true, filterable: true },
        { position: 2, name: 'i', type: 'int64', sortable: true, filterable: true },
    ],
};
const rowsPage = (offset: number, count: number, total = 50) => JSON.stringify({
    view: 'h-1', generation: 1, total, total_unfiltered: 50, offset, limit: count,
    data: {
        source_row: Array.from({ length: count }, (_, i) => offset + i), row_labels: null,
        columns: [{ schema: gridDescriptor.columns[0], data: { values: Array.from({ length: count }, (_, i) => offset + i + 1),
            display: Array.from({ length: count }, (_, i) => String(offset + i + 1)), na: Array(count).fill(false) }, errors: {} }],
    },
});
const display = (extra: Record<string, unknown> = {}) => ({
    kind: 'table', handleId: 'h1', descriptor: JSON.stringify(gridDescriptor), page: rowsPage(0, 2), sourceRows: 50, ...extra,
});

suite('Interactive jdv tables', () => {
    test('turns a handle preview into renderer data and keeps the descriptor', () => {
        assert.equal(isJdvOutput(display()), true);
        assert.equal(isJdvOutput({ kind: 'table', viewId: 'x' }), false);
        const data = normalizeJdvDisplay(display());
        assert.equal(data.page, undefined);
        assert.equal(data.totalRows, 50);
        assert.equal(data.sourceRows, 50);
        assert.deepEqual((data.columns as TableColumn[]).map(column => column.field), ['0', '1', '2', '3']);
        assert.deepEqual(data.rows, [{ '0': '1', __sourceRow: 0, '1': '1' }, { '0': '2', __sourceRow: 1, '1': '2' }]);
        assert.equal((data.descriptor as { view: string }).view, 'h-1');
        // Output that is not from a handle is left alone.
        const legacy = { kind: 'table', viewId: 'v' };
        assert.equal(normalizeJdvDisplay(legacy), legacy);
        assert.throws(() => normalizeJdvDisplay({ ...display(), kind: 'list' }));
    });

    test('offers the operators of the column type', () => {
        const columns = normalizeJdvDisplay(display()).columns as TableColumn[];
        assert.deepEqual(columnOperators(columns[1]).slice(-2), ['blank', 'notBlank']);
        assert.ok(columnOperators(columns[1]).includes('greaterThan'));
        assert.deepEqual(columnOperators(columns[3]), ['equals', 'blank', 'notBlank']);
        assert.ok(!columnOperators(columns[1]).includes('inRange'));
    });

    test('queries the handle for sorted, filtered and refilled pages', async () => {
        const data = normalizeJdvDisplay(display());
        const requests: Record<string, unknown>[] = [];
        // The handle returns at most 3 rows per request, as when a page exceeds its byte budget.
        const inspect = (request: { method: string; params: Record<string, unknown> }) => {
            assert.equal(request.method, 'jdv_handle_request');
            assert.equal(request.params.handle_id, 'h1');
            assert.equal(request.params.method, 'grid/rows');
            const params = request.params.params as Record<string, number>;
            requests.push(params);
            return Promise.resolve({ json: rowsPage(params.offset, Math.min(3, params.limit)) });
        };
        const result = await queryJdvTablePage(data, {
            start: 20, size: 20, sortModel: [{ colId: '1', sort: 'desc' }],
            filterModel: { '2': { type: 'greaterThan', filter: '2026-01-01' } },
        }, inspect);
        assert.equal((result.rows as unknown[]).length, 20);
        assert.equal(result.startRow, 20);
        assert.equal(result.totalRows, 50);
        assert.equal(result.live, true);
        assert.deepEqual(requests.slice(0, 2).map(params => [params.offset, params.limit]), [[20, 20], [23, 17]]);
        assert.deepEqual(requests[0].sort, [{ col: 0, desc: true }]);
        assert.deepEqual(requests[0].filter, { op: 'gt', col: 1, value: '2026-01-01' });
        assert.equal('view' in requests[0] || 'generation' in requests[0], false);

        requests.length = 0;
        await queryJdvTablePage(data, { start: 0, size: 20 }, inspect);
        assert.equal('sort' in requests[0] || 'filter' in requests[0], false);
    });

    test('rejects queries the column does not support', async () => {
        const data = normalizeJdvDisplay(display());
        const inspect = () => Promise.reject(new Error('not reached'));
        await assert.rejects(queryJdvTablePage(data, { start: 0, filterModel: { '3': { type: 'lessThan', filter: '1' } } }, inspect), /Invalid column filter/);
        await assert.rejects(queryJdvTablePage(data, { start: 0, sortModel: [{ colId: '9', sort: 'asc' }] }, inspect), /cannot be sorted/);
        await assert.rejects(queryJdvTablePage(data, { start: 0, size: 7 }, inspect), /Choose 20, 50 or 100/);
    });

    test('serves list actions from the handle and opens tables in the Data Viewer', async () => {
        const tree = { view: 'h-2', generation: 1, kind: 'tree', access: 'random', encoding: 'jdv-json', capabilities: { ...capabilities, sort: false, filter: false, children: true }, path: [], class: ['list'], type: 'list' };
        const children = (path: unknown[], items: unknown[]) => JSON.stringify({ view: 'h-2', generation: 1, path, offset: 0, children: items, total_children: items.length });
        const root = children([], [
            { index: 1, label: 'inner', class: ['list'], type: 'list', summary: 'list (1)', has_children: true, viewable: true, path: [{ type: 'index', index: 1 }] },
            { index: 2, label: '', class: ['data.frame'], type: 'list', summary: 'data.frame (1)', has_children: true, viewable: true, path: [{ type: 'index', index: 2 }] },
        ]);
        const data = normalizeJdvDisplay({ kind: 'list', handleId: 'h2', descriptor: JSON.stringify(tree), page: root });
        assert.deepEqual((data.children as { label: string }[]).map(child => child.label), ['inner', '[[2]]']);
        const calls: Record<string, unknown>[] = [];
        const inspect = (request: { method: string; params: Record<string, unknown> }) => {
            calls.push(request.params);
            return Promise.resolve({ json: (request.params.params as { path: unknown[] }).path.length ? children([{ type: 'index', index: 1 }], [
                { index: 1, label: 'x', class: ['numeric'], type: 'double', summary: 'double (1): 1', has_children: false, viewable: true, path: [{ type: 'index', index: 1 }, { type: 'index', index: 1 }] },
            ]) : root });
        };
        const adapter = await createListAdapter(data, inspect);
        const navigate = await listRequest(adapter, data, { action: 'listItem', path: [], index: 1 }, inspect);
        assert.deepEqual((navigate.result as { navigation: { path: number[] } }).navigation.path, [1]);
        const page = await listRequest(adapter, data, { action: 'listPage', path: [1], start: 1 }, inspect);
        assert.equal((page.result as { children: { label: string }[] }).children[0].label, 'x');
        assert.deepEqual(calls.at(-1)?.params, { path: [{ type: 'index', index: 1 }], offset: 0, limit: 200, attributes: false });
        const table = await listRequest(adapter, data, { action: 'listItem', path: [], index: 2 }, inspect);
        assert.deepEqual(table.open, { path: [{ type: 'index', index: 2 }], title: 'List[[2]]' });
        assert.deepEqual((await listRequest(adapter, data, { action: 'list', path: [] }, inspect)).open, { path: [], title: 'List' });
    });
});
