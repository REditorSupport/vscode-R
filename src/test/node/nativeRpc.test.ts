import * as assert from 'node:assert/strict';
import * as sinon from 'sinon';
import type { Socket } from 'node:net';
import {
    MAX_NATIVE_RPC_FRAME_BYTES,
    NativeRpcConnection,
    NativeRpcFrames,
    withRpcCancellation,
} from '../../nativeRpc';

suite('Native sess RPC lifecycle', () => {
    let clock: sinon.SinonFakeTimers;
    const connections: NativeRpcConnection[] = [];

    setup(() => {
        clock = sinon.useFakeTimers();
    });

    teardown(() => {
        for (const connection of connections.splice(0)) {
            connection.close();
        }
        clock.restore();
    });

    function connection() {
        const sent: Record<string, unknown>[] = [];
        const socket = {
            destroyed: false,
            write: (text: string) => {
                sent.push(JSON.parse(text) as Record<string, unknown>);
                return true;
            },
        };
        const rpc = new NativeRpcConnection(socket as Pick<Socket, 'write' | 'destroyed'>);
        connections.push(rpc);
        return { rpc, sent, socket };
    }

    test('assigns independent monotonic IDs even with repeated caller IDs', async () => {
        const a = connection(),
            b = connection();
        const first = a.rpc.request({ method: 'hover', id: 123 });
        const second = a.rpc.request({ method: 'completion', id: 123 });
        const other = b.rpc.request({ method: 'hover', id: 123 });
        assert.deepEqual(
            a.sent.map((message) => message.id),
            [1, 2],
        );
        assert.equal(b.sent[0].id, 1);
        a.rpc.response({ id: 2, result: 'second' });
        b.rpc.response({ id: 1, result: 'other socket' });
        a.rpc.response({ id: 1, result: 'first' });
        assert.deepEqual(await Promise.all([first, second, other]), [
            'first',
            'second',
            'other socket',
        ]);
        assert.equal(clock.countTimers(), 0);
    });

    test('clears completed timers before another request starts', async () => {
        const { rpc, sent } = connection();
        const first = rpc.request({ method: 'hover' });
        rpc.response({ id: sent[0].id, result: 'done' });
        assert.equal(await first, 'done');
        assert.equal(clock.countTimers(), 0);
        await clock.tickAsync(4000);
        const second = rpc.request({ method: 'completion' });
        await clock.tickAsync(1000);
        assert.equal(clock.countTimers(), 1);
        // A late duplicate response cannot complete the newer request.
        rpc.response({ id: sent[0].id, result: 'late' });
        rpc.response({ id: sent[1].id, result: 'new' });
        assert.equal(await second, 'new');
        assert.equal(clock.countTimers(), 0);
    });

    test('times out one request without affecting others or retaining its timer', async () => {
        const { rpc, sent } = connection();
        const expired = assert.rejects(
            rpc.request({ method: 'hover' }, { timeout: 10 }),
            /timed out/,
        );
        const live = rpc.request({ method: 'completion' }, { timeout: 100 });
        await clock.tickAsync(10);
        await expired;
        assert.equal(clock.countTimers(), 1);
        rpc.response({ id: sent[0].id, result: 'late' });
        rpc.response({ id: sent[1].id, result: 'live' });
        assert.equal(await live, 'live');
        assert.equal(clock.countTimers(), 0);
    });

    test('disconnect rejects pending calls and prevents further writes', async () => {
        const { rpc, sent } = connection();
        const first = assert.rejects(rpc.request({ method: 'hover' }), /disconnected/);
        const second = assert.rejects(rpc.request({ method: 'completion' }), /disconnected/);
        rpc.close();
        rpc.close();
        await Promise.all([first, second]);
        assert.equal(clock.countTimers(), 0);
        await assert.rejects(rpc.request({ method: 'workspace' }), /not connected/);
        assert.equal(sent.length, 2);
    });

    test('cancellation releases its timeout and ignores late responses', async () => {
        const { rpc, sent } = connection();
        const controller = new AbortController();
        const cancelled = assert.rejects(
            rpc.request({ method: 'hover' }, { signal: controller.signal }),
            { name: 'AbortError' },
        );
        controller.abort();
        await cancelled;
        assert.equal(clock.countTimers(), 0);
        rpc.response({ id: sent[0].id, result: 'late' });
        const next = rpc.request({ method: 'completion' });
        rpc.response({ id: sent[1].id, result: 'next' });
        assert.equal(await next, 'next');
    });

    test('does not send requests cancelled before admission', async () => {
        const { rpc, sent } = connection();
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(rpc.request({ method: 'hover' }, { signal: controller.signal }), {
            name: 'AbortError',
        });
        assert.equal(sent.length, 0);
        assert.equal(clock.countTimers(), 0);
    });

    test('write errors and RPC errors settle requests and remove timers', async () => {
        const { rpc, socket, sent } = connection();
        socket.write = () => {
            throw new Error('write failed');
        };
        await assert.rejects(rpc.request({ method: 'hover' }), /write failed/);
        assert.equal(clock.countTimers(), 0);
        socket.write = (text) => {
            sent.push(JSON.parse(text) as Record<string, unknown>);
            return true;
        };
        const failed = assert.rejects(rpc.request({ method: 'hover' }), {
            code: -32603,
            message: 'R handler failed',
        });
        rpc.response({ id: sent[0].id, error: { code: -32603, message: 'R handler failed' } });
        await failed;
        assert.equal(clock.countTimers(), 0);
    });

    test('handles a reply delivered synchronously from write', async () => {
        const { rpc, socket } = connection();
        socket.write = (text) => {
            rpc.response({ id: (JSON.parse(text) as { id: number }).id, result: 'reply' });
            return true;
        };
        assert.equal(await rpc.request({ method: 'hover' }), 'reply');
        assert.equal(clock.countTimers(), 0);
    });

    test('cancels a requester wait while leaving the backend operation running', async () => {
        let complete!: (value: string) => void;
        const backend = new Promise<string>((resolve) => {
            complete = resolve;
        });
        const controller = new AbortController();
        const cancelled = assert.rejects(
            withRpcCancellation(() => backend, controller.signal),
            { name: 'AbortError' },
        );
        await Promise.resolve();
        controller.abort();
        await cancelled;
        complete('backend still completes');
        assert.equal(await backend, 'backend still completes');
    });

    test('does not start a requester operation when already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            withRpcCancellation(() => assert.fail('operation must not start'), controller.signal),
            { name: 'AbortError' },
        );
    });
});

suite('Native sess RPC framing', () => {
    test('preserves split UTF-8, CRLF and multiple complete frames', () => {
        const lines: string[] = [];
        const frames = new NativeRpcFrames((frame) => lines.push(frame.toString('utf8')));
        const payload = Buffer.from('{"result":"数据"}\r\n{"id":2}\n');
        const split = payload.indexOf(0xe6) + 1;
        frames.push(payload.subarray(0, split));
        frames.push(payload.subarray(split, split + 1));
        frames.push(payload.subarray(split + 1));
        assert.deepEqual(lines, ['{"result":"数据"}\r', '{"id":2}']);
    });

    test('accepts native responses above Interactive limits', () => {
        const payload = Buffer.from('x'.repeat(8 * 1024 * 1024) + '\n');
        let received = 0;
        const frames = new NativeRpcFrames((frame) => {
            received = frame.length;
        });
        frames.push(payload.subarray(0, 1024));
        frames.push(payload.subarray(1024));
        assert.equal(received, 8 * 1024 * 1024);
        assert.ok(received < MAX_NATIVE_RPC_FRAME_BYTES);
    });

    test('rejects an unterminated oversized frame before decoding it', () => {
        const frames = new NativeRpcFrames(() => assert.fail(), 8);
        frames.push(Buffer.from('12345678'));
        assert.throws(() => frames.push(Buffer.from('9')), /frame exceeds size limit/);
    });

    test('applies the bound to completed and fragmented frames equally', () => {
        const frames = new NativeRpcFrames(() => assert.fail(), 8);
        assert.throws(() => frames.push(Buffer.from('123456789\n')), /frame exceeds size limit/);
        frames.push(Buffer.from('1234'));
        assert.throws(() => frames.push(Buffer.from('56789\n')), /frame exceeds size limit/);
    });

    test('counts bytes per frame rather than per socket read', () => {
        const lines: string[] = [];
        const frames = new NativeRpcFrames((frame) => lines.push(frame.toString()), 8);
        frames.push(Buffer.from('12345678\nabcdefgh\n\nijklmnop\n'));
        assert.deepEqual(lines, ['12345678', 'abcdefgh', 'ijklmnop']);
    });

    test('releases unfinished bytes when the connection closes', () => {
        const lines: string[] = [];
        const frames = new NativeRpcFrames((frame) => lines.push(frame.toString()), 8);
        frames.push(Buffer.from('stale'));
        frames.clear();
        frames.push(Buffer.from('new\n'));
        assert.deepEqual(lines, ['new']);
    });
});
