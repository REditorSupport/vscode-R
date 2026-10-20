import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as session from '../../session';

export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

export async function waitForValue<T>(condition: () => T | undefined, timeout = 10000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = condition();
        if (value !== undefined) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for a session transition');
}

export interface SessionAttachMetadata {
    attachmentId?: string | null;
    autoActivate?: boolean;
    plotUrl?: string;
}

/** Real IPC handshakes shared by terminal routing and startup regressions. */
export class SessionConnections {
    private readonly clients: net.Socket[] = [];
    private readonly sockets: session.Session['socket'][] = [];
    private readonly ids = new Set<string>();
    private readonly clientsById = new Map<string, net.Socket>();
    private readonly messagesById = new Map<string, string>();
    private requestSequence = 0;

    async attach(
        id: string,
        pid: number,
        host = os.hostname(),
        metadata?: SessionAttachMetadata,
    ): Promise<session.Session['socket']> {
        const socket = await this.startAttach(id, pid, host, metadata);
        await waitForValue(() => (socket._sessionId === id ? socket : undefined));
        assert.strictEqual(socket.destroyed, false);
        return socket;
    }

    /** Start a handshake without waiting for asynchronous terminal discovery. */
    async startAttach(
        id: string,
        pid: number,
        host = os.hostname(),
        metadata?: SessionAttachMetadata,
    ): Promise<session.Session['socket']> {
        const endpoint = await session.getGlobalPipePath();
        const previous = new Set(session.activeConnections);
        const client = net.createConnection(endpoint);
        this.clients.push(client);
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });
        const socket = await waitForValue(() =>
            [...session.activeConnections].find((candidate) => !previous.has(candidate)),
        );
        this.sockets.push(socket);
        this.ids.add(id);
        const payload = `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'attach',
            params: {
                protocol_version: 2,
                session_id: id,
                host,
                pid,
                version: '4.4.0',
                tempdir: '/tmp',
                wd: '/tmp',
                ...(metadata?.attachmentId !== undefined
                    ? { attachment_id: metadata.attachmentId }
                    : {}),
                ...(metadata?.autoActivate !== undefined
                    ? { auto_activate: metadata.autoActivate }
                    : {}),
                ...(metadata?.plotUrl !== undefined ? { plot_url: metadata.plotUrl } : {}),
            },
        })}\n`;
        this.clientsById.set(id, client);
        this.messagesById.set(id, payload);
        client.write(payload);
        return socket;
    }

    repeatAttach(id: string): void {
        const client = this.clientsById.get(id);
        const payload = this.messagesById.get(id);
        if (!client || !payload) {
            throw new Error(`No attach handshake is recorded for ${id}`);
        }
        client.write(payload);
    }

    async request(id: string, method: string): Promise<Record<string, unknown>> {
        const client = this.clientsById.get(id);
        if (!client) {
            throw new Error(`No client is recorded for ${id}`);
        }
        const requestId = `session-test-${++this.requestSequence}`;
        let buffer = '';
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => finish(new Error(`Timed out waiting for ${method}`)),
                5000,
            );
            const onData = (data: Buffer) => {
                buffer += data.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line) {
                        continue;
                    }
                    let response: Record<string, unknown>;
                    try {
                        response = JSON.parse(line) as Record<string, unknown>;
                    } catch {
                        continue;
                    }
                    if (response.id === requestId) {
                        finish(undefined, response);
                        return;
                    }
                }
            };
            const onError = (error: Error) => finish(error);
            const finish = (error?: Error, response?: Record<string, unknown>) => {
                clearTimeout(timeout);
                client.off('data', onData);
                client.off('error', onError);
                if (error) {
                    reject(error);
                } else {
                    resolve(response!);
                }
            };
            client.on('data', onData);
            client.once('error', onError);
            client.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: {} })}\n`,
            );
        });
    }

    async dispose(): Promise<void> {
        for (const id of this.ids) {
            await session.cleanupSession(id);
        }
        this.clients.forEach((client) => client.destroy());
        this.sockets.forEach((socket) => socket.destroy());
    }
}
