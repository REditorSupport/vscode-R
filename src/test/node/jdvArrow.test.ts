import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import {
    DataType,
    Decimal,
    Dictionary,
    Field,
    FixedSizeList,
    Int8,
    Int32,
    List,
    Map_,
    Struct,
    TimestampMicrosecond,
    Uint64,
    Utf8,
    tableFromArrays,
    tableToIPC,
} from 'apache-arrow';
import {
    JdvDescriptor,
    JdvRequestError,
    JsonObject,
    arrowFormatLabel,
    gridColumnDefs,
    parseDescriptor,
} from '../../jdvAdapter';
import {
    SequentialStream,
    UNAVAILABLE_TEXT,
    arrowTypeLabel,
    formatScaled,
    formatTimestamp,
} from '../../jdvArrow';
import { JdvHost, JdvPeer } from '../../jdvTransport';

const descriptor: JdvDescriptor = parseDescriptor({
    view: 'v-1',
    generation: 1,
    kind: 'grid',
    access: 'sequential',
    encoding: 'arrow-ipc',
    capabilities: {
        seek: false,
        sort: false,
        filter: false,
        known_total: false,
        next: true,
        children: false,
    },
    nrow: null,
    ncol: 3,
    max_page_rows: 2000,
    columns: [
        {
            index: 0,
            position: 0,
            name: 'a',
            type: 'i',
            ipc_index: 0,
            unsupported: null,
            sortable: false,
            filterable: false,
        },
        {
            index: 1,
            position: 1,
            name: 's',
            type: 'u',
            ipc_index: 1,
            unsupported: null,
            sortable: false,
            filterable: false,
        },
        {
            index: 2,
            position: 2,
            name: 'x',
            type: '+w:2',
            ipc_index: null,
            unsupported: 'not supported',
            sortable: false,
            filterable: false,
        },
    ],
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
            const s = Array.from({ length: rows }, (_, i) =>
                (cursor + i) % 3 === 0 ? null : `s${cursor + i + 1}`,
            );
            const body = rows > 0 ? tableToIPC(tableFromArrays({ a, s })) : undefined;
            const result = {
                view: 'v-1',
                generation: 1,
                first_row: cursor,
                rows_fetched: rows,
                rows_seen: cursor + rows,
                done: cursor + rows >= total && rows === 0,
            };
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
        assert.equal(
            formatTimestamp(0n, 0, 'Asia/Tokyo'),
            '1970-01-01T09:00:00+09:00 [Asia/Tokyo]',
        );
    });

    test('builds unsortable, unfilterable columns', () => {
        const columns = gridColumnDefs(descriptor);
        assert.deepEqual(
            columns.map((column) => [column.field, column.type, column.sortable, column.filter]),
            [
                ['0', 'textColumn', false, false],
                ['1', 'numericColumn', false, false],
                ['2', 'textColumn', false, false],
                ['3', 'textColumn', false, false],
            ],
        );
        assert.equal(columns[1].cellDataType, false);
        assert.equal(columns[2].cellDataType, undefined);
        assert.equal(columns[1].headerTooltip, 'a, Arrow type: int32');
        assert.match(columns[3].headerTooltip ?? '', /unsupported: not supported/);
    });

    test('names Arrow format strings', () => {
        const formats: [string, string][] = [
            ['l', 'int64'],
            ['u', 'string'],
            ['vu', 'string_view'],
            ['tdD', 'date32[day]'],
            ['tsu:UTC', 'timestamp[us, tz=UTC]'],
            ['tsn:', 'timestamp[ns]'],
            ['d:10,2', 'decimal128(10, 2)'],
            ['d:40,-3,256', 'decimal256(40, -3)'],
            ['w:16', 'fixed_size_binary[16]'],
            ['+w:2', 'fixed_size_list[2]'],
            ['+l', 'list'],
            ['+ud:0,1', 'dense_union'],
            ['?', '?'],
        ];
        for (const [format, label] of formats) {
            assert.equal(arrowFormatLabel(format), label, format);
        }
    });

    test('names decoded Arrow types with their children', () => {
        const label = (type: DataType) =>
            arrowTypeLabel(type as unknown as Parameters<typeof arrowTypeLabel>[0]);
        assert.equal(label(new Uint64()), 'uint64');
        assert.equal(label(new TimestampMicrosecond('Asia/Tokyo')), 'timestamp[us, tz=Asia/Tokyo]');
        assert.equal(label(new Decimal(2, 10, 128)), 'decimal128(10, 2)');
        assert.equal(
            label(new Dictionary(new Utf8(), new Int8())),
            'dictionary<values=string, indices=int8>',
        );
        assert.equal(label(new List(new Field('item', new Int32()))), 'list<int32>');
        assert.equal(
            label(new FixedSizeList(3, new Field('item', new Int32()))),
            'fixed_size_list<int32>[3]',
        );
        assert.equal(
            label(
                new Struct([
                    new Field('x', new Int32()),
                    new Field('y', new List(new Field('item', new Utf8()))),
                ]),
            ),
            'struct<x: int32, y: list<string>>',
        );
        assert.equal(
            label(
                new Map_(
                    new Field(
                        'entries',
                        new Struct<{ key: Utf8; value: Int32 }>([
                            new Field('key', new Utf8()),
                            new Field('value', new Int32()),
                        ]),
                    ),
                ),
            ),
            'map<string, int32>',
        );
    });

    test('reads the stream forward and serves blocks from received pages', async () => {
        const source = producer(25, 10);
        const stream = new SequentialStream(descriptor, source.next, 10);
        await stream.ensure(5);
        assert.equal(stream.rowsSeen, 10);
        assert.equal(source.calls(), 1);
        assert.equal(stream.headerTooltips, undefined);
        assert.deepEqual(stream.rows(0, 2), [
            { '0': '1', '1': '1', '2': null, '3': '<unsupported: not supported>' },
            { '0': '2', '1': '2', '2': 's2', '3': '<unsupported: not supported>' },
        ]);
        // The decoded page names each supported column's full type; tableFromArrays()
        // dictionary-encodes strings, which the descriptor format cannot show.
        assert.deepEqual(stream.headerTooltips, {
            '1': 'a, Arrow type: int32',
            '2': 's, Arrow type: dictionary<values=string, indices=int32>',
        });
        // Concurrent requests share one stream/next at a time.
        await Promise.all([stream.ensure(15), stream.ensure(20)]);
        assert.equal(stream.rowsSeen, 20);
        await stream.ensure(Infinity);
        assert.equal(stream.done, true);
        assert.equal(stream.rowsSeen, 25);
        assert.deepEqual(
            stream.rows(23, 100).map((row) => row['1']),
            ['24', '25'],
        );
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
        const stream = new SequentialStream(
            descriptor,
            () =>
                Promise.resolve({
                    result: { first_row: 0, rows_fetched: 5, rows_seen: 4, done: false },
                }),
            10,
        );
        await assert.rejects(stream.ensure(1), (e: unknown) => e instanceof JdvRequestError);
        stream.dispose();
    });

    test('returns after a round of empty non-EOF pages', async () => {
        let calls = 0;
        const stream = new SequentialStream(
            descriptor,
            () => {
                calls++;
                assert.ok(calls <= 64, 'empty pages must not start another fetch round');
                return Promise.resolve({
                    result: { first_row: 0, rows_fetched: 0, rows_seen: 0, done: false },
                });
            },
            10,
        );
        await stream.ensure(10);
        assert.equal(calls, 64);
        assert.equal(stream.rowsSeen, 0);
        assert.equal(stream.done, false);
        stream.dispose();
    });

    test('treats a gap page as progress', async () => {
        let calls = 0;
        const stream = new SequentialStream(
            descriptor,
            () => {
                calls++;
                const gap = calls === 64;
                return Promise.resolve({
                    result: {
                        first_row: gap ? 5 : 0,
                        rows_fetched: 0,
                        rows_seen: gap ? 5 : 0,
                        done: false,
                    },
                });
            },
            10,
        );
        await stream.ensure(1);
        assert.equal(calls, 64);
        assert.equal(stream.rowsSeen, 5);
        assert.equal(stream.rows(0, 5).length, 5);
        assert.equal(stream.rows(0, 5)[0]['1'], UNAVAILABLE_TEXT);
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
    socket.on('data', (chunk) => {
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
            await new Promise<void>((resolve) => {
                waiter = resolve;
            });
        }
    };
    const send = (value: unknown, body?: Uint8Array) => {
        socket.write(JSON.stringify(value) + '\n');
        if (body) {
            socket.write(body);
        }
    };
    return { socket, next, send, ack: () => send({ method: 'ack', params: { frames } }) };
}

function helloParams(limits: Record<string, number> = {}): JsonObject {
    return {
        protocol: 1,
        session: 'producer-1',
        wake: true,
        producer: { name: 'jdv', version: '0.0.9000', runtime: { name: 'R', version: '4.5.2' } },
        limits: {
            max_unacked_frames: 264,
            max_unacked_bytes: 1048577,
            queue_messages: 256,
            queue_bytes: 16777216,
            max_request_bytes: 1048576,
            max_message_bytes: 10485760,
            ...limits,
        },
    };
}

suite('jdv transport', () => {
    test('rejects requests that exceed byte limits before or after hello', async () => {
        for (const limits of [
            { max_unacked_bytes: 160, max_request_bytes: 4096 },
            { max_unacked_bytes: 4096, max_request_bytes: 160 },
        ]) {
            let peer: JdvPeer | undefined;
            const host = await JdvHost.create({
                viewOpen: (connection) => {
                    peer = connection;
                },
                viewClosed: () => undefined,
                viewUpdateFailed: () => undefined,
                viewTracking: () => undefined,
                disconnected: () => undefined,
            });
            try {
                const r = await fakeR(host.socketPath);
                while (!host.connection) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }
                peer = host.connection;

                const queuedTooLarge = peer!.request('grid/rows', { text: 'x'.repeat(200) });
                const queuedSmall = peer!.request('view/close', { view: 'v-1' });
                r.send({ method: 'hello', params: helloParams(limits) });
                await assert.rejects(
                    queuedTooLarge,
                    (e: unknown) => e instanceof JdvRequestError && e.code === 'limit_exceeded',
                );
                const small = await r.next((line) => line.method === 'view/close');
                r.send({ id: small.id, result: {}, warnings: [] });
                await queuedSmall;

                await assert.rejects(
                    peer!.request('grid/rows', { text: 'x'.repeat(200) }),
                    (e: unknown) => e instanceof JdvRequestError && e.code === 'limit_exceeded',
                );
                r.socket.destroy();
            } finally {
                host.dispose();
            }
        }
    });

    test('exchanges requests, wakes and Arrow bodies with R', async () => {
        const opened: string[] = [];
        const failures: JsonObject[] = [];
        const tracking: JsonObject[] = [];
        let peer: JdvPeer | undefined;
        const host = await JdvHost.create({
            viewOpen: (connection, params) => {
                peer = connection;
                opened.push(String(params.view));
            },
            viewClosed: () => undefined,
            viewUpdateFailed: (_connection, params) => {
                failures.push(params);
            },
            viewTracking: (_connection, params) => {
                tracking.push(params);
            },
            disconnected: () => undefined,
        });
        try {
            const r = await fakeR(host.socketPath);
            r.send({
                method: 'hello',
                params: helloParams({ max_unacked_frames: 4, max_unacked_bytes: 65536 }),
            });
            r.send({ method: 'view/open', params: { view: 'v-1', generation: 1 } });
            while (!peer) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.deepEqual(opened, ['v-1']);

            // A tracked update that failed is reported with the displayed generation.
            r.send({
                method: 'view/update_failed',
                params: {
                    view: 'v-1',
                    generation: 1,
                    code: 'limit_exceeded',
                    message: 'too large',
                },
            });
            while (failures.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(failures[0].message, 'too large');

            // A tracking change arrives before the response of the request that caused it.
            const tracked = peer.request('view/track', {
                view: 'v-1',
                generation: 1,
                enabled: false,
            });
            const trackRequest = await r.next((line) => line.method === 'view/track');
            assert.deepEqual(trackRequest.params, { view: 'v-1', generation: 1, enabled: false });
            const paused = { name: 'df', state: 'paused' };
            r.send({
                method: 'view/tracking',
                params: { view: 'v-1', generation: 1, tracking: paused },
            });
            r.send({
                id: trackRequest.id,
                result: { view: 'v-1', generation: 1, tracking: paused },
                warnings: [],
            });
            assert.deepEqual(await tracked, { view: 'v-1', generation: 1, tracking: paused });
            assert.deepEqual(tracking, [{ view: 'v-1', generation: 1, tracking: paused }]);

            const response = peer.requestWithBody('stream/next', {
                view: 'v-1',
                generation: 1,
                max_rows: 10,
            });
            const request = await r.next((line) => line.method === 'stream/next');
            // Wakes repeat while the request is pending.
            await r.next((line) => line.method === 'wake');
            r.ack();
            const body = Uint8Array.from([1, 2, 3, 10, 4]);
            r.send(
                {
                    id: request.id,
                    warnings: [],
                    result: {
                        view: 'v-1',
                        generation: 1,
                        first_row: 0,
                        rows_fetched: 1,
                        rows_seen: 1,
                        done: false,
                        transfer: { encoding: 'arrow-ipc', byte_length: body.length },
                    },
                },
                body,
            );
            r.send({ id: 'unknown', result: {}, warnings: [] });
            const { result, body: received } = await response;
            assert.deepEqual(Array.from(received!), [1, 2, 3, 10, 4]);
            assert.equal((result as { rows_seen: number }).rows_seen, 1);

            const failed = peer.request('grid/rows', { view: 'v-1', generation: 1 });
            const second = await r.next((line) => line.method === 'grid/rows');
            r.send({ id: second.id, error: { code: 'unsupported', message: 'no' }, warnings: [] });
            await assert.rejects(
                failed,
                (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
            );

            const pending = peer.request('view/close', { view: 'v-1', generation: 1 });
            r.socket.destroy();
            await assert.rejects(
                pending,
                (e: unknown) => e instanceof JdvRequestError && e.code === 'view_not_found',
            );
        } finally {
            host.dispose();
        }
    });

    test('rejects an invalid hello and treats unknown error codes as producer failures', async () => {
        let reason = '';
        let peer: JdvPeer | undefined;
        const host = await JdvHost.create({
            viewOpen: (connection) => {
                peer = connection;
            },
            viewClosed: () => undefined,
            viewUpdateFailed: () => undefined,
            viewTracking: () => undefined,
            disconnected: (_peer, why) => {
                reason = why;
            },
        });
        try {
            const bad = await fakeR(host.socketPath);
            bad.send({
                method: 'hello',
                params: { ...helloParams(), limits: { max_unacked_frames: 4 } },
            });
            await new Promise<void>((resolve) => bad.socket.once('close', () => resolve()));
            assert.match(reason, /Invalid jdv hello/);

            const good = await fakeR(host.socketPath);
            good.send({ method: 'hello', params: helloParams() });
            good.send({ method: 'view/open', params: { view: 'v-1', generation: 1 } });
            while (!peer) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            const failed = peer.request('grid/rows', { view: 'v-1', generation: 1 });
            const request = await good.next((line) => line.method === 'grid/rows');
            good.send({
                id: request.id,
                error: { code: 'some_future_code', message: 'boom' },
                warnings: [],
            });
            await assert.rejects(
                failed,
                (e: unknown) =>
                    e instanceof JdvRequestError &&
                    e.code === 'producer_error' &&
                    /boom \(some_future_code\)/.test(e.message),
            );
        } finally {
            host.dispose();
        }
    });

    test('sends wakes only when the producer asks for them', async () => {
        let peer: JdvPeer | undefined;
        const host = await JdvHost.create({
            viewOpen: (connection) => {
                peer = connection;
            },
            viewClosed: () => undefined,
            viewUpdateFailed: () => undefined,
            viewTracking: () => undefined,
            disconnected: () => undefined,
        });
        try {
            const quiet = await fakeR(host.socketPath);
            quiet.send({ method: 'hello', params: { ...helloParams(), wake: false } });
            quiet.send({ method: 'view/open', params: { view: 'v-1', generation: 1 } });
            while (!peer) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            void peer.request('view/close', { view: 'v-1', generation: 1 }).catch(() => undefined);
            const request = await quiet.next((line) => line.method === 'view/close');
            // A later request arrives without a wake in between.
            await new Promise((resolve) => setTimeout(resolve, 200));
            quiet.send({ id: request.id, result: {}, warnings: [] });
            quiet.ack();
            await assert.rejects(
                Promise.race([
                    quiet.next((line) => line.method === 'wake'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('no wake')), 150)),
                ]),
                /no wake/,
            );
        } finally {
            host.dispose();
        }
    });
});
