import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { JdvDescriptor, JdvRequestError, gridColumnDefs, parseDescriptor } from '../../jdvAdapter';
import { SequentialStream, UNAVAILABLE_TEXT, formatScaled, formatTimestamp } from '../../jdvArrow';
import { JdvHost, JdvPeer } from '../../jdvTransport';

const descriptor: JdvDescriptor = parseDescriptor({
    view: 'v-1', generation: 1, kind: 'grid', access: 'sequential', encoding: 'arrow-ipc', mode: 'sequential',
    capabilities: { seek: false, sort: false, filter: false, known_total: false, next: true, children: false },
    nrow: null, ncol: 3, max_page_rows: 2000,
    columns: [
        { index: 0, position: 0, name: 'a', type: 'i', ipc_index: 0, unsupported: null, sortable: false, filterable: false },
        { index: 1, position: 1, name: 's', type: 'u', ipc_index: 1, unsupported: null, sortable: false, filterable: false },
        { index: 2, position: 2, name: 'x', type: '+w:2', ipc_index: null, unsupported: 'not supported', sortable: false, filterable: false },
    ],
    schema: { format: '+s', children: [{ format: 'i' }, { format: 'u' }, { format: '+w:2' }] },
});

/** A fake producer returning pages of `size` rows out of `total`. */
function producer(total: number, size: number) {
    let cursor = 0;
    let calls = 0;
    return {
        calls: () => calls,
        next: (maxRows: number) => {
            calls++;
            const rows = Math.min(size, maxRows, total - cursor);
            const a = Int32Array.from({ length: rows }, (_, i) => cursor + i + 1);
            const s = Array.from({ length: rows }, (_, i) => (cursor + i) % 3 === 0 ? null : `s${cursor + i + 1}`);
            const body = rows > 0 ? tableToIPC(tableFromArrays({ a, s })) : undefined;
            const result = { view: 'v-1', generation: 1, first_row: cursor, rows_fetched: rows, rows_seen: cursor + rows, done: cursor + rows >= total && rows === 0 };
            cursor += rows;
            return Promise.resolve({ result, body });
        },
    };
}

suite('jdv Arrow views', () => {
    test('formats decimals and timestamps exactly', () => {
        assert.equal(formatScaled(12345n, 2), '123.45');
        assert.equal(formatScaled(-5n, 3), '-0.005');
        assert.equal(formatScaled(12n, -2), '1200');
        assert.equal(formatTimestamp(1_500n, 1, 'UTC'), '1970-01-01T00:00:01.500Z');
        assert.equal(formatTimestamp(-1n, 3, null), '1969-12-31T23:59:59.999999999');
        assert.equal(formatTimestamp(0n, 0, 'Asia/Tokyo'), '1970-01-01T09:00:00+09:00 [Asia/Tokyo]');
    });

    test('builds unsortable, unfilterable columns', () => {
        const columns = gridColumnDefs(descriptor);
        assert.deepEqual(columns.map(column => [column.field, column.type, column.sortable, column.filter]), [
            ['0', 'textColumn', false, false], ['1', 'numericColumn', false, false],
            ['2', 'textColumn', false, false], ['3', 'textColumn', false, false],
        ]);
        assert.match(columns[3].headerTooltip ?? '', /unsupported: not supported/);
    });

    test('reads the stream forward and serves blocks from received pages', async () => {
        const source = producer(25, 10);
        const stream = new SequentialStream(descriptor, source.next, 10);
        await stream.ensure(5);
        assert.equal(stream.rowsSeen, 10);
        assert.equal(source.calls(), 1);
        assert.deepEqual(stream.rows(0, 2), [
            { '0': '1', '1': '1', '2': null, '3': '<unsupported: not supported>' },
            { '0': '2', '1': '2', '2': 's2', '3': '<unsupported: not supported>' },
        ]);
        // Concurrent requests share one stream/next at a time.
        await Promise.all([stream.ensure(15), stream.ensure(20)]);
        assert.equal(stream.rowsSeen, 20);
        await stream.ensure(Infinity);
        assert.equal(stream.done, true);
        assert.equal(stream.rowsSeen, 25);
        assert.deepEqual(stream.rows(23, 100).map(row => row['1']), ['24', '25']);
        stream.dispose();
    });

    test('reports evicted rows as unavailable', async () => {
        const source = producer(40, 10);
        // Room for about two pages.
        const stream = new SequentialStream(descriptor, source.next, 10, 2 * (1024 + 800));
        await stream.ensure(40);
        assert.ok(stream.unavailableBefore >= 10);
        assert.equal(stream.rows(0, 1)[0]['1'], UNAVAILABLE_TEXT);
        assert.equal(stream.rows(39, 40)[0]['1'], '40');
        stream.dispose();
    });

    test('rejects inconsistent page metadata', async () => {
        const stream = new SequentialStream(descriptor, () => Promise.resolve({
            result: { first_row: 0, rows_fetched: 5, rows_seen: 4, done: false },
        }), 10);
        await assert.rejects(stream.ensure(1), (e: unknown) => e instanceof JdvRequestError);
        stream.dispose();
    });
});

/** Connect to a host as R would, returning helpers to drive the protocol. */
async function fakeR(socketPath: string) {
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
    });
    let buffer = '';
    const lines: Record<string, unknown>[] = [];
    let waiter: (() => void) | undefined;
    socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            lines.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
            buffer = buffer.slice(newline + 1);
            waiter?.();
        }
    });
    let frames = 0;
    const next = async (predicate: (line: Record<string, unknown>) => boolean) => {
        for (;;) {
            const index = lines.findIndex(predicate);
            if (index >= 0) {
                frames += index + 1;
                const [line] = lines.splice(0, index + 1).slice(-1);
                return line;
            }
            await new Promise<void>(resolve => { waiter = resolve; });
        }
    };
    const send = (value: unknown, body?: Uint8Array) => {
        socket.write(JSON.stringify(value) + '\n');
        if (body) { socket.write(body); }
    };
    return { socket, next, send, ack: () => send({ method: 'ack', params: { frames } }) };
}

suite('jdv transport', () => {
    test('exchanges requests, wakes and Arrow bodies with R', async () => {
        const opened: string[] = [];
        let peer: JdvPeer | undefined;
        const host = await JdvHost.create(4321, {
            viewOpen: (connection, params) => { peer = connection; opened.push(String(params.view)); },
            viewClosed: () => undefined,
            disconnected: () => undefined,
        });
        try {
            const r = await fakeR(host.socketPath);
            r.send({ method: 'hello', params: { protocol: 1, session: 'r-4321-1', pid: 4321, limits: { max_receive_frames: 4, max_receive_bytes: 65536 } } });
            r.send({ method: 'view/open', params: { view: 'v-1', generation: 1 } });
            while (!peer) { await new Promise(resolve => setTimeout(resolve, 5)); }
            assert.deepEqual(opened, ['v-1']);

            const response = peer.requestWithBody('stream/next', { view: 'v-1', generation: 1, max_rows: 10 });
            const request = await r.next(line => line.method === 'stream/next');
            // Wakes repeat while the request is pending.
            await r.next(line => line.method === 'wake');
            r.ack();
            const body = Uint8Array.from([1, 2, 3, 10, 4]);
            r.send({
                id: request.id, warnings: [],
                result: { view: 'v-1', generation: 1, first_row: 0, rows_fetched: 1, rows_seen: 1, done: false, transfer: { encoding: 'arrow-ipc', byte_length: body.length } },
            }, body);
            r.send({ id: 'unknown', result: {}, warnings: [] });
            const { result, body: received } = await response;
            assert.deepEqual(Array.from(received!), [1, 2, 3, 10, 4]);
            assert.equal((result as { rows_seen: number }).rows_seen, 1);

            const failed = peer.request('table/rows', { view: 'v-1', generation: 1 });
            const second = await r.next(line => line.method === 'table/rows');
            r.send({ id: second.id, error: { code: 'unsupported', message: 'no' }, warnings: [] });
            await assert.rejects(failed, (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported');

            const pending = peer.request('view/close', { view: 'v-1', generation: 1 });
            r.socket.destroy();
            await assert.rejects(pending, (e: unknown) => e instanceof JdvRequestError && e.code === 'view_not_found');
        } finally {
            host.dispose();
        }
    });

    test('rejects a connection from another process', async () => {
        let reason = '';
        const host = await JdvHost.create(1, {
            viewOpen: () => undefined,
            viewClosed: () => undefined,
            disconnected: (_peer, why) => { reason = why; },
        });
        try {
            const r = await fakeR(host.socketPath);
            r.send({ method: 'hello', params: { protocol: 1, pid: 2, limits: {} } });
            await new Promise<void>(resolve => r.socket.once('close', () => resolve()));
            assert.match(reason, /does not belong/);
        } finally {
            host.dispose();
        }
    });
});
