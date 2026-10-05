import * as assert from 'assert';
import { queryTablePage, TableColumn, tableSchema } from '../../interactive/tableQuery';
import { tablePage } from '../../interactive/tablePaging';

suite('Inline table queries', () => {
    const columns: TableColumn[] = [
        { field: '0', headerName: ' ', sortable: false, filter: false },
        { field: '1', headerName: 'id', type: 'bigintColumn' },
        { field: '2', headerName: 'name', type: 'textColumn' },
    ];
    const data = {
        viewId: 'snapshot',
        fullViewId: 'full',
        totalRows: 1000,
        sourceRows: 832976871,
        columns,
    };
    const schema = tableSchema(columns);
    type Request = { method: string; params: Record<string, unknown> };
    function backend(
        total = data.sourceRows,
        currentColumns = columns,
    ): { calls: Request[]; inspect: (request: Request) => Promise<Record<string, unknown>> } {
        const calls: Request[] = [];
        return {
            calls,
            inspect: (request) => {
                calls.push(request);
                if (request.method === 'dataview_init') {
                    return Promise.resolve({ columns: currentColumns, totalRows: total });
                }
                return Promise.resolve({ rows: [], totalRows: total });
            },
        };
    }
    test('retains snapshot pages until a request crosses its boundary', async () => {
        const rpc = backend();
        await queryTablePage(data, { start: 980 }, rpc.inspect);
        assert.strictEqual(rpc.calls[0].params.view_id, 'snapshot');
        await queryTablePage(data, { start: 1000, live: true, refresh: true, schema }, rpc.inspect);
        assert.strictEqual(rpc.calls[1].method, 'dataview_init');
        assert.strictEqual(rpc.calls[2].params.view_id, 'full');
        assert.strictEqual(rpc.calls[2].params.startRow, 1000);
        assert.strictEqual(rpc.calls[2].params.endRow, 1020);
    });
    test('last-page and wider requests remain bounded without the old snapshot clamp', async () => {
        const rpc = backend();
        const result = await queryTablePage(
            data,
            { start: 832976860, size: 100, live: true },
            rpc.inspect,
        );
        assert.strictEqual(result.startRow, 832976800);
        assert.strictEqual(rpc.calls[0].params.endRow, 832976900);
        assert.deepStrictEqual(tablePage(53, 52, 50), { start: 50, end: 53 });
    });
    test('sorting and filtering a large result uses the full handle and exact integer64 text', async () => {
        const rpc = backend();
        const result = await queryTablePage(
            data,
            {
                start: 0,
                refresh: true,
                schema,
                sortModel: [{ colId: '1', sort: 'desc' }],
                filterModel: { '1': { type: 'equals', filter: '9007199254740993' } },
            },
            rpc.inspect,
        );
        assert.strictEqual(result.live, true);
        assert.strictEqual(rpc.calls[1].params.view_id, 'full');
        assert.deepStrictEqual(rpc.calls[1].params.filterModel, {
            '1': { type: 'equals', filter: '9007199254740993' },
        });
        assert.strictEqual(result.queryReset, false);
    });
    test('reuses R query caches on navigation instead of reinitializing each page', async () => {
        const rpc = backend();
        await queryTablePage(
            data,
            { start: 60, live: true, sortModel: [{ colId: '1', sort: 'asc' }] },
            rpc.inspect,
        );
        assert.strictEqual(rpc.calls.length, 1);
        assert.strictEqual(rpc.calls[0].method, 'dataview_page');
    });
    test('recovers when reference edits shrink a live table past the requested page', async () => {
        const rpc = backend(53);
        const result = await queryTablePage(data, { start: 1000, live: true }, rpc.inspect);
        assert.strictEqual(rpc.calls.length, 2);
        assert.strictEqual(result.startRow, 40);
        const empty = await queryTablePage(data, { start: 1000, live: true }, backend(0).inspect);
        assert.strictEqual(empty.startRow, 0);
    });
    test('clears positional queries when a refreshed schema has changed', async () => {
        const rpc = backend(2000, [columns[0], columns[2], columns[1]]);
        const result = await queryTablePage(
            data,
            { start: 0, refresh: true, schema, sortModel: [{ colId: '1', sort: 'asc' }] },
            rpc.inspect,
        );
        assert.strictEqual(result.queryReset, true);
        assert.deepStrictEqual(rpc.calls[1].params.sortModel, []);
        assert.deepStrictEqual(result.columns, [columns[0], columns[2], columns[1]]);
    });
    test('row-name representation changes do not clear a valid full-data query', async () => {
        const rpc = backend(2000, [{ ...columns[0], type: 'numericColumn' }, ...columns.slice(1)]);
        const result = await queryTablePage(
            data,
            { start: 0, refresh: true, schema, sortModel: [{ colId: '1', sort: 'asc' }] },
            rpc.inspect,
        );
        assert.strictEqual(result.queryReset, false);
        assert.deepStrictEqual(rpc.calls[1].params.sortModel, [{ colId: '1', sort: 'asc' }]);
    });
    test('legacy and small outputs use their owned snapshot handle', async () => {
        const rpc = backend(50);
        const result = await queryTablePage(
            { ...data, fullViewId: undefined },
            { start: 20, live: true, viewId: 'foreign', sortModel: [{ colId: '2', sort: 'asc' }] },
            rpc.inspect,
        );
        assert.strictEqual(result.live, false);
        assert.strictEqual(rpc.calls[0].params.view_id, 'snapshot');
    });
    test('rejects oversized, invalid and unsupported renderer queries before R work', async () => {
        for (const query of [
            { size: 10000000 },
            { start: -1 },
            { start: Infinity },
            { start: 0.5 },
            { sortModel: [{ colId: '0', sort: 'asc' }] },
            { sortModel: [{ colId: '1', sort: 'code()' }] },
            { filterModel: { '1': { type: 'contains', filter: '1' } } },
            { filterModel: { '2': { type: 'contains', filter: 'x'.repeat(1001) } } },
        ]) {
            const rpc = backend();
            await assert.rejects(queryTablePage(data, query, rpc.inspect));
            assert.strictEqual(rpc.calls.length, 0);
        }
    });
});
