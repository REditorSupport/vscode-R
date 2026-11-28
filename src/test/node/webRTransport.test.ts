import * as assert from 'node:assert/strict';
import 'vscode-jsonrpc/node';
import { createWebRMessageTransports } from '../../webr/messageTransports';

suite('webR language transport', () => {
    test('preserves message order and closes a worker exactly once', async () => {
        const received: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        let closes = 0;
        const { reader, writer } = createWebRMessageTransports({
            async dispatch(message) {
                if (++calls === 1) {
                    await gate;
                }
                return [message];
            },
            close() {
                closes++;
            },
        });
        let delivered!: () => void;
        const both = new Promise<void>((resolve) => {
            delivered = resolve;
        });
        reader.listen((message) => {
            received.push(JSON.stringify(message));
            if (received.length === 2) {
                delivered();
            }
        });
        const first = { jsonrpc: '2.0', id: 1, method: 'initialize' };
        const second = { jsonrpc: '2.0', id: 2, method: 'shutdown' };
        const writes = Promise.all([writer.write(first), writer.write(second)]);
        await writes;
        release();
        await both;
        assert.deepEqual(received, [JSON.stringify(first), JSON.stringify(second)]);
        writer.end();
        reader.dispose();
        writer.dispose();
        assert.equal(closes, 1);
    });

    test('cancels queued requests without evaluating their R code', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const executed: string[] = [];
        const responses: string[] = [];
        const { reader, writer } = createWebRMessageTransports({
            async dispatch(message) {
                executed.push(JSON.stringify(message));
                await gate;
                return [];
            },
            close() {},
        });
        reader.listen((reply) => responses.push(JSON.stringify(reply)));
        const first = { jsonrpc: '2.0', id: 1, method: 'textDocument/hover' };
        const next = { ...first, id: 2 };
        const cancel = { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 2 } };
        const writes = Promise.all([writer.write(first), writer.write(next)]);
        await writes;
        await writer.write(cancel);
        release();
        await writer.write({ jsonrpc: '2.0', method: 'exit' } as typeof first);
        assert.deepEqual(executed, [
            JSON.stringify(first),
            JSON.stringify({ jsonrpc: '2.0', method: 'exit' }),
        ]);
        assert.deepEqual(JSON.parse(responses[0]) as unknown, {
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32800, message: 'Request cancelled' },
        });
        reader.dispose();
        writer.dispose();
    });
});
