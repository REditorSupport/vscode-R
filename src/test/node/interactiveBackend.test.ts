import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import * as net from 'net';
import { spawn } from 'child_process';
import { localEndpoint } from '../../interactive/transport';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { readSessionManifest } from '../../interactive/launcher';
import { stopSession } from '../../interactive/sessionLifecycle';
import {
    AgentConfig,
    ExecutionRecord,
    SessionEvent,
    SessionManifest,
    Submission,
} from '../../interactive/protocol';
import {
    BackendEvent,
    ClientReply,
    DispatchNotSentError,
    InspectionRequest,
    SessionBackend,
    StopRefusedError,
} from '../../interactive/backend';
import {
    backendDescriptor,
    backendDefinition,
    createBackend,
    prepareBackendRuntime,
    withBackend,
} from '../../interactive/backendRegistry';
import { Arf } from '../../interactive/backends/arf';
import { ARF_METHOD_NOT_FOUND, ArfRpcError } from '../../interactive/arf';
import { INSPECTION_SELECTORS, inspectionFailure } from '../../interactive/backends/arfInspection';
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
    inspectResult: (request: InspectionRequest) => Promise<unknown> = () =>
        Promise.resolve({ marker: 42 });
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
    inspect(request: InspectionRequest): Promise<unknown> {
        return this.inspectResult(request);
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
    stopResult: () => Promise<void> = () => {
        this.emit({ type: 'exit', code: 0 });
        return Promise.resolve();
    };
    stop(): Promise<void> {
        return this.stopResult();
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

// A fake backend still uses the agent's real local transport.
suite('Interactive backend contract', function () {
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

    test('a workspace that could not be written to the journal is published again by the next read', async () => {
        const latest = { revision: 2, globalenv: { after: {} } };
        let calls = 0;
        // Like R, reply unchanged when asked about the revision it has.
        backend.inspectResult = (request) => {
            calls++;
            return Promise.resolve(request.params?.revision === 2 ? { unchanged: true } : latest);
        };
        const journal = (agent as unknown as { journal: { append: (type: string) => unknown } })
            .journal;
        const append = journal.append.bind(journal);
        let failures = 0;
        journal.append = (type: string, ...rest: unknown[]) => {
            if (type === 'workspace' && failures++ === 0) {
                throw new Error('journal write failed');
            }
            return (append as (...args: unknown[]) => unknown)(type, ...rest);
        };
        const before = events.length;
        const published = () => events.slice(before).filter((event) => event.type === 'workspace');
        const previous = (await client.snapshot()).workspace;
        backend.emit({ type: 'workspaceChanged' });
        await until(() => calls === 1);
        // The cache keeps the last workspace that was published.
        assert.deepStrictEqual((await client.snapshot()).workspace, previous);
        assert.strictEqual(published().length, 0);
        backend.emit({ type: 'workspaceChanged' });
        await until(() => published().length > 0);
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(published()[0].data, latest);
        assert.deepStrictEqual((await client.snapshot()).workspace, latest);
    });

    const inspectionError = (kind: string) =>
        Object.assign(new Error(`Inspection ${kind}`), { name: 'InspectionError', kind });
    // A failure as the arf backend reports an error response with this code.
    const arfFailure = (code: number) =>
        inspectionFailure(new ArfRpcError(code, 'failed', undefined, {}), 'workspace', {
            queue: 2000,
            execution: 2000,
            transport: 9000,
        });

    // R never started these inspections: one waited too long to start, and
    // the others were not queued by the client or by arf.
    for (const [name, failure] of [
        ['timed out waiting to start', () => arfFailure(-32012)],
        ['not queued by the client', () => inspectionError('overloaded')],
        ['not queued by arf', () => arfFailure(-32011)],
    ] as const) {
        test(`a workspace inspection ${name} after an execution is retried without another demand`, async () => {
            const id = await submit();
            backend.emit({ type: 'started', executionId: id });
            let calls = 0;
            backend.inspectResult = () =>
                ++calls === 1
                    ? Promise.reject(failure())
                    : Promise.resolve({ revision: 7, globalenv: { after: {} } });
            backend.emit({ type: 'finished', executionId: id, state: 'success' });
            await until(() =>
                events.some((event) => event.type === 'workspace' && event.data.revision === 7),
            );
            assert.strictEqual(calls, 2);
            assert.deepStrictEqual((await client.snapshot()).workspace, {
                revision: 7,
                globalenv: { after: {} },
            });
        });
    }

    for (const [name, prepare, failure] of [
        ['an R error from the workspace inspection', () => {}, () => arfFailure(-32014)],
        [
            // The inspection may have forced a promise whose code would run again.
            'a workspace inspection interrupted at its deadline',
            () => {},
            () => arfFailure(-32019),
        ],
        [
            // An error arf does not name may come after R ran the inspection.
            'a workspace inspection arf rejected for another reason',
            () => {},
            () => arfFailure(-32099),
        ],
        [
            'an inspection that can keep running in R after it times out',
            (backend: FakeBackend) => {
                (backend.capabilities as Record<string, boolean>).inspectionDeadline = false;
            },
            () => inspectionError('queue_timeout'),
        ],
    ] as const) {
        test(`${name} is not retried without another demand`, async () => {
            prepare(backend);
            const id = await submit();
            backend.emit({ type: 'started', executionId: id });
            let calls = 0;
            backend.inspectResult = () => {
                calls++;
                return Promise.reject(failure());
            };
            backend.emit({ type: 'finished', executionId: id, state: 'success' });
            await until(() => calls === 1);
            // Longer than the first retry delay.
            await new Promise((resolve) => setTimeout(resolve, 800));
            assert.strictEqual(calls, 1);
        });
    }

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
    test('a refused Stop leaves the session, its queue and its current status unchanged', async () => {
        const running = await submit(),
            queued = await submit();
        backend.emit({ type: 'started', executionId: running });
        let refuse!: () => void;
        backend.stopResult = () =>
            new Promise<void>((_resolve, reject) => {
                refuse = () => reject(new StopRefusedError('End R in its terminal'));
            });
        const stop = assert.rejects(client.request('stop'), /End R in its terminal/);
        await until(() => refuse !== undefined);
        assert.strictEqual((await client.snapshot()).manifest.status, 'stopping');
        // The status that changes while stopping is the one restored.
        backend.emit({ type: 'finished', executionId: running, state: 'success' });
        assert.strictEqual((await client.snapshot()).manifest.status, 'stopping');
        assert.strictEqual(backend.submissions.length, 1);
        refuse();
        await stop;
        await until(() => backend.submissions.length === 2);
        assert.strictEqual(backend.submissions[1].id, queued);
        assert.strictEqual((await record(queued)).state, 'queued');
        assert.notStrictEqual((await client.snapshot()).manifest.status, 'stopping');
    });
    test('a refused Stop resumes a workspace refresh deferred while stopping', async () => {
        const running = await submit();
        backend.emit({ type: 'started', executionId: running });
        let inspections = 0;
        backend.inspectResult = () => {
            inspections++;
            return Promise.resolve({ marker: inspections });
        };
        let refuse!: () => void;
        backend.stopResult = () =>
            new Promise<void>((_resolve, reject) => {
                refuse = () => reject(new StopRefusedError('End R in its terminal'));
            });
        const stop = assert.rejects(client.request('stop'), /End R in its terminal/);
        await until(() => refuse !== undefined);
        backend.emit({ type: 'finished', executionId: running, state: 'success' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const before = inspections;
        refuse();
        await stop;
        await until(() => inspections > before);
    });
    test('an adopted session served by an older agent is not asked to stop', async () => {
        // An agent from an earlier extension version terminated an adopted arf
        // on Stop and does not advertise that it no longer does.
        const manifest = (agent as unknown as { manifest: SessionManifest }).manifest;
        manifest.ownership = 'adopted';
        manifest.provider = 'arf-existing';
        delete manifest.capabilities.adoptedStop;
        let stops = 0;
        backend.stopResult = () => {
            stops++;
            return Promise.resolve();
        };
        await assert.rejects(
            stopSession(manifest, client.clientId),
            /earlier version of the extension.*End R in the terminal/,
        );
        assert.strictEqual(stops, 0);
        manifest.capabilities.adoptedStop = true;
        backend.stopResult = () => {
            stops++;
            backend.emit({ type: 'exit', code: 0 });
            return Promise.resolve();
        };
        await stopSession(manifest, client.clientId);
        assert.strictEqual(stops, 1);
    });
    test('overlapping Stop requests each receive the outcome of the one in flight', async () => {
        let refuse!: () => void;
        let stops = 0;
        backend.stopResult = () => {
            stops++;
            return new Promise<void>((_resolve, reject) => {
                refuse = () => reject(new StopRefusedError('End R in its terminal'));
            });
        };
        const first = assert.rejects(client.request('stop'), /End R in its terminal/);
        await until(() => refuse !== undefined);
        const second = assert.rejects(client.request('stop'), /End R in its terminal/);
        // The agent has received the second Stop once it answers a later request.
        await client.request('heartbeat');
        refuse();
        await Promise.all([first, second]);
        assert.strictEqual(stops, 1);
    });
    test('a refused Stop reads the workspace before it dispatches the next queued cell', async () => {
        const running = await submit(),
            queued = await submit();
        backend.emit({ type: 'started', executionId: running });
        const dispatchedAtInspection: number[] = [];
        backend.inspectResult = () => {
            dispatchedAtInspection.push(backend.submissions.length);
            return Promise.resolve({ marker: dispatchedAtInspection.length });
        };
        let refuse!: () => void;
        backend.stopResult = () =>
            new Promise<void>((_resolve, reject) => {
                refuse = () => reject(new StopRefusedError('End R in its terminal'));
            });
        const stop = assert.rejects(client.request('stop'), /End R in its terminal/);
        await until(() => refuse !== undefined);
        backend.emit({ type: 'finished', executionId: running, state: 'success' });
        // The refusal arrives after the completion has been handled.
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.strictEqual(dispatchedAtInspection.length, 0);
        refuse();
        await stop;
        await until(() => backend.submissions.length === 2);
        assert.strictEqual(backend.submissions[1].id, queued);
        assert.ok(dispatchedAtInspection.includes(1), JSON.stringify(dispatchedAtInspection));
    });
    test('an agent whose stopped runtime exits after every client left shuts down', async () => {
        backend.stopResult = () => Promise.reject(new Error('accepted but has not exited yet'));
        await assert.rejects(client.request('stop'), /has not exited yet/);
        client.close();
        await new Promise((resolve) => setTimeout(resolve, 50));
        backend.emit({ type: 'exit', code: 0 });
        await until(() => (agent as unknown as { stopped: boolean }).stopped);
    });
    test('a Stop that fails without refusing keeps stopping and cancels the queue', async () => {
        const running = await submit(),
            queued = await submit();
        backend.emit({ type: 'started', executionId: running });
        backend.stopResult = () => Promise.reject(new Error('accepted but has not exited yet'));
        await assert.rejects(client.request('stop'), /has not exited yet/);
        assert.strictEqual((await client.snapshot()).manifest.status, 'stopping');
        assert.strictEqual((await record(queued)).state, 'cancelled');
        backend.emit({ type: 'exit', code: 0 });
        assert.strictEqual((await client.snapshot()).manifest.status, 'exited');
        assert.strictEqual(backend.submissions.length, 1);
    });
    test('a later Stop reports that an accepted shutdown has not finished yet', async () => {
        let stops = 0;
        backend.stopResult = () => {
            stops++;
            return Promise.reject(new Error('accepted but has not exited yet'));
        };
        await assert.rejects(client.request('stop'), /has not exited yet/);
        await assert.rejects(client.request('stop'), /has not exited yet/);
        assert.strictEqual(stops, 1);
        backend.emit({ type: 'exit', code: 0 });
        await client.request('stop');
        assert.strictEqual(stops, 1);
    });
    test('a cell whose dispatch could not reach R stays queued and is sent once R is reached', async () => {
        let attempts = 0;
        backend.dispatchResult = () =>
            ++attempts === 1
                ? Promise.reject(new DispatchNotSentError('arf could not be reached'))
                : Promise.resolve();
        const id = await submit();
        await until(() => attempts === 1);
        assert.strictEqual((await record(id)).state, 'queued');
        assert.notStrictEqual((await client.snapshot()).manifest.status, 'unknown');
        await until(() => attempts === 2);
        assert.deepStrictEqual(
            backend.submissions.map((item) => item.id),
            [id, id],
        );
        backend.emit({ type: 'started', executionId: id });
        backend.emit({ type: 'finished', executionId: id, state: 'success' });
        assert.strictEqual((await record(id)).state, 'success');
    });
    test('a cell found unsent after Stop cancelled the queue is cancelled, not queued again', async () => {
        let fail!: () => void;
        backend.dispatchResult = () =>
            new Promise<void>((_resolve, reject) => {
                fail = () => reject(new DispatchNotSentError('arf could not be reached'));
            });
        const id = await submit();
        await until(() => fail !== undefined);
        backend.stopResult = () => Promise.reject(new Error('accepted but has not exited yet'));
        await assert.rejects(client.request('stop'), /has not exited yet/);
        fail();
        await until(() =>
            events.some((event) => event.executionId === id && event.type === 'finished'),
        );
        assert.strictEqual((await record(id)).state, 'cancelled');
        assert.strictEqual(backend.submissions.length, 1);
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
        let fail: (() => void) | undefined;
        failing.startResult = () =>
            new Promise((_, reject) => {
                fail = () => reject(new Error('Partial start'));
            });
        config = { ...config, storage: path.join(root, 'failed') };
        agent = new SessionAgent(config, () => failing);
        const startup = assert.rejects(agent.start(), /Partial start/);
        await until(() => !!fail);
        const initial = readSessionManifest(config.storage, config.id, config.generation);
        assert.ok(initial && !initial.startupError);
        client.close();
        client = new AgentClient(initial);
        await client.connect();
        const disconnected = new Promise<void>((resolve) => client.once('disconnect', resolve));
        fail!();
        await disconnected;
        assert.strictEqual(
            readSessionManifest(config.storage, config.id, config.generation)?.startupError,
            'Partial start',
        );
        assert.strictEqual(readSessionManifest(config.storage, config.id, 'other'), undefined);
        await startup;
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
                                    arf_version: '0.7.2-rc.1',
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
        const endpoint = localEndpoint(root, 'arf.sock');
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
            await adapter.start({});
            await adapter.bootstrap('bootstrap');
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
    async function fakeAttachedArf(
        handlerApi: Record<string, unknown>,
        sessionMetadata?: () => unknown,
        answer?: (method: string) => Record<string, unknown> | undefined,
    ): Promise<{
        endpoint: string;
        calls: Record<string, unknown>[];
        /** Methods requested over HTTP and, prefixed with `attach:`, over attach connections. */
        methods: string[];
        /**
         * Serve another arf from now on, as a socket path reused by a new
         * session would. Open connections close unless `keepConnections`.
         */
        replace(sessionId: string, keepConnections?: boolean): void;
        /** Stop or resume accepting connections; open ones stay open. */
        listening(listen: boolean): Promise<void>;
        close(): Promise<void>;
    }> {
        const calls: Record<string, unknown>[] = [];
        const methods: string[] = [];
        let sessionId = 'fake';
        const http = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => {
                body += chunk.toString();
            });
            request.on('end', () => {
                const { id, method } = JSON.parse(body) as { id: number; method: string };
                methods.push(method);
                const result = method === 'session' ? sessionMetadata?.() : { status: 'ok' };
                response.end(
                    JSON.stringify({ jsonrpc: '2.0', id, ...(answer?.(method) ?? { result }) }),
                );
            });
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
                const reply = (message: Record<string, unknown>): void => {
                    if (message.method === 'attach') {
                        socket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: message.id,
                                result: {
                                    connection_id: 1,
                                    api_version: 1,
                                    capabilities: ['events', 'call_execution_timeout'],
                                    session_id: sessionId,
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
                    } else {
                        const method = String(message.method);
                        methods.push(`attach:${method}`);
                        socket.write(
                            JSON.stringify({
                                jsonrpc: '2.0',
                                id: message.id,
                                ...(answer?.(method) ?? { result: { status: 'ok' } }),
                            }) + '\n',
                        );
                    }
                };
                let buffer = '';
                const read = (data: Buffer): void => {
                    buffer += data.toString();
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        reply(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
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
            methods,
            replace: (id, keepConnections = false) => {
                sessionId = id;
                if (!keepConnections) {
                    sockets.forEach((socket) => socket.destroy());
                }
            },
            listening: (listen) =>
                new Promise<void>((resolve) => {
                    if (listen) {
                        listener.listen(endpoint, resolve);
                    } else {
                        // close() calls back only once open connections end.
                        listener.close();
                        resolve();
                    }
                }),
            close: async () => {
                sockets.forEach((socket) => socket.destroy());
                http.closeAllConnections();
                await new Promise<void>((resolve) => listener.close(() => resolve()));
            },
        };
    }

    async function adopt(
        handlerApi: Record<string, unknown>,
        sessionMetadata?: () => unknown,
        answer?: (method: string) => Record<string, unknown> | undefined,
    ): Promise<{
        adapter: Arf;
        arf: Awaited<ReturnType<typeof fakeAttachedArf>>;
        calls: Record<string, unknown>[];
        methods: string[];
        close(): Promise<void>;
    }> {
        const arf = await fakeAttachedArf(handlerApi, sessionMetadata, answer);
        const adapter = new Arf(
            'unused',
            root,
            arf.endpoint,
            true,
            () => undefined,
            'token',
            () => undefined,
        );
        await adapter.start({});
        await adapter.bootstrap('bootstrap');
        return {
            adapter,
            arf,
            calls: arf.calls,
            methods: arf.methods,
            close: async () => {
                adapter.dispose();
                await arf.close();
            },
        };
    }

    test('reads the active R environment after an adopted arf becomes available', async () => {
        let requests = 0;
        const session = await adopt({}, () =>
            ++requests === 1
                ? { r: null, r_unavailable_reason: 'R is busy evaluating another expression' }
                : { r_home: '/target', r: { lib_paths: ['/project', '/personal'] } },
        );
        try {
            assert.deepStrictEqual(await session.adapter.rEnvironment(), {
                rHome: '/target',
                libraryPaths: ['/project', '/personal'],
            });
            assert.strictEqual(requests, 2);
        } finally {
            await session.close();
        }
    });

    test('rejects malformed R library metadata without retrying', async () => {
        let requests = 0;
        const session = await adopt({}, () => ({
            r: { lib_paths: ++requests === 1 ? [42] : ['/unexpected'] },
        }));
        try {
            await assert.rejects(session.adapter.rEnvironment(), /library paths/i);
            assert.strictEqual(requests, 1);
        } finally {
            await session.close();
        }
    });

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
            assert.strictEqual(session.calls.length, 1);
            const { queue_timeout_ms: queue, ...sent } = session.calls[0];
            assert.deepStrictEqual(sent, {
                handler: 'vscode-r.inspect.json/hover',
                args: '{"expr":"x"}',
                execution_timeout_ms: 2000,
            });
            // What is left of the wait to start, measured from the request, so
            // it can be less than the timeout by the time the call is sent.
            assert.ok(
                Number.isInteger(queue) && Number(queue) > 0 && Number(queue) <= 2000,
                String(queue),
            );
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

    test('a managed arf that does not publish every selector fails to start', async () => {
        const arf = await fakeAttachedArf({
            state: 'locked',
            handlers: INSPECTION_SELECTORS.slice(1),
        });
        // Stands in for `arf headless --json`: it reports the fake's endpoint.
        const command = path.join(root, 'arf');
        fs.writeFileSync(
            command,
            `#!/bin/sh\necho '${JSON.stringify({ socket_path: arf.endpoint })}'\nexec sleep 30\n`,
            { mode: 0o755 },
        );
        const adapter = new Arf(
            command,
            root,
            undefined,
            false,
            () => undefined,
            'token',
            () => undefined,
        );
        try {
            await assert.rejects(
                adapter.start({}),
                /did not publish the R Interactive inspection handlers/,
            );
        } finally {
            adapter.dispose();
            await arf.close();
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

    /** Stands in for the adopted R process, which Stop must never terminate. */
    async function standIn(): Promise<{ pid: number; alive(): boolean; end(): void }> {
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
            stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
        return {
            pid: child.pid!,
            alive: () => child.exitCode === null && child.signalCode === null,
            end: () => child.kill('SIGKILL'),
        };
    }
    test('an adopted arf that rejects shutdown refuses Stop and keeps running', async () => {
        const runtime = await standIn();
        let session: Awaited<ReturnType<typeof adopt>> | undefined;
        try {
            session = await adopt({}, undefined, (method) =>
                method === 'shutdown'
                    ? { error: { code: ARF_METHOD_NOT_FOUND, message: 'Method not found' } }
                    : undefined,
            );
            session.adapter.process.setPid(runtime.pid);
            await assert.rejects(
                session.adapter.stop(),
                (error: unknown) =>
                    error instanceof StopRefusedError &&
                    /terminal that started arf/.test(error.message),
            );
            await assert.rejects(session.adapter.stop(true), StopRefusedError);
            assert.strictEqual(
                session.methods.filter((method) => method === 'attach:shutdown').length,
                1,
            );
            assert.ok(runtime.alive());
            // The same connection still evaluates after the refusal.
            await session.adapter.dispatch({ id: randomUUID(), code: 'still_running()' });
            assert.ok(runtime.alive());
        } finally {
            runtime.end();
            await session?.close();
        }
    });
    test('Stop does not shut down another arf that now serves the adopted socket path', async () => {
        const runtime = await standIn();
        let session: Awaited<ReturnType<typeof adopt>> | undefined;
        try {
            session = await adopt({});
            session.adapter.process.setPid(runtime.pid);
            session.arf.replace('another arf');
            await assert.rejects(
                session.adapter.stop(),
                (error: unknown) =>
                    error instanceof StopRefusedError && /different session/.test(error.message),
            );
            assert.ok(!session.methods.includes('attach:shutdown'));
            assert.ok(runtime.alive());
            // Code queued behind the refused Stop is not sent to the other arf,
            // so the agent keeps it queued.
            const evaluations = session.methods.filter((method) => method === 'evaluate').length;
            await assert.rejects(
                session.adapter.dispatch({ id: randomUUID(), code: 'queued()' }),
                (error: unknown) =>
                    error instanceof DispatchNotSentError &&
                    /different session/.test(error.message),
            );
            assert.strictEqual(
                session.methods.filter((method) => method === 'evaluate').length,
                evaluations,
            );
        } finally {
            runtime.end();
            await session?.close();
        }
    });
    test('code is sent after a Stop refused for another session only once arf is verified again', async () => {
        const runtime = await standIn();
        let session: Awaited<ReturnType<typeof adopt>> | undefined;
        try {
            session = await adopt({});
            session.adapter.process.setPid(runtime.pid);
            const evaluations = (): number =>
                session!.methods.filter((method) => method === 'evaluate').length;
            // The attach connection to the adopted arf stays open.
            session.arf.replace('another arf', true);
            await assert.rejects(session.adapter.stop(), StopRefusedError);
            const before = evaluations();
            await assert.rejects(
                session.adapter.dispatch({ id: randomUUID(), code: 'queued()' }),
                (error: unknown) =>
                    error instanceof DispatchNotSentError &&
                    /different session/.test(error.message),
            );
            assert.strictEqual(evaluations(), before);
            session.arf.replace('fake', true);
            await session.adapter.dispatch({ id: randomUUID(), code: 'queued()' });
            assert.strictEqual(evaluations(), before + 1);
        } finally {
            runtime.end();
            await session?.close();
        }
    });
    test('code is not sent to an arf that took over the endpoint after a failed send', async function () {
        if (process.platform === 'win32') {
            // A named pipe cannot be closed while one of its connections stays open.
            this.skip();
        }
        const session = await adopt({});
        try {
            const evaluations = (): number =>
                session.methods.filter((method) => method === 'evaluate').length;
            const before = evaluations();
            // The endpoint goes away while the attach connection stays open.
            await session.arf.listening(false);
            await assert.rejects(
                session.adapter.dispatch({ id: randomUUID(), code: 'queued()' }),
                DispatchNotSentError,
            );
            session.arf.replace('another arf', true);
            await session.arf.listening(true);
            await assert.rejects(
                session.adapter.dispatch({ id: randomUUID(), code: 'queued()' }),
                (error: unknown) =>
                    error instanceof DispatchNotSentError &&
                    /different session/.test(error.message),
            );
            assert.strictEqual(evaluations(), before);
        } finally {
            await session.close();
        }
    });
    test('Stop that cannot reach arf is refused, as nothing was sent', async () => {
        const runtime = await standIn();
        let session: Awaited<ReturnType<typeof adopt>> | undefined;
        try {
            session = await adopt({});
            session.adapter.process.setPid(runtime.pid);
            // As after `:ipc stop`: R keeps running without an IPC server.
            await session.arf.close();
            await assert.rejects(session.adapter.stop(), StopRefusedError);
            assert.ok(runtime.alive());
        } finally {
            runtime.end();
            await session?.close();
        }
    });
    test('an adopted arf that answers shutdown with another error refuses Stop', async () => {
        const runtime = await standIn();
        let session: Awaited<ReturnType<typeof adopt>> | undefined;
        try {
            session = await adopt({}, undefined, (method) =>
                method === 'shutdown'
                    ? { error: { code: -32000, message: 'shutdown is not allowed' } }
                    : undefined,
            );
            session.adapter.process.setPid(runtime.pid);
            await assert.rejects(session.adapter.stop(), /did not accept.*not allowed/);
            assert.ok(runtime.alive());
        } finally {
            runtime.end();
            await session?.close();
        }
    });
    test('an adopted arf that accepts shutdown but stays alive is not killed, and its later exit is reported', async function () {
        this.timeout(15000);
        const runtime = await standIn();
        const exits: BackendEvent[] = [];
        const arf = await fakeAttachedArf({}).catch((error: unknown) => {
            runtime.end();
            throw error;
        });
        const adapter = new Arf(
            'unused',
            root,
            arf.endpoint,
            true,
            (event) => {
                if (event.type === 'exit') {
                    exits.push(event);
                }
            },
            'token',
            () => undefined,
        );
        try {
            await adapter.start({});
            await adapter.bootstrap('bootstrap');
            adapter.process.setPid(runtime.pid);
            await assert.rejects(
                adapter.stop(),
                /accepted the shutdown request but has not exited/,
            );
            assert.ok(runtime.alive());
            assert.strictEqual(exits.length, 0);
            runtime.end();
            const deadline = Date.now() + 5000;
            while (!exits.length && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.strictEqual(exits.length, 1);
        } finally {
            runtime.end();
            adapter.dispose();
            await arf.close();
        }
    });
    test('only a managed session promises interruptible inspection before it is ready', () => {
        assert.strictEqual(sessBackend('managed').capabilities.inspectionDeadline, true);
        assert.strictEqual(sessBackend('adopted').capabilities.inspectionDeadline, false);
    });
});
