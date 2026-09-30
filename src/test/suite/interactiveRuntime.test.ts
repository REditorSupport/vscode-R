import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { arfRequest } from '../../interactive/arf';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { AgentConfig, SessionEvent, SessionManifest, ExecutionRecord } from '../../interactive/protocol';
import { defaultStorage, installRuntime } from '../../interactive/launcher';

const run = promisify(execFile);
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

(process.platform === 'win32' ? suite.skip : suite)('Interactive real R runtime', function () {
    this.timeout(60000);
    let temporary: string;
    let root: string;
    let library: string;
    let resources: string;
    let agentBundle: string;
    let agent: SessionAgent;
    let client: AgentClient;
    let manifest: SessionManifest;
    let events: SessionEvent[];

    suiteSetup(async () => {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-runtime-'));
        // Exercise the real installer and paths containing spaces, as in the macOS default.
        root = defaultStorage('darwin', temporary, {});
        const runtime = await installRuntime(process.cwd(), root, 'R', () => undefined);
        library = runtime.library; resources = runtime.resources; agentBundle = runtime.agent;
        assert.deepStrictEqual(await installRuntime(process.cwd(), root, 'R', () => assert.fail('A ready runtime should be reused')), runtime);
    });
    suiteTeardown(() => fs.rmSync(temporary, { recursive: true, force: true }));

    setup(async () => {
        events = [];
        const id = randomUUID();
        const config: AgentConfig = { id, generation: randomUUID(), label: 'Integration test',
            directory: process.cwd(), storage: path.join(root, id), rPath: 'R', library,
            resources, provider: process.env.VSCR_TEST_PROVIDER === 'arf' ? 'arf' : 'r', arfPath: process.env.ARF_PATH ?? 'arf', supervision: 'test',
            plotBackend: process.env.VSCR_TEST_STATIC ? 'standard' : 'auto', historyLimit: 50, maxOutputBytes: 1024 * 1024, maxJournalBytes: 16 * 1024 * 1024 };
        agent = new SessionAgent(config); manifest = await agent.start();
        client = new AgentClient(manifest); await client.connect();
        client.on('event', (event: SessionEvent) => events.push(event));
        await client.subscribe(0);
        await until(() => events.some(event => event.type === 'state' && event.data.status === 'idle'));
    });
    teardown(async () => { client?.close(); agent?.close(); await delay(100); });

    async function until(predicate: () => boolean, timeout = 10000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (!predicate()) {
            if (Date.now() >= deadline) { throw new Error(`Timed out. Recent events: ${JSON.stringify(events.slice(-8))}`); }
            await delay(20);
        }
    }
    async function submit(code: string, id = randomUUID()): Promise<string> {
        await client.request('submit', { submission: { id, code } }); return id;
    }
    async function finished(id: string): Promise<ExecutionRecord> {
        await until(() => events.some(event => event.executionId === id && event.type === 'finished'));
        return client.request('execution', { id });
    }
    function text(id: string): string {
        return events.filter(event => event.executionId === id && event.type === 'stream').map(event => event.data.text).join('');
    }

    test('streams output before completion and keeps one R environment', async () => {
        const id = await submit('answer <- 42; cat("early λ🙂\\n"); Sys.sleep(0.5); cat("late\\n"); answer');
        await until(() => text(id).includes('early'));
        assert.ok(!events.some(event => event.executionId === id && event.type === 'finished'));
        assert.strictEqual((await finished(id)).state, 'success');
        assert.match(text(id), /early λ🙂/); assert.match(text(id), /42/);
        const next = await submit('answer + 1'); await finished(next); assert.match(text(next), /43/);
    });

    test('reconnects after output produced without any editor and deduplicates submission', async () => {
        const code = 'counter <- 1; Sys.sleep(0.3); counter <- counter + 1; cat(counter)';
        const id = await submit(code);
        const after = events.at(-1)?.seq ?? 0;
        const identity = client.clientId; client.close();
        await delay(700);
        client = new AgentClient(manifest, identity); await client.connect();
        client.on('event', (event: SessionEvent) => events.push(event)); await client.subscribe(after);
        assert.strictEqual((await finished(id)).state, 'success');
        assert.strictEqual(client.manifest.rPid, manifest.rPid);
        await client.request('submit', { submission: { id, code } });
        const next = await submit('counter'); await finished(next); assert.match(text(next), /2/);
        assert.strictEqual((await client.snapshot()).executions.filter(record => record.id === id).length, 1);
    });

    test('native readline and scan receive execution-scoped replies', async () => {
        const id = await submit('name <- readline("Name: "); cat("hello", name); scan(n=1, quiet=TRUE)');
        await until(() => events.some(event => event.executionId === id && event.type === 'input'));
        const first = events.find(event => event.executionId === id && event.type === 'input')!;
        await client.request('input', { id: first.data.inputId, executionId: id, value: 'Ada' });
        await until(() => events.filter(event => event.executionId === id && event.type === 'input').length > 1);
        const second = events.filter(event => event.executionId === id && event.type === 'input')[1];
        await assert.rejects(client.request('input', { id: first.data.inputId, executionId: id, value: 'stale' }), /no longer active/);
        await client.request('input', { id: second.data.inputId, executionId: id, value: '7' });
        assert.strictEqual((await finished(id)).state, 'success'); assert.match(text(id), /Ada/); assert.match(text(id), /7/);
    });

    test('interrupts evaluation without losing R and cancels queued code', async () => {
        const id = await submit('kept <- 17; Sys.sleep(30)');
        await until(() => events.some(event => event.executionId === id && event.type === 'started'));
        const queued = await submit('kept <- 0'); await client.request('cancel', { id: queued });
        assert.strictEqual((await finished(queued)).state, 'cancelled');
        await client.request('interrupt', { id }); assert.strictEqual((await finished(id)).state, 'interrupted');
        const next = await submit('kept'); await finished(next); assert.match(text(next), /17/);
    });

    test('retains rich tables, plot assets, and structured errors', async () => {
        const id = await submit('plot(1:3); data.frame(x=1:3, label=c("a", "b", "c")); stop("expected error")');
        assert.strictEqual((await finished(id)).state, 'error');
        const displays = events.filter(event => event.executionId === id && event.type === 'display');
        assert.ok(displays.some(event => event.data.kind === 'table'));
        assert.ok(displays.some(event => event.data.kind === 'plot' || event.data.kind === 'image'));
        assert.ok(events.some(event => event.executionId === id && event.type === 'condition' && String(event.data.message).includes('expected error')));
        const table = displays.find(event => event.data.kind === 'table')!;
        const page = await client.request<{ rows: unknown[] }>('inspect', { method: 'dataview_page', params: {
            view_id: table.data.viewId, startRow: 1, endRow: 3, sortModel: [], filterModel: {},
        } });
        assert.strictEqual(page.rows.length, 2);
        const plot = displays.find(event => event.data.kind === 'plot');
        if (plot) { assert.match(Buffer.from(await client.request<string>('asset', { id: plot.data.svg }), 'base64').toString(), /<svg/); }
    });

    test('browser prompts remain usable through the native console', async () => {
        const id = await submit('browser(); 99');
        await until(() => events.some(event => event.executionId === id && event.type === 'input'));
        const input = events.find(event => event.executionId === id && event.type === 'input')!;
        await client.request('input', { id: input.data.inputId, executionId: id, value: 'c' });
        assert.strictEqual((await finished(id)).state, 'success'); assert.match(text(id), /99/);
    });
    test('bounds large Unicode output without corrupting it or disconnecting R', async () => {
        const id = await submit('cat(strrep("λ🙂", 900000))');
        assert.strictEqual((await finished(id)).state, 'success');
        assert.ok(!text(id).includes('�'));
        assert.ok(events.some(event => event.executionId === id && event.type === 'truncated'));
        assert.ok(Buffer.byteLength(text(id)) <= 1024 * 1024);
        const next = await submit('21 * 2'); await finished(next); assert.match(text(next), /42/);
    });

    test('serializes a queue and enforces observer control leases', async () => {
        const observer = new AgentClient(manifest);
        try {
            await observer.connect(); assert.strictEqual(observer.control, false);
            await assert.rejects(observer.request('submit', { submission: { id: randomUUID(), code: '1' } }), /observing/);
            const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => submit(`queue_value <- ${i}; Sys.sleep(0.01)`)));
            for (const id of ids) { assert.strictEqual((await finished(id)).state, 'success'); }
            const next = await submit('queue_value'); await finished(next); assert.match(text(next), /7/);
            assert.strictEqual(await observer.request('claim', { force: true }), true);
            await assert.rejects(client.request('submit', { submission: { id: randomUUID(), code: '1' } }), /observing/);
            await client.request('claim', { force: true });
        } finally { observer.close(); }
    });

    test('retains incremental plots and local HTML dependencies', async () => {
        const first = await submit('plot(1:3)'); await finished(first);
        const second = await submit('abline(h=2); sess::display(htmltools::tags$div("widget content"))');
        await finished(second);
        await until(() => events.some(event => event.executionId === second && event.type === 'display' && event.data.kind === 'html'));
        const html = events.find(event => event.executionId === second && event.data.kind === 'html');
        assert.ok(html);
        const content = Buffer.from(await client.request<string>('asset', { id: html.data.asset }), 'base64').toString();
        assert.match(content, /widget content/);
        if (client.manifest.capabilities.jgd) {
            await until(() => events.some(event => event.executionId === second && event.data.kind === 'plot'));
        }
    });


    test('keeps graphics device ownership when switching between devices', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const first = await submit('plot(1:3); first_device <- dev.cur(); jgd::jgd(); plot(3:1); second_device <- dev.cur()');
        await finished(first);
        const second = await submit('dev.set(first_device); abline(h=2); dev.set(second_device); abline(h=1.5)');
        await finished(second);
        await until(() => new Set(events.filter(event => event.executionId === second && event.data.kind === 'plot').map(event => event.data.device)).size === 2);
        assert.strictEqual((await client.request<ExecutionRecord>('execution', { id: second })).state, 'success');
    });

    test('standalone agent survives its launcher process exiting', async () => {
        const id = randomUUID();
        const config: AgentConfig = { id, generation: randomUUID(), label: 'Detached test', directory: root,
            storage: path.join(root, id), rPath: 'R', library, resources,
            provider: 'r', supervision: process.env.VSCR_TEST_TMUX ? 'tmux' : 'detached', plotBackend: 'standard',
            historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
        const script = `const {launchAgent} = require(${JSON.stringify(require.resolve('../../interactive/launcher'))});
            launchAgent(${JSON.stringify(config)}, ${JSON.stringify(agentBundle)}, 'node')
            .then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode=1; });`;
        const result = await run('node', ['-e', script]);
        const independent = new AgentClient(JSON.parse(result.stdout) as SessionManifest);
        try {
            await independent.connect();
            const execution = randomUUID();
            await independent.request('submit', { submission: { id: execution, code: 'persisted <- 42' } });
            for (let i = 0; i < 200; i++) {
                const record = await independent.request<ExecutionRecord>('execution', { id: execution });
                if (record.state === 'success') { break; }
                if (i === 199) { assert.fail('Detached execution did not complete'); }
                await delay(25);
            }
            await independent.request('stop');
            for (let i = 0; i < 100; i++) {
                if ((await independent.snapshot()).manifest.status === 'exited') { break; }
                await delay(25);
            }
            await independent.request('shutdown');
        } finally { independent.close(); }
    });

    test('adopts an existing arf process without losing its objects', async function () {
        const arf = process.env.ARF_PATH ?? 'arf';
        try { await run(arf, ['--version']); } catch { this.skip(); }
        const child = spawn(arf, ['headless', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let adopted: SessionAgent | undefined;
        let connection: AgentClient | undefined;
        try {
            const endpoint = await new Promise<string>((resolve, reject) => {
                let buffer = '';
                child.stdout.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    if (buffer.includes('\n')) { resolve(String((JSON.parse(buffer.split('\n')[0]) as { socket_path: string }).socket_path)); }
                });
                child.once('error', reject);
                child.once('exit', () => reject(new Error('arf exited before readiness')));
            });
            await arfRequest(endpoint, 'evaluate', { code: 'kept_before_adoption <- 73', visible: true });
            const id = randomUUID();
            adopted = new SessionAgent({ id, generation: randomUUID(), label: 'Adopted arf', directory: root,
                storage: path.join(root, id), rPath: 'R', library, resources,
                provider: 'arf-existing', arfEndpoint: endpoint, supervision: 'test', plotBackend: 'standard',
                historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
            const adoptedManifest = await adopted.start();
            connection = new AgentClient(adoptedManifest); await connection.connect();
            const observed: SessionEvent[] = [];
            connection.on('event', event => observed.push(event as SessionEvent)); await connection.subscribe(0);
            const execution = randomUUID();
            await connection.request('submit', { submission: { id: execution, code: 'kept_before_adoption' } });
            await until(() => observed.some(event => event.executionId === execution && event.type === 'finished'));
            assert.match(observed.filter(event => event.executionId === execution && event.type === 'stream').map(event => event.data.text).join(''), /73/);
            assert.strictEqual(connection.manifest.rPid, child.pid);
            await arfRequest(endpoint, 'evaluate', { code: 'cat("terminal-origin")', visible: true });
            await until(() => observed.some(event => event.type === 'accepted' && event.data.origin === 'terminal'));
            const terminal = observed.find(event => event.type === 'accepted' && event.data.origin === 'terminal');
            assert.ok(terminal);
            assert.match(observed.filter(event => event.executionId === terminal.executionId && event.type === 'stream').map(event => event.data.text).join(''), /terminal-origin/);

        } finally { connection?.close(); adopted?.close(); child.kill(); }
    });

});
