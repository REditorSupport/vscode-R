import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify, stripVTControlCharacters } from 'util';
import { randomUUID } from 'crypto';
import { arfRequest, probeArfSession } from '../../interactive/arf';
import { SessionAgent } from '../../interactive/agentMain';
import { AgentClient } from '../../interactive/client';
import { AgentConfig, SessionEvent, SessionManifest, ExecutionRecord } from '../../interactive/protocol';
import { defaultStorage, installRuntime, nodeEnvironment } from '../../interactive/launcher';
import { resolveExecutable } from '../../interactive/executable';
import { hostNodeRuntime } from '../../interactive/nodeExecutable';
import { HistoryPage } from '../../interactive/history';
import { queryTablePage, TableColumn, tableSchema } from '../../interactive/tableQuery';
import { AssetStorageStats, readAsset } from '../../interactive/assets';
import { assertSvgTextVisible } from '../svgAssertions';
import { rString } from '../../interactive/backends/rCode';

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
        // Reproduce the packaged extension: the source checkout's sess/ is absent.
        const extension = path.join(temporary, 'packaged extension');
        fs.cpSync(path.join(process.cwd(), 'dist', 'resources', 'sess'),
            path.join(extension, 'dist', 'resources', 'sess'), { recursive: true });
        fs.cpSync(path.join(process.cwd(), 'R'), path.join(extension, 'R'), { recursive: true });
        fs.copyFileSync(path.join(process.cwd(), 'dist', 'interactive-agent.js'),
            path.join(extension, 'dist', 'interactive-agent.js'));
        const runtime = await installRuntime(extension, root, 'R', () => undefined);
        library = runtime.library; resources = runtime.resources; agentBundle = runtime.agent;
        assert.deepStrictEqual(await installRuntime(extension, root, 'R', () => assert.fail('A ready runtime should be reused')), runtime);
    });
    suiteTeardown(() => fs.rmSync(temporary, { recursive: true, force: true }));

    setup(async function () {
        events = [];
        const id = randomUUID();
        const config: AgentConfig = { id, generation: randomUUID(), label: 'Integration test',
            directory: process.cwd(), storage: path.join(root, id), rPath: 'R', library,
            resources, provider: 'arf', arfPath: process.env.ARF_PATH ?? 'arf', supervision: 'test',
            plotBackend: process.env.VSCR_TEST_STATIC || this.currentTest?.title.startsWith('standard graphics') ? 'standard' : 'auto',
            historyLimit: 50, maxOutputBytes: 1024 * 1024, maxJournalBytes: 16 * 1024 * 1024 };
        agent = new SessionAgent(config); manifest = await agent.start();
        client = new AgentClient(manifest); await client.connect();
        client.on('event', (event: SessionEvent) => events.push(event));
        await client.subscribe(0);
        await until(() => events.some(event => event.type === 'state' && event.data.status === 'idle'));
    });
    teardown(async () => { client?.close(); await agent?.close(); await delay(100); });

    async function until(predicate: () => boolean, timeout = 10000, observed = events): Promise<void> {
        const deadline = Date.now() + timeout;
        while (!predicate()) {
            if (Date.now() >= deadline) { throw new Error(`Timed out. Recent events: ${JSON.stringify(observed.slice(-8))}`); }
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

    test('dispatch remains usable when user code masks namespace lookup functions', async () => {
        const first = await submit('get <- asNamespace <- function(...) stop("user helper called")');
        assert.strictEqual((await finished(first)).state, 'success');
        const next = await submit('cat("namespace dispatch works")');
        assert.strictEqual((await finished(next)).state, 'success');
        assert.match(text(next), /namespace dispatch works/);
    });

    test('keeps rich output ordered and completion usable when code redirects console output', async () => {
        const redirected = rString(path.join(root, 'redirected.txt'));
        const id = await submit(`cat("before"); sess::display("middle", "text/plain"); cat("after")
sink(${redirected}); cat("saved to file"); sess::display(head(iris)); sink()
cat(readLines(${redirected}))`);
        assert.strictEqual((await finished(id)).state, 'success');
        const ordered = events.filter(event => event.executionId === id && ['stream', 'display'].includes(event.type));
        const middle = ordered.findIndex(event => event.type === 'display' && event.data.kind === 'mime');
        assert.ok(middle > 0);
        assert.match(ordered.slice(0, middle).map(event => typeof event.data.text === 'string' ? event.data.text : '').join(''), /before/);
        assert.match(ordered.slice(middle + 1).map(event => typeof event.data.text === 'string' ? event.data.text : '').join(''), /after/);
        assert.ok(ordered.some(event => event.data.kind === 'table'));
        assert.strictEqual(text(id).match(/saved to file/g)?.length, 1);
        const next = await submit('cat("next cell")');
        assert.strictEqual((await finished(next)).state, 'success'); assert.strictEqual(text(next), 'next cell');
    });

    test('drains both console pipes before completing back-to-back cells', async () => {
        for (let cell = 0; cell < 3; cell++) {
            const id = await submit(`cat("stdout-${cell}\\n"); cat(strrep("λ", 200000), file=stderr())
sess::display("display-${cell}", "text/plain"); cat("stderr-${cell}\\n", file=stderr()); cat("tail-${cell}\\n")`);
            assert.strictEqual((await finished(id)).state, 'success');
            const captured = events.filter(event => event.executionId === id);
            const stdout = captured.filter(event => event.type === 'stream' && event.data.channel === 'stdout').map(event => event.data.text).join('');
            const stderr = captured.filter(event => event.type === 'stream' && event.data.channel === 'stderr').map(event => event.data.text).join('');
            assert.strictEqual(stdout, `stdout-${cell}\ntail-${cell}\n`);
            // arf styles errors on its owned stderr pipe; compare console content.
            assert.strictEqual(stripVTControlCharacters(stderr), 'λ'.repeat(200000) + `stderr-${cell}\n`);
            assert.ok(captured.some(event => event.type === 'display' && event.data.text === `display-${cell}`));
            const completion = captured.findIndex(event => event.type === 'finished');
            assert.ok(completion >= 0 && captured.every((event, index) =>
                !['stream', 'display'].includes(event.type) || index < completion));
        }
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
        await agent.close();
        const file = path.join(root, manifest.id, manifest.generation, 'executions', `${id}.json`);
        const saved = fs.readFileSync(file, 'utf8');
        await delay(200);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), saved);
    });

    test('Stop during startup waits for the runtime and confirms exit', async () => {
        const id = randomUUID(), storage = path.join(root, id);
        const starting = new SessionAgent({ id, generation: randomUUID(), label: 'Stop during startup', directory: root, storage,
            rPath: 'R', library, resources, provider: 'arf', arfPath: process.env.ARF_PATH ?? 'arf', supervision: 'test', plotBackend: 'standard',
            historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
        const startup = starting.start();
        let connection: AgentClient | undefined;
        try {
            await until(() => fs.existsSync(path.join(storage, 'manifest.json')));
            connection = new AgentClient(JSON.parse(fs.readFileSync(path.join(storage, 'manifest.json'), 'utf8')) as SessionManifest);
            await connection.connect();
            await connection.request('stop');
            await startup;
            assert.strictEqual((await connection.snapshot()).manifest.status, 'exited');
        } finally { connection?.close(); await starting.close(); await startup.catch(() => undefined); }
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

    test('reports unsupported notebook input without claiming native console support', async () => {
        assert.strictEqual(client.manifest.capabilities.stdin, false);
        assert.strictEqual(client.manifest.capabilities.debugger, false);
        await assert.rejects(client.request('input', { id: 1, executionId: randomUUID(), value: 'Ada' }), /no longer active/);
        const next = await submit('cat("headless session usable")');
        assert.strictEqual((await finished(next)).state, 'success');
        assert.match(text(next), /headless session usable/);
    });

    test('interrupts evaluation without losing R and cancels queued code', async () => {
        const id = await submit('kept <- 17; Sys.sleep(30)');
        await until(() => events.some(event => event.executionId === id && event.type === 'started'));
        const queued = await submit('kept <- 0'); await client.request('cancel', { id: queued });
        assert.strictEqual((await finished(queued)).state, 'cancelled');
        await client.request('interrupt', { id }); assert.strictEqual((await finished(id)).state, 'interrupted');
        const next = await submit('kept'); await finished(next); assert.match(text(next), /17/);
    });

    test('interrupts a slow inspection and continues serving R requests', async () => {
        for (const afterTimeout of [false, true]) {
            const marker = `inspection-started-${String(afterTimeout)}`;
            const inspection = client.request('inspect', { method: 'hover', params: {
                expr: `local({ cat("${marker}"); Sys.sleep(30); 42 })`,
            } }).then(() => '', (error: Error) => error.message);
            await until(() => events.some(event => event.type === 'stream' && String(event.data.text).includes(marker)));
            if (afterTimeout) { assert.match(await inspection, /timed out/i); }
            await client.request('interrupt');
            if (!afterTimeout) { assert.match(await inspection, /interrupted/i); }
            const next = await submit('21 * 2');
            assert.strictEqual((await finished(next)).state, 'success'); assert.match(text(next), /42/);
            assert.ok(await client.request('inspect', { method: 'workspace' }));
        }
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

    test('unclassed lists retain printable previews and lazy pages across reconnects', async () => {
        const id = await submit('x <- list(nested=list(value=c(1,2)), table=data.frame(id=1:2), "λ <tag>"); x');
        assert.strictEqual((await finished(id)).state, 'success');
        const output = events.find(event => event.executionId === id && event.data.kind === 'list'); assert.ok(output);
        const children = output.data.children as { label: string; has_children: boolean }[];
        assert.deepStrictEqual(children.map(child => child.label), ['$ nested', '$ table', '[[3]]']);
        assert.strictEqual(children[0].has_children, true);
        assert.match(String(output.data.printedText), /\$nested\$value/);
        assert.ok(!text(id).includes('$nested'), 'The rich list replaces automatic console printing');
        const expected = await submit('print(x)'); await finished(expected);
        assert.strictEqual(output.data.printedText, text(expected));
        await finished(await submit('x$nested$value <- 99; invisible(NULL)'));
        const page = await client.request<{ children: { str: string }[] }>('inspect', { method: 'workspace_children', params: {
            view_id: output.data.viewId, path: [1], start: 1,
        } });
        assert.match(page.children[0].str, /1/); assert.ok(!page.children[0].str.includes('99'));
        const explicit = await submit('sess::display(list()); View(list(a=1)); structure(list(a=2), class="custom_list")');
        assert.strictEqual((await finished(explicit)).state, 'success');
        assert.strictEqual(events.filter(event => event.executionId === explicit && event.data.kind === 'list').length, 2);
        assert.match(text(explicit), /custom_list/);
        const large = await submit('as.list(seq_len(501))'); await finished(large);
        const largeList = events.find(event => event.executionId === large && event.data.kind === 'list'); assert.ok(largeList);
        assert.strictEqual((largeList.data.children as unknown[]).length, 500);
        assert.strictEqual(largeList.data.next_start, 501);
        client.close(); await client.connect(); await client.subscribe(0);
        assert.deepStrictEqual((await client.snapshot()).events.find(event => event.seq === output.seq)?.data, output.data);
    });

    test('nested table viewers from separate list cells stay independent', async () => {
        const lists: SessionEvent[] = [];
        for (const value of [11, 21]) {
            const id = await submit(`list(nested=list(first=data.frame(value=${value}), second=data.frame(value=${value + 1})))`);
            assert.strictEqual((await finished(id)).state, 'success');
            const output = events.find(event => event.executionId === id && event.data.kind === 'list');
            assert.ok(output); lists.push(output);
        }
        assert.notStrictEqual(lists[0].data.viewId, lists[1].data.viewId);

        const openTable = async (output: SessionEvent, index: number): Promise<string> => {
            const start = events.length;
            assert.strictEqual(await client.request('inspect', { method: 'listview_view', params: {
                view_id: output.data.viewId, path: [1], index,
            } }), true);
            await until(() => events.slice(start).some(event => event.type === 'viewer'));
            const event = events.slice(start).find(event => event.type === 'viewer'); assert.ok(event);
            const params = event.data.params as { source: string; title: string; view_id: string };
            assert.strictEqual(params.source, 'table');
            assert.strictEqual(params.title, `List$nested$${index === 1 ? 'first' : 'second'}`);
            return params.view_id;
        };
        const tableValue = async (viewId: string): Promise<number> => {
            const page = await client.request<{ rows: Record<string, number>[] }>('inspect', {
                method: 'dataview_page', params: { view_id: viewId, startRow: 0, endRow: 1 },
            });
            return page.rows[0]['1'];
        };

        const first = await openTable(lists[0], 1);
        const second = await openTable(lists[1], 1);
        assert.notStrictEqual(first, second, 'Each list cell owns its nested table viewer');
        assert.strictEqual(await tableValue(first), 11);
        assert.strictEqual(await tableValue(second), 21);
        assert.strictEqual(await openTable(lists[0], 2), first, 'Tables within one list reuse its viewer');
        assert.strictEqual(await tableValue(first), 12);
        assert.strictEqual(await tableValue(second), 21, 'Opening another table in the first cell preserves the second');
        assert.strictEqual(await openTable(lists[1], 2), second);
        assert.strictEqual(await tableValue(second), 22);
        assert.strictEqual(await tableValue(first), 12, 'The first cell remains independently browsable');
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
        const inline = await queryTablePage(table.data, { start: 832976860, live: true, refresh: true }, request => client.request('inspect', request));
        assert.strictEqual(inline.startRow, 832976860);
        assert.strictEqual((inline.rows as unknown[]).length, 11);
        assert.strictEqual((inline.rows as Record<string, number>[])[10]['23'], 832976871);
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

    test('inline full-table queries sort, filter, widen pages and recover after schema edits', async function () {
        if (!(await run('Rscript', ['-e', 'cat(requireNamespace("data.table", quietly=TRUE))'])).stdout.includes('TRUE')) { this.skip(); }
        const id = await submit('dt <- data.table::data.table(id=1:2000, name=rep(c("a", "b"), 1000), date=as.Date("2026-01-01")+0:1999, flag=rep(c(TRUE, FALSE),1000)); dt');
        assert.strictEqual((await finished(id)).state, 'success');
        const table = events.find(event => event.executionId === id && event.data.kind === 'table'); assert.ok(table);
        const schema = tableSchema(table.data.columns as TableColumn[]);
        const inspect = (request: { method: string; params: Record<string, unknown> }): Promise<Record<string, unknown>> => client.request('inspect', request);
        const filters = { '2': { type: 'equals', filter: 'a' }, '4': { type: 'true' }, '3': { type: 'greaterThan', filter: '2026-01-01' } };
        const query = { start: 0, size: 50, refresh: true, schema, sortModel: [{ colId: '1', sort: 'desc' }], filterModel: filters };
        const result = await queryTablePage(table.data, query, inspect);
        assert.strictEqual(result.queryReset, false, JSON.stringify({ schema, columns: result.columns }));
        assert.strictEqual(result.totalRows, 999);
        assert.strictEqual((result.rows as unknown[]).length, 50);
        assert.strictEqual((result.rows as Record<string, number>[])[0]['1'], 1999);
        const finalPage = await queryTablePage(table.data, { ...query, refresh: false, live: true, start: 950 }, inspect);
        assert.strictEqual((finalPage.rows as unknown[]).length, 49);
        assert.strictEqual((finalPage.rows as Record<string, number>[])[48]['1'], 3);
        await finished(await submit('data.table::setnames(dt, "id", "renamed")'));
        const refreshed = await queryTablePage(table.data, query, inspect);
        assert.strictEqual(refreshed.queryReset, true);
        assert.strictEqual(refreshed.totalRows, 2000);
        assert.strictEqual((refreshed.columns as TableColumn[])[1].headerName, 'renamed');
        const saved = await queryTablePage(table.data, { start: 0 }, inspect);
        assert.strictEqual(saved.live, false);
        assert.strictEqual((saved.columns as TableColumn[])[1].headerName, 'id');
        assert.strictEqual((saved.rows as Record<string, number>[])[0]['1'], 1);
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

    test('bounds large Unicode output without corrupting it or disconnecting R', async () => {
        const id = await submit('cat(strrep("λ🙂", 900000))');
        assert.strictEqual((await finished(id)).state, 'success');
        assert.ok(!text(id).includes('�'));
        assert.ok(events.some(event => event.executionId === id && event.type === 'truncated'));
        assert.ok(Buffer.byteLength(text(id)) <= 1024 * 1024);
        const next = await submit('21 * 2'); await finished(next); assert.match(text(next), /42/);
    });

    test('bounds oversized rich events before they can disconnect the arf event transport', async () => {
        for (const value of ['strrep("λ", 3000000)', 'strrep(intToUtf8(1L), 1000000)']) {
            const id = await submit(`sess::display(${value}, "text/html"); cat("still running")`);
            assert.strictEqual((await finished(id)).state, 'success');
            assert.match(text(id), /still running/);
            assert.ok(events.some(event => event.executionId === id && event.type === 'truncated'));
            assert.ok(!events.some(event => event.executionId === id && event.type === 'display'));
        }
        const next = await submit('21 * 2');
        assert.strictEqual((await finished(next)).state, 'success'); assert.match(text(next), /42/);
        assert.strictEqual((await client.snapshot()).manifest.rPid, manifest.rPid);
    });

    test('forked R workers cannot corrupt the parent console bridge', async () => {
        const id = await submit(`
            values <- parallel::mclapply(1:4, function(i) {
                for (j in 1:10) cat(strrep(as.character(i), 8192))
                i * 2L
            }, mc.cores = 4)
            stopifnot(identical(unlist(values), c(2L, 4L, 6L, 8L)))
            cat("parallel complete")
        `);
        assert.strictEqual((await finished(id)).state, 'success');
        assert.match(text(id), /parallel complete/);
        const next = await submit('21 * 2');
        assert.strictEqual((await finished(next)).state, 'success'); assert.match(text(next), /42/);
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

    for (const backend of ['JGD', 'standard graphics']) {
        test(`${backend} captures pages from graphics functions imported by stats`, async function () {
            if (backend === 'JGD' && !client.manifest.capabilities.jgd) { this.skip(); }
            await finished(await submit('plot(1:3)'));
            // stats imports plot.new before the bridge starts. All three pages
            // are drawn within one expression, so end-of-expression capture is insufficient.
            const id = await submit(`local({
                old <- options(warn=2); on.exit(options(old))
                plot(co2, main="First time series")
                plot(AirPassengers, main="Second time series")
                plot(nottem, main="Third time series")
            })`);
            assert.strictEqual((await finished(id)).state, 'success');
            await until(() => new Set(events.filter(event => event.executionId === id &&
                (event.data.kind === 'plot' || event.data.kind === 'image'))
                .map(event => event.data.displayId)).size === 3);
            const pages = new Map(events.filter(event => event.executionId === id &&
                (event.data.kind === 'plot' || event.data.kind === 'image'))
                .map(event => [event.data.displayId, event.data]));
            for (const [index, page] of [...pages.values()].entries()) {
                const svg = readAsset(path.join(root, manifest.id, 'assets'), String(page.svg || page.asset)).toString();
                assert.match(svg, new RegExp(['First', 'Second', 'Third'][index] + ' time series'));
            }
        });
    }

    test('standard graphics layout changes do not copy the preceding plot into a new cell', async () => {
        await finished(await submit('plot(1:3, main="Previous plot")'));
        const id = await submit('filled.contour(volcano, plot.title=title("Current contour"))');
        assert.strictEqual((await finished(id)).state, 'success');
        const pages = events.filter(event => event.executionId === id && event.data.kind === 'image');
        assert.strictEqual(new Set(pages.map(event => event.data.displayId)).size, 1);
        const svg = readAsset(path.join(root, manifest.id, 'assets'), String(pages.at(-1)?.data.asset)).toString();
        assert.match(svg, /Current contour/);
        assert.doesNotMatch(svg, /Previous plot/);
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
            provider: 'arf', arfPath: process.env.ARF_PATH ?? 'arf', supervision: process.env.VSCR_TEST_TMUX ? 'tmux' : 'detached', plotBackend: 'standard',
            historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
        const script = `const {launchAgent} = require(${JSON.stringify(require.resolve('../../interactive/launcher'))});
            launchAgent(${JSON.stringify(config)}, ${JSON.stringify(agentBundle)})
            .then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode=1; });`;
        const result = await run(process.execPath, ['-e', script], { env: nodeEnvironment(hostNodeRuntime()) });
        const independent = new AgentClient(JSON.parse(result.stdout) as SessionManifest);
        try {
            await independent.connect();
            const execution = randomUUID();
            await independent.request('submit', { submission: { id: execution, code: 'stopifnot(Sys.getenv("ELECTRON_RUN_AS_NODE") == ""); persisted <- 42' } });
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
        const label = supervision === 'auto' ? `${process.platform === 'linux' ? 'Linux' : 'Desktop'} auto without tmux` : 'Detached';
        test(`${label} session leaves the editor process tree and retains objects after its termination`, async () => {
            const runtime = hostNodeRuntime();
            const node = runtime.executable;
            const rPath = resolveExecutable('R', root); assert.ok(rPath);
            const arfPath = resolveExecutable(process.env.ARF_PATH ?? 'arf', root);
            const environment = nodeEnvironment(runtime);
            if (supervision === 'auto') {
                // arf discovers R via PATH on Linux. Keep R and its shell utilities
                // available while excluding tmux even on CI hosts where it is installed.
                const bin = path.join(temporary, 'without-tmux'); fs.mkdirSync(bin);
                for (const name of ['R', 'uname', 'rm', 'mkdir', 'which', 'sed', 'sh', 'env']) {
                    const executable = resolveExecutable(name, root); assert.ok(executable);
                    fs.symlinkSync(executable, path.join(bin, name));
                }
                environment.PATH = bin;
            }
            const id = randomUUID();
            const config: AgentConfig = { id, generation: randomUUID(), label: 'Editor termination test', directory: root,
                storage: path.join(root, id), rPath, library, resources,
                provider: 'arf', arfPath,
                supervision, plotBackend: 'standard', historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
            const script = `const {launchAgent} = require(${JSON.stringify(require.resolve('../../interactive/launcher'))});
            process.env.VSCODE_INSPECTOR_OPTIONS = '{}';
            process.env.NODE_OPTIONS = '--require /missing/vscode-debug-bootloader.js';
            launchAgent(${JSON.stringify(config)}, ${JSON.stringify(agentBundle)})
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
                if (supervision === 'auto' && process.platform === 'linux') {
                    assert.match(fs.readFileSync(path.join(config.storage, 'agent.log'), 'utf8'), /tmux is unavailable/);
                }
                const before = randomUUID();
                await independent.request('submit', { submission: { id: before, code: 'stopifnot(Sys.getenv("ELECTRON_RUN_AS_NODE") == ""); persisted <- 42' } });
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
            const waitFor = (predicate: () => boolean): Promise<void> => until(predicate, 10000, observed);
            const execution = randomUUID();
            await connection.request('submit', { submission: { id: execution, code: 'kept_before_adoption' } });
            await waitFor(() => observed.some(event => event.executionId === execution && event.type === 'finished'));
            assert.match(observed.filter(event => event.executionId === execution && event.type === 'stream').map(event => event.data.text).join(''), /73/);
            assert.strictEqual(connection.manifest.rPid, child.pid);
            assert.strictEqual(connection.manifest.capabilities.streaming, false);
            // Output of notebook submissions is returned on completion. Arbitrary
            // terminal output has no subscription in the current arf protocol.

            const completed = async (code: string): Promise<string> => {
                assert.ok(connection);
                const id = randomUUID();
                await connection.request('submit', { submission: { id, code } });
                await waitFor(() => observed.some(event => event.executionId === id && event.type === 'finished'));
                assert.strictEqual((await connection.request<ExecutionRecord>('execution', { id })).state, 'success');
                return id;
            };
            const rich = await completed('cat("adopted stdout"); cat("adopted stderr", file=stderr()); head(iris); plot(1:3)');
            const captured = observed.filter(event => event.executionId === rich);
            assert.strictEqual(captured.filter(event => event.type === 'stream' && event.data.channel === 'stdout').map(event => event.data.text).join(''), 'adopted stdout');
            assert.strictEqual(captured.filter(event => event.type === 'stream' && event.data.channel === 'stderr').map(event => event.data.text).join(''), 'adopted stderr');
            assert.ok(captured.some(event => event.type === 'display' && event.data.kind === 'table'));
            assert.ok(captured.some(event => event.type === 'display' && event.data.kind === 'image'));
            const completion = captured.findIndex(event => event.type === 'finished');
            assert.ok(completion >= 0 && captured.every((event, index) => event.type !== 'stream' || index < completion));
            assert.ok(await connection.request('inspect', { method: 'workspace' }));

            // A real arf terminal runs task callbacks after the adoption bootstrap
            // and ordinary console commands; headless arf does not run them.
            await completed('sess:::.workspace_update_task_callback(); later::run_now()');
            assert.ok(await connection.request('inspect', { method: 'workspace' }));
            await completed('stopifnot(kept_before_adoption == 73)');

            // Pause startup after its started event so immediate interruption does
            // not depend on the runner winning a short race before user evaluation.
            await arfRequest(endpoint, 'evaluate', { visible: true, code: `local({
ns <- asNamespace("sess"); original <- get(".interactive_plot_context", ns)
replacement <- local({ inner <- original; first <- TRUE; function(...) {
    if (first && !is.null(sess:::.sess_env$interactive_id)) {
        first <<- FALSE; Sys.sleep(30)
    }
    inner(...)
} })
unlockBinding(".interactive_plot_context", ns)
assign(".interactive_plot_context", replacement, ns)
lockBinding(".interactive_plot_context", ns)
})` });
            const starting = randomUUID();
            await connection.request('submit', { submission: { id: starting, code: 'stop("Startup interruption must prevent user evaluation")' } });
            await waitFor(() => observed.some(event => event.executionId === starting && event.type === 'started'));
            await connection.request('interrupt', { id: starting });
            await waitFor(() => observed.some(event => event.executionId === starting && event.type === 'finished'));
            assert.strictEqual((await connection.request<ExecutionRecord>('execution', { id: starting })).state, 'interrupted');
            await completed('stopifnot(kept_before_adoption == 73)');

            const running = randomUUID();
            await connection.request('submit', { submission: { id: running, code: 'kept_during_adoption <- 81; cat("before interrupt"); sess::display("interrupt ready", "text/plain"); Sys.sleep(30)' } });
            await waitFor(() => observed.some(event => event.executionId === running && event.type === 'display' && event.data.text === 'interrupt ready'));
            await connection.request('interrupt', { id: running });
            await waitFor(() => observed.some(event => event.executionId === running && event.type === 'finished'));
            assert.strictEqual((await connection.request<ExecutionRecord>('execution', { id: running })).state, 'interrupted');
            await completed('stopifnot(kept_during_adoption == 81, kept_before_adoption == 73)');

            connection.close(); await adopted.close();
            assert.strictEqual(child.exitCode, null);
            process.kill(child.pid!, 0);
            const result = await arfRequest(endpoint, 'evaluate', {
                code: 'stopifnot(kept_before_adoption == 73); kept_after_disposal <- 74', visible: true,
            }) as { error?: unknown };
            assert.ok(!result.error, JSON.stringify(result));
            const check = await arfRequest(endpoint, 'evaluate', { code: 'stopifnot(kept_after_disposal == 74)', visible: true }) as { error?: unknown };
            assert.ok(!check.error, JSON.stringify(check));
            // Stop is a separate, explicitly authorized operation on a new attachment.
            const next = randomUUID();
            adopted = new SessionAgent({ id: next, generation: randomUUID(), label: 'Adopted again', directory: root,
                storage: path.join(root, next), rPath: 'R', library, resources,
                provider: 'arf-existing', arfEndpoint: endpoint, supervision: 'test', plotBackend: 'standard',
                historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
            connection = new AgentClient(await adopted.start()); await connection.connect();
            await connection.request('stop');
            await waitFor(() => child.exitCode !== null || child.signalCode !== null);
            assert.strictEqual((await connection.snapshot()).manifest.status, 'exited');
        } finally { connection?.close(); await adopted?.close(); child.kill(); }
    });

});
