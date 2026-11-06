import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { connectTcpLanguageServer } from '../../languageServerTransport';
import type { DisposableProcess } from '../../util';

suite('Language server TCP startup', function () {
    this.timeout(2000);

    function mockChild() {
        let disposals = 0;
        const child = Object.assign(new EventEmitter(), {
            dispose: () => {
                disposals++;
            },
        }) as unknown as DisposableProcess;
        return {
            child,
            get disposals() {
                return disposals;
            },
        };
    }

    async function assertPortClosed(port: number) {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        try {
            const result = await new Promise<Error | undefined>((resolve) => {
                socket.once('error', resolve);
                socket.once('connect', () => resolve(undefined));
            });
            assert.ok(result, 'a failed startup must close its listening port');
            assert.strictEqual((result as NodeJS.ErrnoException).code, 'ECONNREFUSED');
        } finally {
            socket.destroy();
        }
    }

    test('early R exit rejects startup and closes the listening socket', async () => {
        const child = mockChild();
        let port = 0;
        const startup = connectTcpLanguageServer((assignedPort) => {
            port = assignedPort;
            setImmediate(() => child.child.emit('exit', 10, null));
            return child.child;
        });
        await assert.rejects(startup, /exited before connecting with exit code 10/);
        assert.strictEqual(child.disposals, 1);
        assert.strictEqual(child.child.listenerCount('error'), 0);
        assert.strictEqual(child.child.listenerCount('exit'), 0);
        await assertPortClosed(port);
    });

    test('asynchronous spawn errors reject startup and clean up the child', async () => {
        const child = mockChild();
        let port = 0;
        const error = new Error('ENOENT');
        const startup = connectTcpLanguageServer((assignedPort) => {
            port = assignedPort;
            setImmediate(() => child.child.emit('error', error));
            return child.child;
        });
        await assert.rejects(startup, (candidate) => candidate === error);
        assert.strictEqual(child.disposals, 1);
        await assertPortClosed(port);
    });

    test('synchronous spawn failures release their listener', async () => {
        let port = 0;
        const error = new Error('spawn failed');
        const startup = connectTcpLanguageServer((assignedPort) => {
            port = assignedPort;
            throw error;
        });
        await assert.rejects(startup, (candidate) => candidate === error);
        await assertPortClosed(port);
    });

    test('cancellation terminates R and closes a listener while startup is still pending', async () => {
        const child = mockChild();
        const cancellation = new AbortController();
        let started!: (port: number) => void;
        const listening = new Promise<number>((resolve) => {
            started = resolve;
        });
        const startup = connectTcpLanguageServer((port) => {
            started(port);
            return child.child;
        }, cancellation.signal);
        const port = await listening;
        const rejected = assert.rejects(
            startup,
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
        cancellation.abort();
        await rejected;
        assert.strictEqual(child.disposals, 1);
        assert.strictEqual(child.child.listenerCount('error'), 0);
        assert.strictEqual(child.child.listenerCount('exit'), 0);
        await assertPortClosed(port);
    });

    test('an already cancelled start never launches R', async () => {
        const cancellation = new AbortController();
        cancellation.abort();
        let spawns = 0;
        await assert.rejects(
            connectTcpLanguageServer(() => {
                spawns++;
                return mockChild().child;
            }, cancellation.signal),
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
        assert.strictEqual(spawns, 0);
    });

    test('a connection succeeds after a failed attempt without disposing the running child', async () => {
        await assert.rejects(
            connectTcpLanguageServer(() => {
                throw new Error('first attempt');
            }),
        );
        const child = mockChild();
        const cancellation = new AbortController();
        let socket: net.Socket | undefined;
        const transport = await connectTcpLanguageServer((port) => {
            socket = net.createConnection({ host: '127.0.0.1', port });
            return child.child;
        }, cancellation.signal);
        try {
            cancellation.abort();
            assert.strictEqual(transport.reader, transport.writer);
            assert.strictEqual(child.disposals, 0);
            assert.strictEqual(child.child.listenerCount('error'), 0);
            assert.strictEqual(child.child.listenerCount('exit'), 0);
        } finally {
            socket?.destroy();
            transport.reader.destroy();
        }
    });
});
