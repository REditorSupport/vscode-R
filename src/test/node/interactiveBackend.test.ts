import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import * as net from 'net';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { AgentConfig, ExecutionRecord, SessionEvent, Submission } from '../../interactive/protocol';
import { BackendEvent, ClientReply, SessionBackend } from '../../interactive/backend';
import {
    backendDescriptor,
    backendDefinition,
    createBackend,
    prepareBackendRuntime,
    withBackend,
} from '../../interactive/backendRegistry';
import { Arf } from '../../interactive/backends/arf';
import { INSPECTION_SELECTORS } from '../../interactive/backends/arfInspection';
import { SessBackend } from '../../interactive/backends/sessBackend';

class FakeBackend implements SessionBackend {
    readonly ownership = 'managed' as const;
    readonly capabilities = { inspection: true, interrupt: true, restart: true, stdin: true };
    listener?: (event: BackendEvent) => void;
    submissions: Submission[] = [];
    replies: { id: string; reply: ClientReply }[] = [];
    inputs: string[] = [];
    interrupts = 0;
    disposals = 0;
    dispatchResult: () => Promise<void> = () => Promise.resolve();
    inspectResult: () => Promise<unknown> = () => Promise.resolve({ marker: 42 });
    startResult: () => Promise<void> = () => Promise.resolve();
    onEvent(listener: (event: BackendEvent) => void): () => void {
        this.listener = listener;
        return () => {
            this.listener = undefined;
        };
    }
    emit(event: BackendEvent): void {
        this.listener?.(event);
    }
    async start(): Promise<void> {
        await this.startResult();
        this.emit({
            type: 'ready',
            metadata: { rVersion: 'fake', rPath: '/fake/R', libraryPaths: ['/fake/library'] },
            capabilities: this.capabilities,
        });
    }
    dispatch(submission: Submission): Promise<void> {
        this.submissions.push(submission);
        return this.dispatchResult();
    }
    inspect(): Promise<unknown> {
        return this.inspectResult();
    }
    replyInput(reply: { value: string }): Promise<void> {
        this.inputs.push(reply.value);
        return Promise.resolve();
    }
    replyClientRequest(id: string, reply: ClientReply): Promise<void> {
        this.replies.push({ id, reply });
        return Promise.resolve();
    }
    interrupt(): Promise<void> {
        this.interrupts++;
        return Promise.resolve();
    }
    stop(): Promise<void> {
        this.emit({ type: 'exit', code: 0 });
        return Promise.resolve();
    }
    dispose(): Promise<void> {
        this.disposals++;
        return Promise.resolve();
    }
}

function fakeConfig(root: string): AgentConfig {
    return {
        id: randomUUID(),
        generation: randomUUID(),
        label: 'Fake runtime',
        directory: root,
        storage: path.join(root, 'session'),
        provider: 'r',
        backend: { kind: 'fake', options: {} },
        supervision: 'test',
        historyLimit: 50,
        maxOutputBytes: 1024 * 1024,
        maxJournalBytes: 16 * 1024 * 1024,
    };
}

suite('Interactive backend configuration', () => {
    test('normalizes legacy configs once and rejects unknown backend kinds', () => {
        const config = fakeConfig(os.tmpdir());
        const legacy: AgentConfig = {
            ...config,
            backend: undefined,
            provider: 'arf-existing',
            rPath: 'R',
            library: '/private/lib',
            resources: '/resources',
            arfEndpoint: '/arf.sock',
        };
        const descriptor = backendDescriptor(legacy);
        assert.strictEqual(descriptor.options.ownership, 'adopted');
        assert.strictEqual(descriptor.options.frontend, 'arf');
        const normalized = withBackend(legacy, descriptor);
        normalized.rPath = '/stale/legacy/R';
        assert.strictEqual(backendDescriptor(normalized).options.rPath, 'R');
        assert.throws(() => createBackend(config), /Unsupported Interactive backend/);
        assert.throws(() => backendDefinition('toString'), /Unsupported/);
        assert.throws(
            () =>
                backendDefinition('sess').preflight(
                    { ...descriptor, options: { ...descriptor.options, frontend: 'r' } },
                    legacy,
                ),
            /now requires arf/,
        );
    });
});

// A fake backend still uses the agent's real Unix socket transport.
(process.platform === 'win32' ? suite.skip : suite)('Interactive backend contract', function () {
    this.timeout(10000);
    let root: string,
        backend: FakeBackend,
        agent: SessionAgent,
        client: AgentClient,
        config: AgentConfig;
    let events: SessionEvent[];
    setup(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-backend-test-'));
        config = fakeConfig(root);
        backend = new FakeBackend();
        events = [];
        agent = new SessionAgent(config, () => backend);
        client = new AgentClient(await agent.start());
        await client.connect();
        client.on('event', (event: SessionEvent) => events.push(event));
        await client.subscribe(0);
    });
    teardown(async () => {
        client?.close();
        await agent?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    async function until(predicate: () => boolean): Promise<void> {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
            if (Date.now() > deadline) {
                throw new Error('Timed out waiting for backend event');
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    async function submit(): Promise<string> {
        const id = randomUUID();
        await client.request('submit', { submission: { id, code: 'side_effect()' } });
        return id;
    }
    const record = (id: string): Promise<ExecutionRecord> => client.request('execution', { id });

    test('prepares and runs a backend with no R executable, sess library or bootstrap', async () => {
        fs.mkdirSync(path.join(root, 'extension', 'dist'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'extension', 'dist', 'interactive-agent.js'),
            '// test bundle',
        );
        const prepared = await prepareBackendRuntime(
            config,
            {
                extensionPath: path.join(root, 'extension'),
                root: path.join(root, 'cache'),
                log: () => assert.fail(),
            },
            {
                preflight: (descriptor) => descriptor,
                prepare: (descriptor) => Promise.resolve(descriptor),
                create: () => backend,
            },
        );
        assert.strictEqual(prepared.config.rPath, undefined);
        assert.strictEqual(prepared.config.library, undefined);
        assert.deepStrictEqual(fs.readdirSync(path.join(root, 'cache', 'runtimes')), [
            path.basename(prepared.agent),
        ]);
        client.close();
        await agent.close();
        backend = new FakeBackend();
        agent = new SessionAgent(prepared.config, () => backend);
        client = new AgentClient(await agent.start());
        await client.connect();
        assert.deepStrictEqual(await client.request('inspect', { method: 'workspace' }), {
            marker: 42,
        });
        const id = await submit();
        backend.emit({ type: 'started', executionId: id });
        backend.emit({ type: 'stream', executionId: id, text: 'hello', channel: 'stdout' });
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        assert.strictEqual((await record(id)).state, 'success');
        const snapshot = await client.snapshot();
        assert.strictEqual(snapshot.manifest.rPath, '/fake/R');
        assert.ok(snapshot.manifest.capabilities.restart);
        assert.ok(
            snapshot.events.some((event) => event.type === 'stream' && event.data.text === 'hello'),
        );
        await client.request('stop');
        assert.strictEqual((await client.snapshot()).manifest.status, 'exited');
    });
    test('coalesces workspace notifications and discards metadata invalidated during inspection', async () => {
        let calls = 0;
        let release!: (value: unknown) => void;
        backend.inspectResult = () => {
            calls++;
            return calls === 1
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : Promise.resolve({ revision: 2, globalenv: { latest: {} } });
        };
        for (let i = 0; i < 20; i++) {
            backend.emit({ type: 'workspaceChanged' });
        }
        await until(() => calls === 1);
        for (let i = 0; i < 20; i++) {
            backend.emit({ type: 'workspaceChanged' });
        }
        assert.strictEqual(calls, 1);
        release({ revision: 1, globalenv: { stale: {} } });
        await until(() =>
            events.some((event) => event.type === 'workspace' && event.data.revision === 2),
        );
        assert.strictEqual(calls, 2);
        assert.ok(!events.some((event) => event.type === 'workspace' && event.data.revision === 1));
        assert.deepStrictEqual(await client.request('inspect', { method: 'workspace' }), {
            revision: 2,
            globalenv: { latest: {} },
        });
    });

    test('unchanged workspace replies retain the complete cache without publishing another event', async () => {
        let calls = 0;
        const previous = (await client.snapshot()).workspace;
        const published = events.filter((event) => event.type === 'workspace').length;
        const invalidations = events.filter(
            (event) => event.type === 'workspaceInvalidated',
        ).length;
        backend.inspectResult = () => {
            calls++;
            return Promise.resolve({ revision: 1, unchanged: true });
        };
        for (let i = 0; i < 20; i++) {
            backend.emit({ type: 'workspaceChanged' });
        }
        await until(() => calls === 1);
        await until(
            () =>
                events.filter((event) => event.type === 'workspaceInvalidated').length ===
                invalidations + 1,
        );
        assert.deepStrictEqual((await client.snapshot()).workspace, previous);
        assert.strictEqual(events.filter((event) => event.type === 'workspace').length, published);
        assert.deepStrictEqual(
            events.find((event) => event.type === 'workspaceInvalidated')!.data,
            {},
        );
    });

    test('equal legacy workspace snapshots still invalidate expanded child values', async () => {
        const previous = (await client.snapshot()).workspace;
        const invalidations = events.filter(
            (event) => event.type === 'workspaceInvalidated',
        ).length;
        backend.inspectResult = () => Promise.resolve(previous);
        backend.emit({ type: 'workspaceChanged' });
        await until(
            () =>
                events.filter((event) => event.type === 'workspaceInvalidated').length ===
                invalidations + 1,
        );
        assert.deepStrictEqual((await client.snapshot()).workspace, previous);
    });

    test('manual workspace inspection invalidates children when metadata is unchanged', async () => {
        const previous = (await client.snapshot()).workspace;
        const published = events.filter((event) => event.type === 'workspace').length;
        const invalidations = events.filter(
            (event) => event.type === 'workspaceInvalidated',
        ).length;
        let calls = 0;
        backend.inspectResult = () => {
            calls++;
            return Promise.resolve({ revision: 1, unchanged: true });
        };
        assert.deepStrictEqual(await client.request('inspect', { method: 'workspace' }), previous);
        await until(
            () =>
                events.filter((event) => event.type === 'workspaceInvalidated').length ===
                invalidations + 1,
        );
        assert.strictEqual(calls, 1);
        assert.strictEqual(events.filter((event) => event.type === 'workspace').length, published);
    });

    test('handles completion before transport acknowledgement and deduplicates submissions', async () => {
        let acknowledge!: () => void;
        backend.dispatchResult = () =>
            new Promise<void>((resolve) => {
                acknowledge = resolve;
            });
        const id = await submit();
        const next = await submit();
        backend.emit({ type: 'started', executionId: id });
        backend.emit({ type: 'started', executionId: id });
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        backend.emit({ type: 'finished', executionId: id, state: 'error' });
        assert.strictEqual((await record(id)).state, 'success');
        assert.strictEqual(backend.submissions.length, 1);
        backend.dispatchResult = () => Promise.resolve();
        acknowledge();
        await until(() => backend.submissions.length === 2);
        await client.request('submit', { submission: { id, code: 'side_effect()' } });
        assert.strictEqual(backend.submissions.length, 2);
        backend.emit({ type: 'started', executionId: 'stale-execution' });
        backend.emit({ type: 'finished', executionId: 'stale-execution', state: 'success' });
        backend.emit({ type: 'finished', executionId: next, state: 'success' });
        assert.strictEqual((await record(next)).state, 'success');
        await until(() =>
            events.some((event) => event.executionId === next && event.type === 'finished'),
        );
        assert.strictEqual(
            events.filter((event) => event.executionId === id && event.type === 'started').length,
            1,
        );
        assert.strictEqual(
            events.filter((event) => event.executionId === id && event.type === 'finished').length,
            1,
        );
    });
    test('keeps lost dispatch replies unknown until completion, never resubmits code', async () => {
        backend.dispatchResult = () => Promise.reject(new Error('Lost reply'));
        const id = await submit();
        await until(() => events.some((event) => event.type === 'uncertain'));
        assert.strictEqual((await record(id)).state, 'unknown');
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        assert.strictEqual((await record(id)).state, 'success');
        assert.strictEqual(backend.submissions.length, 1);
    });
    test('transport loss does not report process exit or dispatch queued work', async () => {
        const id = await submit(),
            queued = await submit();
        backend.emit({ type: 'unavailable', message: 'IPC disconnected' });
        assert.strictEqual((await client.snapshot()).manifest.status, 'unknown');
        assert.strictEqual((await record(id)).state, 'unknown');
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        assert.strictEqual((await client.snapshot()).manifest.status, 'unknown');
        assert.strictEqual(backend.submissions.length, 1);
        backend.emit({ type: 'exit' });
        assert.strictEqual((await record(queued)).state, 'cancelled');
        backend.emit({ type: 'unavailable', message: 'Socket closed after process exit' });
        backend.emit({ type: 'ready', metadata: {}, capabilities: {} });
        assert.strictEqual((await client.snapshot()).manifest.status, 'exited');
    });
    test('observer requests and stale generations cannot invoke the backend', async () => {
        const observer = new AgentClient(client.manifest);
        await observer.connect();
        try {
            for (const method of ['submit', 'interrupt', 'stop', 'input', 'clientReply']) {
                await assert.rejects(observer.request(method), /observing/);
            }
            await assert.rejects(
                client.request('submit', {
                    generation: 'old',
                    submission: { id: randomUUID(), code: 'bad()' },
                }),
                /generation changed/,
            );
            assert.strictEqual(backend.submissions.length, 0);
            assert.strictEqual(backend.interrupts, 0);
        } finally {
            observer.close();
        }
    });
    test('expires runtime requests in replay and translates opaque reply IDs', async () => {
        backend.emit({ type: 'clientRequest', id: 'backend-opaque', method: 'choose', params: {} });
        await until(() => events.some((event) => event.type === 'clientRequest'));
        const event = events.find((event) => event.type === 'clientRequest')!;
        await client.request('clientReply', { id: event.data.id, result: 'yes' });
        assert.deepStrictEqual(backend.replies, [
            { id: 'backend-opaque', reply: { error: undefined, result: 'yes' } },
        ]);
        backend.emit({ type: 'clientRequest', id: 'expired', method: 'choose', params: {} });
        backend.emit({ type: 'clientRequestExpired', id: 'expired' });
        events = [];
        await client.subscribe(0);
        assert.ok(!events.some((event) => event.type === 'clientRequest'));
    });
    test('input identity is checked and interruption remains available after inspection failure', async () => {
        const id = await submit();
        backend.emit({ type: 'input', executionId: id, data: { inputId: 17, maxLength: 10 } });
        await assert.rejects(
            client.request('input', { id: 18, executionId: id, value: 'wrong' }),
            /no longer active/,
        );
        await client.request('input', { id: 17, executionId: id, value: 'ok' });
        assert.deepStrictEqual(backend.inputs, ['ok']);
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        backend.inspectResult = () => Promise.reject(new Error('Inspection timeout'));
        await assert.rejects(client.request('inspect', { method: 'hover' }), /Inspection timeout/);
        await client.request('interrupt');
        assert.strictEqual(backend.interrupts, 1);
    });
    test('startup failure disposes once, and late events cannot write a closed journal', async () => {
        const id = await submit();
        const stale = backend.listener!;
        await agent.close();
        await agent.close();
        assert.strictEqual(backend.disposals, 1);
        stale({ type: 'finished', executionId: id, state: 'success' });
        const failing = new FakeBackend();
        failing.startResult = () => Promise.reject(new Error('Partial start'));
        const another = new SessionAgent(
            { ...config, storage: path.join(root, 'failed') },
            () => failing,
        );
        await assert.rejects(another.start(), /Partial start/);
        assert.strictEqual(failing.disposals, 1);
    });
    test('disposing an arf adapter cancels its pending HTTP request without another evaluation', async () => {
        let dispatched!: () => void;
        const received = new Promise<void>((resolve) => {
            dispatched = resolve;
        });
        let evaluations = 0;
        const server = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => {
                body += chunk.toString();
            });
            request.on('end', () => {
                const message = JSON.parse(body) as { method: string; params: { code?: string } };
                if (message.method === 'evaluate') {
                    evaluations++;
                    if (message.params.code !== 'bootstrap') {
                        dispatched();
                        return;
                    }
                }
                response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } }));
            });
        });
        // arf serves attach (newline-delimited JSON) and HTTP on one endpoint.
        const listener = net.createServer((socket) => {
            socket.once('data', (chunk: Buffer) => {
                if (chunk[0] === '{'.charCodeAt(0)) {
                    const attach = JSON.parse(chunk.toString()) as { id: number };
                    socket.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: attach.id,
                            result: {
                                connection_id: 1,
                                api_version: 1,
                                capabilities: ['events', 'call_execution_timeout'],
                                session_id: 'fake',
                                session: {
                                    arf_version: '0.7.1',
                                    capabilities: ['call_execution_timeout'],
                                },
                            },
                        }) + '\n',
                    );
                } else {
                    socket.pause();
                    socket.unshift(chunk);
                    server.emit('connection', socket);
                    socket.resume();
                }
            });
            socket.on('error', () => undefined);
        });
        const endpoint = path.join(root, 'arf.sock');
        await new Promise<void>((resolve) => listener.listen(endpoint, resolve));
        const adapter = new Arf(
            'unused',
            root,
            endpoint,
            true,
            () => undefined,
            'token',
            () => undefined,
        );
        try {
            await adapter.start('bootstrap', {});
            const pending = adapter.dispatch({ id: randomUUID(), code: 'side_effect()' });
            const rejected = assert.rejects(pending, /aborted/i);
            await received;
            adapter.dispose();
            await rejected;
            assert.strictEqual(evaluations, 2);
        } finally {
            adapter.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve) => listener.close(() => resolve()));
        }
    });
});

(process.platform === 'win32' ? suite.skip : suite)('Interactive inspection routing', function () {
    this.timeout(10000);
    let root: string;
    let endpoints = 0;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-inspection-routing-'));
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    /**
     * An arf that serves attach and handler calls on the attach connection and
     * evaluate over HTTP, as the real one does on one endpoint.
     */
    async function fakeAttachedArf(handlerApi: Record<string, unknown>): Promise<{
        endpoint: string;
        calls: Record<string, unknown>[];
        close(): Promise<void>;
    }> {
        const calls: Record<string, unknown>[] = [];
        const http = createServer((request, response) => {
            request.resume();
            request.on('end', () =>
                response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } })),
            );
        });
        const sockets = new Set<net.Socket>();
        const listener = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.once('data', (chunk: Buffer) => {
                if (chunk[0] !== '{'.charCodeAt(0)) {
                    socket.pause();
                    socket.unshift(chunk);
                    http.emit('connection', socket);
                    socket.resume();
                    return;
                }
                const answer = (message: Record<string, unknown>): void => {
                    if (message.method === 'attach') {
                        socket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: message.id,
                                result: {
                                    connection_id: 1,
                                    api_version: 1,
                                    capabilities: ['events', 'call_execution_timeout'],
                                    session_id: 'fake',
                                    session: {
                                        arf_version: '0.7.2',
                                        capabilities: ['call_execution_timeout'],
                                        handler_api: handlerApi,
                                    },
                                },
                            }) + '\n',
                        );
                    } else if (message.method === 'call') {
                        calls.push(message.params as Record<string, unknown>);
                        socket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: message.id,
                                result: {
                                    value: JSON.stringify({ version: 1, result: { str: 'fake' } }),
                                    stdout: '',
                                    stderr: '',
                                    execution_id: 1,
                                },
                            }) + '\n',
                        );
                    }
                };
                let buffer = '';
                const read = (data: Buffer): void => {
                    buffer += data.toString();
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        answer(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
                        buffer = buffer.slice(newline + 1);
                    }
                };
                read(chunk);
                socket.on('data', read);
            });
        });
        // macOS limits Unix socket paths to 104 bytes, and its temporary
        // directory is already long.
        const endpoint = path.join(root, `arf-${++endpoints}.sock`);
        await new Promise<void>((resolve) => listener.listen(endpoint, resolve));
        return {
            endpoint,
            calls,
            close: async () => {
                sockets.forEach((socket) => socket.destroy());
                http.closeAllConnections();
                await new Promise<void>((resolve) => listener.close(() => resolve()));
            },
        };
    }

    async function adopt(handlerApi: Record<string, unknown>): Promise<{
        adapter: Arf;
        calls: Record<string, unknown>[];
        close(): Promise<void>;
    }> {
        const arf = await fakeAttachedArf(handlerApi);
        const adapter = new Arf(
            'unused',
            root,
            arf.endpoint,
            true,
            () => undefined,
            'token',
            () => undefined,
        );
        await adapter.start('bootstrap', {});
        return {
            adapter,
            calls: arf.calls,
            close: async () => {
                adapter.dispose();
                await arf.close();
            },
        };
    }

    test('an adopted arf with every selector locked runs inspection as a handler call', async () => {
        const session = await adopt({ state: 'locked', handlers: [...INSPECTION_SELECTORS] });
        try {
            assert.ok(session.adapter.callsInspection());
            assert.deepStrictEqual(
                await session.adapter.inspect({
                    method: 'hover',
                    params: { expr: 'x' },
                    timeout: 2000,
                }),
                { str: 'fake' },
            );
            assert.deepStrictEqual(session.calls, [
                {
                    handler: 'vscode-r.inspect.json/hover',
                    args: '{"expr":"x"}',
                    queue_timeout_ms: 2000,
                    execution_timeout_ms: 2000,
                },
            ]);
        } finally {
            await session.close();
        }
    });

    test('an adopted arf without the locked selectors keeps the socket and says so', async () => {
        for (const handlerApi of [
            { state: 'unexposed', handlers: [] },
            { state: 'locked', handlers: INSPECTION_SELECTORS.slice(1) },
            { state: 'revoked', handlers: [...INSPECTION_SELECTORS] },
        ]) {
            const session = await adopt(handlerApi);
            try {
                assert.ok(!session.adapter.callsInspection(), JSON.stringify(handlerApi));
            } finally {
                await session.close();
            }
        }
    });

    function sessBackend(ownership: 'managed' | 'adopted'): SessBackend {
        return new SessBackend(
            {
                id: 'id',
                generation: 'generation',
                label: 'Routing',
                directory: root,
                storage: root,
                provider: ownership === 'managed' ? 'arf' : 'arf-existing',
                supervision: 'test',
                historyLimit: 50,
                maxOutputBytes: 1024,
                maxJournalBytes: 1024,
            },
            {
                frontend: 'arf',
                ownership,
                rPath: 'R',
                library: path.join(root, 'library'),
                resources: path.join(root, 'resources'),
                plotBackend: 'standard',
            },
        );
    }

    test('inspection goes to arf handler calls when available and to the socket otherwise', async () => {
        const requests: unknown[] = [];
        for (const [ownership, calls] of [
            ['managed', true],
            ['adopted', true],
            ['adopted', false],
        ] as const) {
            const backend = sessBackend(ownership);
            try {
                (backend as unknown as { frontend: unknown }).frontend = {
                    callsInspection: () => calls,
                    inspect: (request: unknown) => {
                        requests.push(request);
                        return Promise.resolve('call');
                    },
                    dispose: () => undefined,
                };
                if (calls) {
                    assert.strictEqual(
                        await backend.inspect({ method: 'workspace', params: {} }),
                        'call',
                    );
                } else {
                    // The socket bridge is not connected here, so it rejects.
                    await assert.rejects(
                        backend.inspect({ method: 'workspace', params: {} }),
                        /R session is disconnected/,
                    );
                }
            } finally {
                await backend.dispose();
            }
        }
        assert.strictEqual(requests.length, 2);
    });

    test('only a managed session promises interruptible inspection before it is ready', () => {
        assert.strictEqual(sessBackend('managed').capabilities.inspectionDeadline, true);
        assert.strictEqual(sessBackend('adopted').capabilities.inspectionDeadline, false);
    });
});
