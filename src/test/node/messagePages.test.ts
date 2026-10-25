import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as sinon from 'sinon';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { BackendEvent, ClientReply, SessionBackend } from '../../interactive/backend';
import { AgentConfig, SessionEvent, SessionManifest, Submission } from '../../interactive/protocol';
import { JsonLines } from '../../interactive/framing';
import { MessagePages, boundedJson } from '../../interactive/messagePages';

class BackendFixture implements SessionBackend {
    readonly ownership = 'managed' as const;
    readonly capabilities = { inspection: true };
    listener?: (event: BackendEvent) => void;
    workspace: Record<string, unknown> = {};
    onEvent(listener: (event: BackendEvent) => void): () => void {
        this.listener = listener;
        return () => {
            this.listener = undefined;
        };
    }
    start(): Promise<void> {
        this.listener?.({ type: 'ready', metadata: {}, capabilities: this.capabilities });
        return Promise.resolve();
    }
    dispatch(record: Submission): Promise<void> {
        this.listener?.({ type: 'started', executionId: record.id });
        return Promise.resolve();
    }
    inspect(): Promise<unknown> {
        return Promise.resolve(this.workspace);
    }
    replyInput(): Promise<void> {
        return Promise.resolve();
    }
    replyClientRequest(_id: string, _reply: ClientReply): Promise<void> {
        return Promise.resolve();
    }
    interrupt(): Promise<void> {
        return Promise.resolve();
    }
    stop(): Promise<void> {
        return Promise.resolve();
    }
    dispose(): Promise<void> {
        return Promise.resolve();
    }
}

suite('Bounded message pages', () => {
    test('renews an idle expiry while pages continue to make progress', () => {
        const clock = sinon.useFakeTimers();
        try {
            const pages = new MessagePages();
            const reference = pages.retain({
                text: 'x'.repeat(2 * 1024 * 1024),
            }).__rInteractivePage;
            clock.tick(20000);
            const first = pages.read(reference.token, 0);
            clock.tick(20000);
            const second = pages.read(reference.token, first.next);
            assert.ok(second.next > first.next);
            clock.tick(30001);
            assert.throws(() => pages.read(reference.token, second.next), /expired/);
        } finally {
            clock.restore();
        }
    });
    test('limits scratch serialization and rejects expired or foreign cursors', () => {
        const pages = new MessagePages();
        const first = pages.retain({ text: 'x'.repeat(1024 * 1024) }).__rInteractivePage;
        assert.throws(() => pages.read('foreign', 0), /expired|cursor/);
        assert.throws(() => pages.read(first.token, -1), /cursor/);
        let offset = 0;
        const chunks: Buffer[] = [];
        while (offset < first.bytes) {
            const page = pages.read(first.token, offset);
            chunks.push(Buffer.from(page.data, 'base64'));
            offset = page.next;
        }
        assert.strictEqual(
            (JSON.parse(Buffer.concat(chunks).toString()) as { text: string }).text.length,
            1024 * 1024,
        );
        assert.throws(() => pages.read(first.token, 0), /expired/);
        assert.throws(() => boundedJson({ text: 'x'.repeat(1024) }, 100), /limit/);
    });
});

(process.platform === 'win32' ? suite.skip : suite)(
    'Paged agent snapshots and events',
    function () {
        this.timeout(15000);
        let root: string;
        setup(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-message-pages-'));
        });
        teardown(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        test('keeps large workspace metadata and the active execution within bounded wire frames', async () => {
            const backend = new BackendFixture(),
                globalenv: Record<string, unknown> = {};
            for (let i = 0; i < 10000; i++) {
                globalenv['object_' + i] = { type: 'integer', str: 'x'.repeat(200) };
            }
            backend.workspace = {
                globalenv,
                search: ['package:base'],
                loaded_namespaces: ['base'],
                revision: 1,
            };
            const config: AgentConfig = {
                id: randomUUID(),
                generation: randomUUID(),
                label: 'pages',
                directory: root,
                storage: path.join(root, 'storage'),
                provider: 'r',
                supervision: 'test',
                historyLimit: 50,
                maxOutputBytes: 4 * 1024 * 1024,
                maxJournalBytes: 32 * 1024 * 1024,
            };
            const agent = new SessionAgent(config, () => backend);
            const client = new AgentClient(await agent.start());
            try {
                await client.connect();
                await client.request('inspect', { method: 'workspace' });
                const userValue = { __rInteractivePage: { token: 'user-data', bytes: 10 } };
                const originalWorkspace = backend.workspace;
                backend.workspace = userValue;
                assert.deepStrictEqual(
                    await client.request('inspect', { method: 'hover', params: { expr: 'x' } }),
                    userValue,
                );
                backend.workspace = originalWorkspace;
                let references = 0;
                const parser = new JsonLines((message) => {
                    if (message.resultPage) {
                        references++;
                    }
                });
                (client as unknown as { socket: net.Socket }).socket.on('data', (chunk: Buffer) =>
                    parser.push(chunk),
                );
                const id = randomUUID();
                await client.request('submit', { submission: { id, code: 'print(x)' } });
                for (let i = 0; i < 128; i++) {
                    backend.listener?.({
                        type: 'stream',
                        executionId: id,
                        channel: 'stdout',
                        text: 'x'.repeat(32768),
                    });
                }
                const queued = randomUUID();
                await client.request('submit', {
                    submission: { id: queued, code: 'x'.repeat(700 * 1024) },
                });
                const snapshot = await client.snapshot(1);
                assert.strictEqual(
                    Object.keys(snapshot.workspace!.globalenv as object).length,
                    10000,
                );
                assert.strictEqual(snapshot.workspace!.revision, 1);
                assert.ok(
                    snapshot.executions.some(
                        (record) => record.id === id && record.state === 'running',
                    ),
                );
                assert.ok(
                    references > 0,
                    'Oversized snapshots must be paged rather than disconnecting',
                );
                assert.ok(client.connected);
            } finally {
                client.close();
                await agent.close();
            }
        });

        test('delivers a large live event before later small events in the same socket read', async () => {
            const manifest = {
                id: 'events',
                generation: 'generation',
                protocol: 1,
                endpoint: path.join(root, 'events.sock'),
                token: 'token',
            } as SessionManifest;
            const pages = new MessagePages();
            let connected!: net.Socket;
            const server = net.createServer((socket) => {
                connected = socket;
                const parser = new JsonLines((message) => {
                    let result: unknown;
                    if (message.method === 'hello') {
                        result = manifest;
                    } else if (message.method === 'subscribe') {
                        result = { events: [], seq: 0, reset: false };
                    } else if (message.method === 'messagePage') {
                        const params = message.params as { token: string; offset: number };
                        result = pages.read(params.token, params.offset);
                    }
                    socket.write(JSON.stringify({ id: message.id, result }) + '\n');
                });
                socket.on('data', (chunk: Buffer) => parser.push(chunk));
                socket.on('error', () => undefined);
            });
            const client = new AgentClient(manifest);
            try {
                await new Promise<void>((resolve) => server.listen(manifest.endpoint, resolve));
                await client.connect({ claim: false });
                await client.subscribe(0);
                const events: SessionEvent[] = [];
                let done!: () => void;
                const delivered = new Promise<void>((resolve) => {
                    done = resolve;
                });
                client.on('event', (event: SessionEvent) => {
                    events.push(event);
                    if (events.length === 2) {
                        done();
                    }
                });
                const event = {
                    seq: 1,
                    generation: manifest.generation,
                    time: 1,
                    type: 'workspace',
                    data: { text: 'λ'.repeat(3 * 1024 * 1024) },
                } as SessionEvent;
                connected.write(
                    JSON.stringify({ eventPage: pages.retain(event) }) +
                        '\n' +
                        JSON.stringify({
                            event: { ...event, seq: 2, type: 'state', data: { status: 'idle' } },
                        }) +
                        '\n',
                );
                await delivered;
                assert.deepStrictEqual(
                    events.map((value) => value.seq),
                    [1, 2],
                );
                assert.strictEqual((events[0].data.text as string).length, 3 * 1024 * 1024);
            } finally {
                client.close();
                connected?.destroy();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });

        test('does not carry an old page token onto a reconnected socket', async () => {
            const manifest = {
                id: 'reconnect',
                generation: 'generation',
                protocol: 1,
                endpoint: path.join(root, 'reconnect.sock'),
                token: 'token',
            } as SessionManifest;
            const pages = new MessagePages();
            let connections = 0,
                oldPageStarted!: () => void;
            const oldPage = new Promise<void>((resolve) => {
                oldPageStarted = resolve;
            });
            const methods: string[][] = [];
            const sockets = new Set<net.Socket>();
            const server = net.createServer((socket) => {
                sockets.add(socket);
                const index = connections++;
                methods.push([]);
                const parser = new JsonLines((message) => {
                    methods[index].push(String(message.method));
                    if (message.method === 'hello') {
                        socket.write(JSON.stringify({ id: message.id, result: manifest }) + '\n');
                    }
                    if (message.method === 'snapshot') {
                        socket.write(
                            JSON.stringify({
                                id: message.id,
                                resultPage: pages.retain({ text: 'x'.repeat(5 * 1024 * 1024) }),
                            }) + '\n',
                        );
                    }
                    if (message.method === 'messagePage') {
                        oldPageStarted();
                    }
                });
                socket.on('data', (chunk: Buffer) => parser.push(chunk));
                socket.on('error', () => undefined);
            });
            const client = new AgentClient(manifest);
            try {
                await new Promise<void>((resolve) => server.listen(manifest.endpoint, resolve));
                await client.connect({ claim: false });
                const request = client.snapshot();
                const rejected = assert.rejects(request, /disconnected/);
                await oldPage;
                await client.connect({ claim: false });
                await rejected;
                assert.deepStrictEqual(methods[1], ['hello']);
                assert.ok(client.connected);
            } finally {
                client.close();
                for (const socket of sockets) {
                    socket.destroy();
                }
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });
    },
);
