import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { JdvPeer } from '../../jdvTransport';
import { JsonObject } from '../../jdvAdapter';

class FakeSocket extends EventEmitter {
    destroyed = false;
    write(_bytes: Buffer): boolean { return true; }
    destroy(): void { this.destroyed = true; }
    setNoDelay(): this { return this; }
}

function connection() {
    const socket = new FakeSocket();
    const reasons: string[] = [];
    const notifications: JsonObject[] = [];
    const peer = new JdvPeer(socket as unknown as Socket, {
        notification: (_peer, _method, params) => notifications.push(params),
        closed: (_peer, reason) => reasons.push(reason),
    });
    socket.emit('data', Buffer.from(JSON.stringify({ method: 'hello', params: {
        protocol: 1, session: 'test', producer: { name: 'test', version: '1' },
        limits: { max_unacked_frames: 32, max_unacked_bytes: 10485760, queue_messages: 32,
            queue_bytes: 10485760, max_request_bytes: 10485760, max_message_bytes: 10485760 },
    } }) + '\n'));
    return { socket, peer, reasons, notifications };
}

suite('jdv transport framing', () => {
    test('receives a large UTF-8 JSON line in tiny chunks', async () => {
        const { socket, peer } = connection();
        try {
            const response = peer.request('grid/rows', {});
            const value = 'λ🙂'.repeat(350000);
            const frame = Buffer.from(JSON.stringify({ id: 'vscode-r-1', result: { value } }) + '\n');
            for (let offset = 0; offset < frame.length; offset += 17) {
                socket.emit('data', frame.subarray(offset, offset + 17));
            }
            assert.deepEqual(await response, { value });
            assert.equal(peer.isClosed, false);
        } finally { peer.close('test complete'); }
    });

    test('dispatches several messages and retains a partial next line', () => {
        const { socket, peer, notifications } = connection();
        try {
            const line = (value: number) => JSON.stringify({ method: 'view/open', params: { value } }) + '\n';
            const third = line(3);
            socket.emit('data', Buffer.from(line(1) + line(2) + third.slice(0, 10)));
            assert.deepEqual(notifications, [{ value: 1 }, { value: 2 }]);
            socket.emit('data', Buffer.from(third.slice(10)));
            assert.deepEqual(notifications, [{ value: 1 }, { value: 2 }, { value: 3 }]);
        } finally { peer.close('test complete'); }
    });

    test('receives Arrow headers and bodies across every split and in one-byte chunks', async () => {
        const body = Buffer.from([0, 10, 255, 13, 123, 34, 0, 10]);
        const result = { view: 'v', generation: 1, transfer: { encoding: 'arrow-ipc', byte_length: body.length } };
        const header = Buffer.from(JSON.stringify({ id: 'vscode-r-1', result }) + '\n');
        const following = Buffer.from(JSON.stringify({ id: 'vscode-r-2', result: 'next' }) + '\n');
        const frame = Buffer.concat([header, body, following]);
        const deliveries: Buffer[][] = [];
        for (let split = 1; split < frame.length; split++) {
            deliveries.push([frame.subarray(0, split), frame.subarray(split)]);
        }
        deliveries.push(Array.from(frame, (_value, index) => frame.subarray(index, index + 1)));
        for (const chunks of deliveries) {
            const { socket, peer } = connection();
            try {
                const response = peer.requestWithBody('stream/next', { view: 'v', generation: 1 });
                const next = peer.request('grid/rows', {});
                for (const chunk of chunks) { socket.emit('data', chunk); }
                assert.deepEqual(await response, { result, body: new Uint8Array(body) });
                assert.equal(await next, 'next');
                assert.equal(peer.isClosed, false);
            } finally { peer.close('test complete'); }
        }
    });

    test('closes on an oversized unterminated line or a complete oversized line', () => {
        for (const newline of ['', '\n']) {
            const { socket, peer, reasons } = connection();
            const line = Buffer.from(JSON.stringify({ result: 'x'.repeat(10 * 1024 * 1024) }) + newline);
            for (let offset = 0; offset < line.length; offset += 16384) {
                socket.emit('data', line.subarray(offset, offset + 16384));
            }
            assert.equal(peer.isClosed, true);
            assert.equal(socket.destroyed, true);
            assert.match(reasons[0], /exceeds the size limit/);
        }
    });

    test('closes on invalid binary frame lengths and missing response ids', () => {
        for (const [id, length] of [['x', -1], ['x', 1.5], ['x', 10 * 1024 * 1024], [null, 1]]) {
            const { socket, peer, reasons } = connection();
            socket.emit('data', Buffer.from(JSON.stringify({ id,
                result: { transfer: { encoding: 'arrow-ipc', byte_length: length } },
            }) + '\n'));
            assert.equal(peer.isClosed, true);
            assert.equal(socket.destroyed, true);
            assert.match(reasons[0], /Invalid jdv binary frame/);
        }
    });
});
