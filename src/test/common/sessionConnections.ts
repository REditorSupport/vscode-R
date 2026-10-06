import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as session from '../../session';

export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

export async function waitForValue<T>(condition: () => T | undefined, timeout = 10000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = condition();
        if (value !== undefined) { return value; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for a session transition');
}

/** Real IPC handshakes shared by terminal routing and startup regressions. */
export class SessionConnections {
    private readonly clients: net.Socket[] = [];
    private readonly sockets: session.Session['socket'][] = [];
    private readonly ids = new Set<string>();

    async attach(id: string, pid: number, host = os.hostname()): Promise<session.Session['socket']> {
        const socket = await this.startAttach(id, pid, host);
        await waitForValue(() => socket._sessionId === id ? socket : undefined);
        assert.strictEqual(socket.destroyed, false);
        return socket;
    }

    /** Start a handshake without waiting for asynchronous terminal discovery. */
    async startAttach(id: string, pid: number, host = os.hostname()): Promise<session.Session['socket']> {
        const endpoint = await session.getGlobalPipePath();
        const previous = new Set(session.activeConnections);
        const client = net.createConnection(endpoint);
        this.clients.push(client);
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });
        const socket = await waitForValue(() => [...session.activeConnections].find(candidate => !previous.has(candidate)));
        this.sockets.push(socket);
        this.ids.add(id);
        client.write(`${JSON.stringify({
            jsonrpc: '2.0', method: 'attach', params: {
                protocol_version: 2, session_id: id, host, pid,
                version: '4.4.0', tempdir: '/tmp', wd: '/tmp',
            },
        })}\n`);
        return socket;
    }

    async dispose(): Promise<void> {
        for (const id of this.ids) { await session.cleanupSession(id); }
        this.clients.forEach(client => client.destroy());
        this.sockets.forEach(socket => socket.destroy());
    }
}
