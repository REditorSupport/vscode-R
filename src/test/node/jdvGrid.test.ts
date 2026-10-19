import * as assert from 'node:assert/strict';
import { JdvDescriptor, JdvRequestError, JsonObject, parseDescriptor } from '../../jdvAdapter';
import { fetchGridPage } from '../../jdvGrid';

const descriptor: JdvDescriptor = parseDescriptor({
    view: 'v', generation: 1, kind: 'grid', access: 'random', encoding: 'jdv-json',
    capabilities: { seek: true, known_total: true }, collation: 'C', nrow: 5, ncol: 2,
    columns: [{ position: 0, name: 'a', type: 'string' }, { position: 1, name: 'b', type: 'string' }],
});
const message = { startRow: 0, endRow: 5, columns: ['1'] };
const page = (offset: number, count: number) => ({
    total: 5, total_unfiltered: 7, offset, limit: count,
    data: { source_row: Array.from({ length: count }, (_, index) => offset + index), row_labels: null, columns: [] },
});

suite('jdv grid block fetching', () => {
    test('keeps selected columns across short pages', async () => {
        const requests: JsonObject[] = [];
        const result = await fetchGridPage(descriptor, message, (method, params) => {
            assert.equal(method, 'grid/rows');
            requests.push(params);
            return Promise.resolve(page(Number(params.offset), Math.min(2, Number(params.limit))));
        });
        assert.deepEqual(requests.map(params => [params.offset, params.limit, params.cols]),
            [[0, 5, [0]], [2, 3, [0]], [4, 1, [0]]]);
        assert.deepEqual(result.rows.map(row => row.__sourceRow), [0, 1, 2, 3, 4]);
        assert.equal(result.lastRow, 5);
        assert.equal(result.totalUnfiltered, 7);
    });

    test('retries at the same offset without cols for the rest of an oversized block', async () => {
        const requests: JsonObject[] = [];
        const result = await fetchGridPage(descriptor, message, (_method, params) => {
            requests.push(params);
            if (params.offset === 2 && params.cols) {
                return Promise.reject(new JdvRequestError('limit_exceeded', 'page too large'));
            }
            return Promise.resolve(page(Number(params.offset), Math.min(2, Number(params.limit))));
        });
        assert.deepEqual(requests.map(params => [params.offset, params.cols]),
            [[0, [0]], [2, [0]], [2, undefined], [4, undefined]]);
        assert.deepEqual(result.rows.map(row => row.__sourceRow), [0, 1, 2, 3, 4]);
    });

    test('retries empty selections once and propagates all-column failures', async () => {
        let calls = 0;
        await assert.rejects(fetchGridPage(descriptor, { ...message, columns: [] }, (_method, params) => {
            assert.deepEqual(params.cols, calls++ === 0 ? [] : undefined);
            return Promise.reject(new JdvRequestError('limit_exceeded', 'row too large'));
        }), /row too large/);
        assert.equal(calls, 2);
    });

    test('propagates other errors without retrying', async () => {
        let calls = 0;
        await assert.rejects(fetchGridPage(descriptor, message, () => {
            calls++;
            return Promise.reject(new JdvRequestError('expired', 'expired'));
        }), /expired/);
        assert.equal(calls, 1);
    });

    test('stops on an empty page or the total row count', async () => {
        let calls = 0;
        const result = await fetchGridPage(descriptor, message, () => {
            calls++;
            return Promise.resolve(page(0, 0));
        });
        assert.equal(calls, 1);
        assert.deepEqual(result.rows, []);
        calls = 0;
        const full = await fetchGridPage(descriptor, { ...message, endRow: 10 }, () => {
            calls++;
            return Promise.resolve(page(0, 5));
        });
        assert.equal(calls, 1);
        assert.equal(full.rows.length, 5);
    });
});
