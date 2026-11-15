import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    ArfRpcError,
    ArfTransportTimeoutError,
    arfVersionAtLeast,
    checkArfSession,
} from '../../interactive/arf';
import { ArfAttachConnection, ArfEvent } from '../../interactive/arfAttach';

/** A fake arf server that hands each parsed line to `handle`. */
function fakeArf(
    handle: (message: Record<string, unknown>, socket: net.Socket) => void,
): Promise<{ endpoint: string; server: net.Server; dispose(): void }> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arf-attach-'));
    // arf listens on a named pipe on Windows and a Unix socket elsewhere.
    const endpoint =
        process.platform === 'win32'
            ? `\\\\.\\pipe\\${path.basename(directory)}`
            : path.join(directory, 'arf.sock');
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                handle(JSON.parse(line) as Record<string, unknown>, socket);
            }
        });
        socket.on('error', () => undefined);
    });
    return new Promise((resolve) =>
        server.listen(endpoint, () =>
            resolve({
                endpoint,
                server,
                dispose() {
                    sockets.forEach((socket) => socket.destroy());
                    server.close();
                    fs.rmSync(directory, { recursive: true, force: true });
                },
            }),
        ),
    );
}

const line = (message: unknown): string => JSON.stringify(message) + '\n';
const attachResult = {
    connection_id: 3,
    api_version: 1,
    capabilities: ['events', 'call_execution_timeout'],
    session_id: 'session-a',
    session: { arf_version: '0.7.1', capabilities: ['call_execution_timeout'] },
};

suite('arf attach connection', () => {
    test('delivers an event that arrives in the same chunk as the attach response', async () => {
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(
                    line({ jsonrpc: '2.0', id: message.id, result: attachResult }) +
                        line({
                            jsonrpc: '2.0',
                            method: 'event',
                            params: {
                                seq: 9,
                                topic: 'demo.started',
                                data: { id: 'a' },
                                execution: 7,
                            },
                        }),
                );
            }
        });
        try {
            const events: ArfEvent[] = [];
            const { connection, result } = await ArfAttachConnection.open(arf.endpoint, {
                subscribe: ['demo.*'],
                onEvent: (event) => events.push(event),
            });
            assert.strictEqual(result.sessionId, 'session-a');
            assert.strictEqual(result.session.arf_version, '0.7.1');
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepStrictEqual(events, [
                { seq: 9, topic: 'demo.started', data: { id: 'a' }, execution: 7 },
            ]);
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('matches responses by ID and keeps RPC error codes and data', async () => {
        const held: Record<string, unknown>[] = [];
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
            } else {
                held.push(message);
                if (held.length === 2) {
                    // Answer in reverse order, the second one with an error.
                    socket.write(
                        line({
                            jsonrpc: '2.0',
                            id: held[1].id,
                            error: {
                                code: -32007,
                                message: 'Request timed out',
                                data: { execution_id: 4 },
                            },
                        }) + line({ jsonrpc: '2.0', id: held[0].id, result: { first: true } }),
                    );
                }
            }
        });
        try {
            const { connection } = await ArfAttachConnection.open(arf.endpoint);
            const first = connection.request('session');
            const second = connection.request('evaluate', { code: '1' }).then(
                () => assert.fail('expected an RPC error'),
                (error: unknown) => error,
            );
            assert.deepStrictEqual(await first, { first: true });
            const error = (await second) as ArfRpcError;
            assert.ok(error instanceof ArfRpcError);
            assert.strictEqual(error.code, -32007);
            assert.strictEqual(error.rpcMessage, 'Request timed out');
            assert.deepStrictEqual(error.data, { execution_id: 4 });
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('ignores a late response after a local timeout and never reuses its ID', async () => {
        const ids: unknown[] = [];
        let late: (() => void) | undefined;
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
                return;
            }
            ids.push(message.id);
            if (message.method === 'slow') {
                late = () => socket.write(line({ jsonrpc: '2.0', id: message.id, result: 'late' }));
            } else {
                late?.();
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: 'fresh' }));
            }
        });
        try {
            const { connection } = await ArfAttachConnection.open(arf.endpoint);
            await assert.rejects(
                connection.request('slow', {}, { timeout: 20 }),
                ArfTransportTimeoutError,
            );
            assert.strictEqual(await connection.request('fast'), 'fresh');
            assert.notStrictEqual(ids[0], ids[1]);
            assert.strictEqual(connection.closed, undefined);
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('closes once, rejecting pending and later requests with the same reason', async () => {
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
            } else {
                socket.destroy();
            }
        });
        try {
            const closes: Error[] = [];
            const { connection } = await ArfAttachConnection.open(arf.endpoint, {
                onClose: (reason) => closes.push(reason),
            });
            const pending = connection.request('evaluate').then(
                () => assert.fail('expected the request to fail'),
                (error: Error) => error,
            );
            const reason = await pending;
            assert.strictEqual(closes.length, 1);
            assert.strictEqual(closes[0], reason);
            assert.strictEqual(connection.closed, reason);
            await assert.rejects(connection.request('session'), (error) => error === reason);
            connection.close();
            assert.strictEqual(closes.length, 1);
        } finally {
            arf.dispose();
        }
    });

    test('rejects a refused attach with its RPC error', async () => {
        const arf = await fakeArf((message, socket) => {
            socket.end(
                line({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32602, message: 'unsupported protocol', data: null },
                }),
            );
        });
        try {
            await assert.rejects(
                ArfAttachConnection.open(arf.endpoint),
                (error) => error instanceof ArfRpcError && error.code === -32602,
            );
        } finally {
            arf.dispose();
        }
    });
});

suite('arf version requirement', () => {
    test('compares release versions and treats prereleases as older', () => {
        assert.ok(arfVersionAtLeast('0.7.1', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.7.2', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.10.0', '0.7.1'));
        assert.ok(arfVersionAtLeast('1.0.0', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.7.2-beta.1', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7.1-beta.1', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7.0', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.5.3', '0.7.1'));
        assert.ok(!arfVersionAtLeast(undefined, '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7', '0.7.1'));
        assert.ok(!arfVersionAtLeast('latest', '0.7.1'));
    });

    test('rejects old sessions and sessions without handler call deadlines', () => {
        checkArfSession({ arf_version: '0.7.1', capabilities: ['call_execution_timeout'] });
        assert.throws(
            () => checkArfSession({ arf_version: '0.5.3', capabilities: [] }),
            /requires arf 0\.7\.1 or later, but the session runs 0\.5\.3/,
        );
        assert.throws(() => checkArfSession({}), /an unknown version/);
        assert.throws(
            () => checkArfSession({ arf_version: '0.7.1', capabilities: [] }),
            /execution deadlines/,
        );
    });
});
