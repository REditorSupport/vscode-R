import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { arfRequest, probeArfSession } from '../../interactive/arf';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { AgentConfig, SessionEvent, SessionManifest, ExecutionRecord } from '../../interactive/protocol';
import { defaultStorage, installRuntime } from '../../interactive/launcher';
import { resolveExecutable } from '../../interactive/executable';
import { resolveNodeExecutable } from '../../interactive/nodeExecutable';
import { HistoryPage } from '../../interactive/history';
import { AssetStorageStats, readAsset } from '../../interactive/assets';
import { assertSvgTextVisible } from '../svgAssertions';

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

    setup(async function () {
        events = [];
        const id = randomUUID();
        const config: AgentConfig = { id, generation: randomUUID(), label: 'Integration test',
            directory: process.cwd(), storage: path.join(root, id), rPath: 'R', library,
            resources, provider: process.env.VSCR_TEST_PROVIDER === 'arf' ? 'arf' : 'r', arfPath: process.env.ARF_PATH ?? 'arf', supervision: 'test',
            plotBackend: process.env.VSCR_TEST_STATIC || this.currentTest?.title.startsWith('standard graphics') ? 'standard' : 'auto',
            historyLimit: 50, maxOutputBytes: 1024 * 1024, maxJournalBytes: 16 * 1024 * 1024 };
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

    test('searches durable history beyond the reconnect window without executing code', async () => {
        const first = await submit('history_value <- 17 # older_unique_marker'); await finished(first);
        await finished(await submit('history_value <- history_value + 1'));
        assert.strictEqual((await client.snapshot(1)).executions.length, 1);
        const result = await client.request<HistoryPage>('history', { query: 'OLDER_UNIQUE_MARKER' });
        assert.strictEqual(result.executions[0].id, first);
        assert.strictEqual((await client.snapshot()).executions.length, 2);
        await assert.rejects(client.request('history', { before: -1 }), /cursor/);
    });

    test('renames persist across reconnect and observer actions cannot mutate the session', async () => {
        const observer = new AgentClient(manifest); await observer.connect();
        try {
            assert.strictEqual(observer.control, false);
            await assert.rejects(observer.request('rename', { label: 'wrong' }), /observing/);
            await assert.rejects(observer.request('cancelQueued'), /observing/);
            await assert.rejects(client.request('rename', { label: '\n' }), /session name/);
            assert.strictEqual(await client.request('rename', { label: ' Analysis λ ' }), 'Analysis λ');
            const saved = JSON.parse(fs.readFileSync(path.join(root, manifest.id, 'config.json'), 'utf8')) as AgentConfig;
            assert.strictEqual(saved.label, 'Analysis λ');
            observer.close(); await observer.connect();
            assert.strictEqual(observer.manifest.label, 'Analysis λ');
            assert.strictEqual(observer.control, false);
            await finished(await submit('cat(6 * 7)'));
        } finally { observer.close(); }
    });

    test('cancels queued work without interrupting the running cell', async () => {
        const running = await submit('Sys.sleep(0.4); cat("running-finished")');
        await until(() => events.some(event => event.type === 'started' && event.executionId === running));
        const queued = await submit('stop("must not execute")');
        assert.strictEqual(await client.request('cancelQueued'), 1);
        assert.strictEqual((await client.request<ExecutionRecord>('execution', { id: queued })).state, 'cancelled');
        assert.strictEqual((await finished(running)).state, 'success');
    });

    test('R process exit finishes queued cells instead of leaving them pending forever', async () => {
        const running = await submit('Sys.sleep(30)');
        await until(() => events.some(event => event.type === 'started' && event.executionId === running));
        const queued = await submit('stop("must not execute")');
        await client.request('stop');
        await until(() => events.some(event => event.type === 'state' && event.data.status === 'exited'));
        assert.strictEqual((await client.request<ExecutionRecord>('execution', { id: queued })).state, 'cancelled');
        assert.ok(events.some(event => event.type === 'finished' && event.executionId === queued));
    });

    test('closing a busy agent prevents late callbacks from writing its closed journal', async () => {
        const id = await submit('Sys.sleep(30)');
        await until(() => events.some(event => event.type === 'started' && event.executionId === id));
        agent.close();
        const file = path.join(root, manifest.id, manifest.generation, 'executions', `${id}.json`);
        const saved = fs.readFileSync(file, 'utf8');
        await delay(200);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), saved);
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

    test('data inspection preserves random draws and reproducible resampling across cells', async () => {
        const first = await submit(`set.seed(2026)
expected <- replicate(100, mean(sample(mtcars$mpg, replace=TRUE)))
set.seed(2026)
head(mtcars)`);
        assert.strictEqual((await finished(first)).state, 'success');
        const second = await submit(`View(mtcars)
sess::display(head(iris))
actual <- replicate(100, mean(sample(mtcars$mpg, replace=TRUE)))
stopifnot(identical(actual, expected))`);
        assert.strictEqual((await finished(second)).state, 'success');
        assert.strictEqual(events.filter(event => event.type === 'display' && event.data.kind === 'table').length, 3);
    });

    test('table pages retain their original data after reference-based cleaning and schema changes', async function () {
        if (!(await run('Rscript', ['-e', 'cat(requireNamespace("data.table", quietly=TRUE))'])).stdout.includes('TRUE')) { this.skip(); }
        const id = await submit('dt <- data.table::data.table(id=1:50, value=1:50); dt');
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.data.kind === 'table'); assert.ok(table);
        await finished(await submit('dt[, value := value * 100]; data.table::setnames(dt, "value", "changed"); data.table::setorder(dt, -id)'));
        const page = await client.request<{ rows: Record<string, number>[] }>('inspect', { method: 'dataview_page', params: {
            view_id: table.data.viewId, startRow: 20, endRow: 40,
        } });
        assert.deepStrictEqual(page.rows.map(row => row['2']), Array.from({ length: 20 }, (_, i) => i + 21));
        const filtered = await client.request<{ rows: Record<string, number>[] }>('inspect', { method: 'dataview_page', params: {
            view_id: table.data.viewId, startRow: 0, endRow: 20, filterModel: { '2': { type: 'greaterThan', filter: 48 } }, sortModel: [{ colId: '1', sort: 'desc' }],
        } });
        assert.deepStrictEqual(filtered.rows.map(row => row['2']), [50, 49]);
        const current = await submit('stopifnot(names(dt)[2] == "changed", dt$changed[1] == 5000)');
        assert.strictEqual((await finished(current)).state, 'success');
    });

    test('huge tables keep bounded snapshots and page the full data without materializing it', async () => {
        const id = await submit(`n <- 832976871L
huge <- structure(rep(list(seq_len(n)), 23L), names=paste0("x", 1:23),
                  class="data.frame", row.names=c(NA_integer_, -n))
huge`);
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.data.kind === 'table'); assert.ok(table);
        assert.strictEqual(table.data.totalRows, 1000);
        assert.strictEqual(table.data.sourceRows, 832976871);
        assert.notStrictEqual(table.data.fullViewId, table.data.viewId);
        assert.match(String(table.data.printedText), /first 1,000 of 832,976,871/);
        const last = await client.request<{ rows: Record<string, number>[]; totalRows: number }>('inspect', { method: 'dataview_page', params: {
            view_id: table.data.fullViewId, startRow: 832976870, endRow: 832976871,
        } });
        assert.strictEqual(last.totalRows, 832976871);
        assert.strictEqual(last.rows[0]['23'], 832976871);
        client.close(); await client.connect(); await client.subscribe(0);
        const restored = (await client.snapshot()).events.find(event => event.seq === table.seq);
        assert.strictEqual(restored?.data.fullViewId, table.data.fullViewId);
        assert.strictEqual(restored?.data.sourceRows, table.data.sourceRows);
    });

    test('large data.table snapshots stay stable while full-view queries refresh after reference edits', async function () {
        if (!(await run('Rscript', ['-e', 'cat(requireNamespace("data.table", quietly=TRUE))'])).stdout.includes('TRUE')) { this.skip(); }
        const id = await submit('dt <- data.table::data.table(id=1:2000, value=1:2000); dt');
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.data.kind === 'table'); assert.ok(table);
        const query = { method: 'dataview_page', params: { view_id: table.data.fullViewId,
            startRow: 0, endRow: 2, sortModel: [{ colId: '2', sort: 'desc' }] } };
        const before = await client.request<{ rows: Record<string, number>[] }>('inspect', query);
        assert.deepStrictEqual(before.rows.map(row => row['2']), [2000, 1999]);
        await finished(await submit('data.table::set(dt, j="value", value=-seq_len(2000L)); stop("after mutation")'));
        const after = await client.request<{ rows: Record<string, number>[] }>('inspect', query);
        assert.deepStrictEqual(after.rows.map(row => row['2']), [-1, -2]);
        await finished(await submit('data.table::setnames(dt, "value", "changed")'));
        await assert.rejects(client.request('inspect', query), /Reopen Data viewer/);
        await client.request('inspect', { method: 'dataview_init', params: { view_id: table.data.fullViewId } });
        const refreshed = await client.request<{ rows: Record<string, number>[] }>('inspect', query);
        assert.deepStrictEqual(refreshed.rows.map(row => row['2']), [-1, -2]);
        const saved = await client.request<{ rows: Record<string, number>[]; totalRows: number }>('inspect', { method: 'dataview_page', params: {
            view_id: table.data.viewId, startRow: 980, endRow: 1020,
        } });
        assert.strictEqual(saved.totalRows, 1000);
        assert.strictEqual(saved.rows.length, 20);
        assert.strictEqual(saved.rows[19]['2'], 1000);
    });

    test('data.table reference assignments stay quiet while explicit results and display remain visible', async function () {
        if (!(await run('Rscript', ['-e', 'cat(requireNamespace("data.table", quietly=TRUE))'])).stdout.includes('TRUE')) { this.skip(); }
        const setup = await submit('dt <- data.table::data.table(x=1:3)'); await finished(setup);
        for (const code of ['dt[, x := 99]', 'data.table::set(dt, j="x", value=1:3)']) {
            const id = await submit(code); assert.strictEqual((await finished(id)).state, 'success');
            assert.ok(!events.some(event => event.executionId === id && event.type === 'display'));
            assert.strictEqual(text(id), '');
        }
        for (const code of ['dt', 'dt[, x := 4:6][]', 'sess::display(dt[, x := 7:9])', 'View(dt)']) {
            const id = await submit(code); assert.strictEqual((await finished(id)).state, 'success');
            assert.strictEqual(events.filter(event => event.executionId === id && event.data.kind === 'table').length, 1);
        }
        const explicit = await submit('print(dt[, x := 10:12])'); await finished(explicit);
        assert.match(text(explicit), /10/);
        assert.ok(!events.some(event => event.executionId === explicit && event.type === 'display'));
    });

    test('respects warning suppression and warnings-as-errors during model fitting', async () => {
        for (const warn of [-1, 0, 1, 2]) {
            const id = await submit(`options(warn=${warn}); warning("model diagnostic"); after_warning <- TRUE`);
            assert.strictEqual((await finished(id)).state, warn === 2 ? 'error' : 'success');
            const conditions = events.filter(event => event.executionId === id && event.type === 'condition');
            assert.strictEqual(conditions.length, warn < 0 ? 0 : 1);
            if (warn >= 0) { assert.strictEqual(conditions[0].data.kind, warn === 2 ? 'error' : 'warning'); }
        }
        const id = await submit('options(warn=0); suppressWarnings(warning("hidden diagnostic")); warning("visible diagnostic")');
        assert.strictEqual((await finished(id)).state, 'success');
        assert.deepStrictEqual(events.filter(event => event.executionId === id && event.type === 'condition').map(event => event.data.message), ['visible diagnostic']);
    });

    test('retains class-specific R printing beside rich tables without rerunning code', async function () {
        const probe = await run('Rscript', ['-e', 'cat(requireNamespace("data.table", quietly=TRUE))']);
        if (!probe.stdout.includes('TRUE')) { this.skip(); }
        const id = await submit(`library(data.table)
options(digits=4)
dt <- data.table(x=1:5, y=letters[1:5], z=c(1/3, pi, 0.00123, 12345, NA_real_))
expected_print <- paste0(paste(capture.output(print(dt)), collapse="\\n"), "\\n")
dt`);
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.data.kind === 'table');
        assert.ok(table);
        const printed = String(table.data.printedText);
        assert.match(printed, /<int>.*<char>.*<num>/);
        assert.ok(!text(id).includes('<int>'), 'The snapshot must not leak a second table into stdout');
        const expected = await submit('cat(expected_print)'); await finished(expected);
        assert.strictEqual(printed, text(expected));
        const explicit = await submit('print(dt)'); await finished(explicit);
        assert.strictEqual(text(explicit), printed);
        assert.ok(!events.some(event => event.executionId === explicit && event.data.kind === 'table'));
        await finished(await submit('dt[, z := 99]; options(digits=7)'));
        assert.strictEqual((await client.snapshot()).events.find(event => event.seq === table.seq)?.data.printedText, printed);
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

    test('condition traces retain user calls without worker or transport scaffolding', async () => {
        const id = await submit('live_outer <- function() live_inner(); live_inner <- function() stop("nested failure"); live_outer()');
        assert.strictEqual((await finished(id)).state, 'error');
        const condition = events.find(event => event.executionId === id && event.type === 'condition');
        assert.ok(condition);
        const trace = condition.data.trace as string[];
        assert.deepStrictEqual(trace, ['live_outer()', 'live_inner()', 'stop("nested failure")']);
        for (const code of ['warning("test warning")', 'message("test message")', '1 +']) {
            const other = await submit(code); await finished(other);
            const result = events.find(event => event.executionId === other && event.type === 'condition');
            assert.ok(result);
            assert.ok((result.data.trace as string[]).length < 5);
            assert.doesNotMatch(JSON.stringify(result.data.trace), /interactive_execute|tryCatch|diagnostic|\.handleSimpleError/);
        }
        const shadow = await submit('local({ eval <- function() stop("user eval"); eval() })');
        await finished(shadow);
        const shadowCondition = events.find(event => event.executionId === shadow && event.type === 'condition');
        assert.ok(shadowCondition);
        const shadowTrace = shadowCondition.data.trace as string[];
        assert.ok(shadowTrace.includes('eval()'), 'Keep user functions even when their name matches an evaluation helper');
    });

    test('retains R numeric formatting in previews and pages while preserving raw precision', async () => {
        const id = await submit('options(digits=7, scipen=0, OutDec="."); numeric_table <- data.frame(price_per_carat=rep(c(326/0.23, 326/0.21, 1400), 8)); numeric_table');
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.type === 'display' && event.data.kind === 'table');
        assert.ok(table);
        const labels = table.data.formattedColumns as Record<string, string[]>;
        assert.deepStrictEqual(labels['1'].slice(0, 3), ['1417.391', '1552.381', '1400.000']);
        assert.strictEqual(labels['1'].length, 20);
        const first = (table.data.rows as Record<string, number>[])[0]['1'];
        assert.ok(Math.abs(first - 326 / 0.23) < 1e-10);
        const page = await client.request<{ rows: Record<string, number>[]; formattedColumns: Record<string, string[]> }>('inspect', {
            method: 'dataview_page', params: { view_id: table.data.viewId, startRow: 20, endRow: 24, formatNumbers: true },
        });
        assert.deepStrictEqual(page.formattedColumns['1'], ['1400.000', '1417.391', '1552.381', '1400.000']);
        assert.strictEqual(page.rows[1]['1'], first);
        await finished(await submit('options(digits=4, scipen=999, OutDec=",")'));
        const localized = await client.request<{ formattedColumns: Record<string, string[]> }>('inspect', {
            method: 'dataview_page', params: { view_id: table.data.viewId, startRow: 1, endRow: 2, formatNumbers: true },
        });
        assert.deepStrictEqual(localized.formattedColumns['1'], ['1552']);
        const formatted = await submit('data.frame(value = 1.23456789)'); await finished(formatted);
        const display = events.find(event => event.executionId === formatted && event.data.kind === 'table');
        assert.ok(display);
        assert.deepStrictEqual(display.data.formattedColumns, { '1': ['1,235'] });
        const saved = (await client.snapshot()).events.find(event => event.seq === table.seq);
        assert.deepStrictEqual(saved?.data.formattedColumns, labels);
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

    test('standard graphics retains complete pages and updates panels without duplicating snapshots', async () => {
        const images = (id: string): Map<unknown, SessionEvent> => new Map(events
            .filter(event => event.executionId === id && event.data.kind === 'image')
            .map(event => [event.data.displayId, event]));
        for (const layout of ['par(mfrow=c(2,2))', 'par(mfcol=c(2,2))', 'layout(matrix(1:4,2,2))']) {
            const id = await submit(`${layout}; for (i in 1:8) { plot(1:3); title(main=paste("Panel", i)) }`);
            assert.strictEqual((await finished(id)).state, 'success');
            const pages = [...images(id).values()]; assert.strictEqual(pages.length, 2, layout);
            for (const [page, event] of pages.entries()) {
                const svg = Buffer.from(await client.request<string>('asset', { id: event.data.asset }), 'base64').toString();
                for (let panel = page * 4 + 1; panel <= page * 4 + 4; panel++) { assertSvgTextVisible(svg, `Panel ${panel}`); }
            }
        }
        const update = await submit('title(sub="Updated model")'); await finished(update);
        assert.strictEqual(images(update).size, 1);
        const parameters = await submit('par(mfrow=c(1,1)); 21 * 2'); await finished(parameters);
        assert.strictEqual(images(parameters).size, 0, 'Changing future layout must not duplicate the previous plot');
    });

    test('standard graphics captures grid pages and leaves explicit file devices out of the transcript', async () => {
        const id = await submit('grid::grid.newpage(); grid::grid.text("Grid one"); grid::grid.newpage(); grid::grid.text("Grid two")');
        assert.strictEqual((await finished(id)).state, 'success');
        const pages = new Map(events.filter(event => event.executionId === id && event.data.kind === 'image')
            .map(event => [event.data.displayId, event]));
        assert.strictEqual(pages.size, 2);
        for (const [i, event] of [...pages.values()].entries()) {
            const svg = Buffer.from(await client.request<string>('asset', { id: event.data.asset }), 'base64').toString();
            assertSvgTextVisible(svg, i === 0 ? 'Grid one' : 'Grid two');
        }
        const file = await submit('local({ f <- tempfile(fileext=".pdf"); on.exit(unlink(f)); pdf(f); plot(1:3); title("File only"); dev.off(); stopifnot(file.info(f)$size > 1000) })');
        assert.strictEqual((await finished(file)).state, 'success');
        assert.ok(!events.some(event => event.executionId === file && event.type === 'display'));
    });

    test('execution markers remain balanced across base and grid pages with warnings treated as errors', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const id = await submit(`local({
  previous <- options(warn = 2); on.exit(options(previous))
  plot(1:3); plot(3:1)
  grid::grid.newpage(); grid::grid.rect()
  selected <- dev.cur(); png(tempfile(fileext = ".png")); plot(1); dev.off()
  dev.set(selected); abline(h = 0.5)
})`);
        assert.strictEqual((await finished(id)).state, 'success', JSON.stringify(events.filter(event => event.type === 'condition')));
        await delay(300);
        assert.ok(events.some(event => event.executionId === id && event.data.kind === 'plot'));
        assert.ok(!events.some(event => event.executionId === id && event.type === 'condition'));
    });

    test('resizes idle and historical plots without changing their execution ownership', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const id = await submit('plot(1:3)'); await finished(id);
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot'));
        const first = events.find(event => event.executionId === id && event.data.kind === 'plot');
        assert.ok(first);
        await client.request('resize', { device: first.data.device, plot: first.data.plot, width: 500, height: 350 });
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot' && event.data.width === 500));
        const second = await submit('plot(3:1)'); await finished(second);
        await until(() => events.some(event => event.executionId === second && event.data.kind === 'plot'));
        const previous = events.filter(event => event.executionId === second && event.data.kind === 'plot').at(-1);
        assert.ok(previous);
        const after = events.at(-1)?.seq ?? 0;
        await client.request('resize', { device: first.data.device, plot: first.data.plot, width: 600, height: 400 });
        await until(() => events.some(event => event.seq > after && event.executionId === id && event.data.kind === 'plot' && event.data.width === 600));
        assert.ok(!events.some(event => event.seq > after && event.executionId === second && event.data.width === 600));
        const updated = events.filter(event => event.executionId === id && event.data.kind === 'plot').at(-1);
        assert.strictEqual(updated?.data.displayId, first.data.displayId);
        assert.notStrictEqual(updated?.data.svg, previous.data.svg);
    });

    test('retains titles and axes in all base-graphics panels, including resized plots', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const id = await submit(`set.seed(42)
par(mfrow = c(2, 2), mar = c(3, 3, 2, 2))
for (i in 1:4) {
  plot(rnorm(100))
  title(main = paste("Plot", i))
}`);
        assert.strictEqual((await finished(id)).state, 'success');
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot'));
        const checkPlot = async (): Promise<SessionEvent> => {
            const plot = events.filter(event => event.executionId === id && event.data.kind === 'plot').at(-1);
            assert.ok(plot);
            const svg = Buffer.from(await client.request<string>('asset', { id: plot.data.svg }), 'base64').toString();
            for (let panel = 1; panel <= 4; panel++) { assertSvgTextVisible(svg, `Plot ${panel}`); }
            for (const tick of ['20', '40', '60', '80', '100']) { assertSvgTextVisible(svg, tick, 4); }
            return plot;
        };
        const plot = await checkPlot();
        await client.request('resize', { device: plot.data.device, plot: plot.data.plot, width: 1000, height: 800 });
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot' && event.data.width === 1000));
        await checkPlot();
    });

    test('keeps axis titles visible in mfcol and layout panels drawn by separate cells', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        for (const layout of ['par(mfcol = c(2, 2))', 'layout(matrix(1:4, 2, 2))']) {
            await finished(await submit(`${layout}; par(mar = c(5, 5, 3, 2))`));
            let id = '';
            for (let panel = 1; panel <= 4; panel++) {
                id = await submit(`plot(1:10, main = "Panel ${panel}", xlab = "X label ${panel}", ylab = "Y label ${panel}")`);
                assert.strictEqual((await finished(id)).state, 'success');
            }
            await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot'));
            const plot = events.filter(event => event.executionId === id && event.data.kind === 'plot').at(-1);
            assert.ok(plot);
            const svg = Buffer.from(await client.request<string>('asset', { id: plot.data.svg }), 'base64').toString();
            for (let panel = 1; panel <= 4; panel++) {
                for (const label of [`Panel ${panel}`, `X label ${panel}`, `Y label ${panel}`]) { assertSvgTextVisible(svg, label); }
            }
        }
    });

    test('retains the full faceted diamonds plot without accumulating drawing snapshots', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const probe = await run('Rscript', ['-e', 'cat(requireNamespace("ggplot2", quietly=TRUE))']);
        if (probe.stdout.trim() !== 'TRUE') { this.skip(); }
        await client.request('assetStorage', { limitBytes: 64 * 1024 * 1024 });
        const id = await submit(`library(ggplot2)
ggplot(diamonds, aes(x = carat, y = price, color = cut)) +
  geom_point(alpha = 0.3, size = 1) + facet_wrap(~color) + theme_minimal() +
  labs(title = "Diamond Price vs Carat Weight by Cut", x = "Carat Weight",
       y = "Price ($)", color = "Cut Quality")`);
        assert.strictEqual((await finished(id)).state, 'success');
        await delay(400);
        const plots = events.filter(event => event.executionId === id && event.data.kind === 'plot');
        assert.ok(plots.length > 0 && plots.length < 40, `Expected coalesced frames, received ${plots.length}`);
        assert.ok(!events.some(event => event.executionId === id && event.type === 'truncated'), JSON.stringify(events.filter(event => event.type === 'truncated')));
        assert.ok(!events.some(event => event.executionId === id && event.type === 'condition' && String(event.data.message).includes('unclosed group')),
            'Execution markers must close before a new JGD page');
        const last = plots.at(-1); assert.ok(last);
        const file = path.join(root, manifest.id, 'assets', String(last.data.svg));
        const svg = readAsset(path.dirname(file), path.basename(file)).toString('utf8');
        assert.match(svg, /Diamond Price vs Carat Weight by Cut/);
        assert.ok((svg.match(/<circle /g) ?? []).length >= 53940, 'The retained plot must include all data points');
        const stats = await client.request<AssetStorageStats>('assetStorage', { compact: true });
        assert.strictEqual(stats.usedBytes, fs.statSync(file).size);
        assert.ok(stats.usedBytes < Buffer.byteLength(svg) / 4, 'Dense SVGs should compress substantially');
        assert.ok(!fs.readdirSync(path.dirname(file)).some(name => /\.json(?:\.gz)?$/.test(name)));
        console.log(`      diamonds: ${plots.length} snapshots, ${Buffer.byteLength(svg)} raw bytes, ${stats.usedBytes} retained bytes, ${stats.reclaimedBytes} bytes reclaimed`);
    });

    test('retains a narrow raster colour bar at its requested width and height', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const id = await submit('plot.new(); rasterImage(as.raster(matrix(rainbow(100), ncol=1)), 0.4, 0.1, 0.6, 0.9)');
        assert.strictEqual((await finished(id)).state, 'success');
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot'));
        const plot = events.filter(event => event.executionId === id && event.data.kind === 'plot').at(-1);
        assert.ok(plot);
        const svg = Buffer.from(await client.request<string>('asset', { id: plot.data.svg }), 'base64').toString();
        assert.match(svg, /<image [^>]*width="\d{2,}[^"]*"[^>]*preserveAspectRatio="none"/);
    });

    test('measures and renders twelve-point text at the default 96 DPI', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        const id = await submit('par(family="mono"); plot.new(); w <- strwidth("0123456789", units="inches"); stopifnot(w > 0.9, w < 1.1); text(0.5, 0.5, "Twelve points")');
        assert.strictEqual((await finished(id)).state, 'success');
        await until(() => events.some(event => event.executionId === id && event.data.kind === 'plot'));
        const plot = events.filter(event => event.executionId === id && event.data.kind === 'plot').at(-1);
        assert.ok(plot);
        const svg = Buffer.from(await client.request<string>('asset', { id: plot.data.svg }), 'base64').toString();
        assert.match(svg, /font-size="16"[^>]*>Twelve points<\/text>/);
    });

    test('reports a full asset store once per cell and accepts a larger live limit', async function () {
        if (!client.manifest.capabilities.jgd) { this.skip(); }
        await client.request('assetStorage', { limitBytes: 1024 * 1024 });
        const id = await submit('set.seed(42); for (i in 1:8) plot(runif(15000), runif(15000))'); await finished(id); await delay(400);
        const warnings = events.filter(event => event.executionId === id && event.type === 'truncated' && String(event.data.message).includes('asset storage limit'));
        assert.strictEqual(warnings.length, 1);
        assert.ok((await client.request<AssetStorageStats>('assetStorage')).usedBytes <= 1024 * 1024);
        const observer = new AgentClient(manifest); await observer.connect();
        try {
            await assert.rejects(observer.request('assetStorage', { compact: true }), /observing/);
            await assert.rejects(observer.request('assetStorage', { limitBytes: 64 * 1024 * 1024 }), /observing/);
        } finally { observer.close(); }
        await client.request('assetStorage', { limitBytes: 64 * 1024 * 1024 });
        const next = await submit('plot(seq_len(12000)); cat("still running")'); await finished(next); await delay(400);
        assert.ok(events.some(event => event.executionId === next && event.data.kind === 'plot'));
        assert.ok(!events.some(event => event.executionId === next && event.type === 'truncated'));
        assert.match(text(next), /still running/);
        const config = JSON.parse(fs.readFileSync(path.join(root, manifest.id, 'config.json'), 'utf8')) as AgentConfig;
        assert.strictEqual(config.maxAssetBytes, 64 * 1024 * 1024);
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

    for (const supervision of ['detached', 'auto']) {
        test(`${supervision === 'auto' ? 'Linux auto without tmux' : 'Detached'} session leaves the editor process tree and retains objects after its termination`, async () => {
            const node = resolveNodeExecutable('node', root); assert.ok(node);
            const rPath = resolveExecutable('R', root); assert.ok(rPath);
            const arfPath = resolveExecutable(process.env.ARF_PATH ?? 'arf', root);
            const environment = { ...process.env };
            if (supervision === 'auto') {
                // A real restricted PATH, including the shell utilities used by R but
                // deliberately excluding tmux even on CI hosts where it is installed.
                const bin = path.join(temporary, 'without-tmux'); fs.mkdirSync(bin);
                for (const name of ['uname', 'rm', 'mkdir', 'which', 'sed', 'sh', 'env']) {
                    const executable = resolveExecutable(name, root); assert.ok(executable);
                    fs.symlinkSync(executable, path.join(bin, name));
                }
                environment.PATH = bin;
            }
            const id = randomUUID();
            const config: AgentConfig = { id, generation: randomUUID(), label: 'Editor termination test', directory: root,
                storage: path.join(root, id), rPath, library, resources,
                provider: process.env.VSCR_TEST_PROVIDER === 'arf' ? 'arf' : 'r', arfPath,
                supervision, plotBackend: 'standard', historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
            const script = `const {launchAgent} = require(${JSON.stringify(require.resolve('../../interactive/launcher'))});
            ${supervision === 'auto' ? 'Object.defineProperty(process, \'platform\', { value: \'linux\' });' : ''}
            process.env.VSCODE_INSPECTOR_OPTIONS = '{}';
            process.env.NODE_OPTIONS = '--require /missing/vscode-debug-bootloader.js';
            launchAgent(${JSON.stringify(config)}, ${JSON.stringify(agentBundle)}, ${JSON.stringify(node)})
                .then(value => { console.log(JSON.stringify(value)); setInterval(() => {}, 1000); })
                .catch(error => { console.error(error); process.exitCode = 1; });`;
            const parent = spawn(node, ['-e', script], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
            let independent: AgentClient | undefined;
            try {
                const value = await new Promise<SessionManifest>((resolve, reject) => {
                    let output = ''; let errors = '';
                    parent.stdout.on('data', (chunk: Buffer) => {
                        output += chunk.toString();
                        if (output.includes('\n')) { resolve(JSON.parse(output.split('\n')[0]) as SessionManifest); }
                    });
                    parent.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
                    parent.once('error', reject);
                    parent.once('exit', () => reject(new Error(`Launcher exited before readiness: ${errors}`)));
                });
                independent = new AgentClient(value); await independent.connect();
                assert.strictEqual(value.supervision, 'detached');
                const saved = JSON.parse(fs.readFileSync(path.join(config.storage, 'config.json'), 'utf8')) as AgentConfig;
                assert.strictEqual(saved.supervision, 'detached');
                if (supervision === 'auto') { assert.match(fs.readFileSync(path.join(config.storage, 'agent.log'), 'utf8'), /tmux is unavailable/); }
                const before = randomUUID();
                await independent.request('submit', { submission: { id: before, code: 'persisted <- 42' } });
                const complete = async (execution: string): Promise<void> => {
                    assert.ok(independent);
                    for (let i = 0; i < 200; i++) {
                        if ((await independent.request<ExecutionRecord>('execution', { id: execution })).state === 'success') { return; }
                        await delay(25);
                    }
                    assert.fail('Persistent execution did not complete');
                };
                await complete(before);
                const originalPid = (await independent.snapshot()).manifest.rPid;
                assert.ok(originalPid);
                // Check every ancestor, while the editor is still alive. A direct detached
                // child survives ordinary exit but remains vulnerable to recursive cleanup.
                let ancestor = value.agentPid;
                for (let i = 0; ancestor > 1 && i < 50; i++) {
                    assert.notStrictEqual(ancestor, parent.pid, 'Agent must not remain in the editor process tree');
                    ancestor = Number((await run('ps', ['-p', String(ancestor), '-o', 'ppid='])).stdout.trim());
                }
                independent.close();
                await new Promise<void>(resolve => { parent.once('exit', () => resolve()); parent.kill('SIGKILL'); });
                independent = new AgentClient(value); await independent.connect();
                assert.strictEqual(independent.manifest.rPid, originalPid);
                const after = randomUUID();
                await independent.request('submit', { submission: { id: after, code: 'stopifnot(persisted == 42); persisted <- persisted + 1' } });
                await complete(after);
            } finally {
                parent.kill();
                if (independent) {
                    if (!independent.connected) { await independent.connect(); }
                    await independent.request('stop');
                    for (let i = 0; i < 200 && (await independent.snapshot()).manifest.status !== 'exited'; i++) { await delay(25); }
                    await independent.request('shutdown'); independent.close();
                }
            }
        });
    }

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
            assert.ok(await probeArfSession({ pid: Number(child.pid), socket_path: endpoint }));
            assert.strictEqual(await probeArfSession({ pid: Number(child.pid), socket_path: path.join(temporary, 'missing-arf.sock') }), undefined);
            const id = randomUUID();
            adopted = new SessionAgent({ id, generation: randomUUID(), label: 'Adopted arf', directory: root,
                storage: path.join(root, id), rPath: 'R', library, resources,
                provider: 'arf-existing', arfEndpoint: endpoint, arfPath: path.join(root, 'missing-arf'), supervision: 'test', plotBackend: 'standard',
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
