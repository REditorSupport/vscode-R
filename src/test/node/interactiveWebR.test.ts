import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readSessionManifest } from '../../interactive/launcher';
import { prepareNodeWebR } from '../../webr/nodeRuntime';
import { AgentClient } from '../../interactive/client';
import type { AgentConfig, SessionEvent, SessionManifest } from '../../interactive/protocol';

suite('R Interactive webR provider', function () {
    this.timeout(60000);
    let root: string;
    let project: string;
    let launchDirectory: string;
    let agent: ChildProcess;
    let closed: Promise<unknown>;
    let client: AgentClient;
    let manifest: SessionManifest;
    let events: SessionEvent[];

    setup(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-webr-'));
        project = path.join(root, 'my project');
        fs.mkdirSync(project);
        const baseUrl = await prepareNodeWebR(root, (directory) =>
            fs.promises.cp(path.dirname(require.resolve('webr')), directory, { recursive: true }),
        );
        const config: AgentConfig = {
            id: randomUUID(),
            generation: randomUUID(),
            label: 'webR test',
            directory: project,
            storage: path.join(root, 'session'),
            provider: 'webr',
            supervision: 'test',
            historyLimit: 100,
            maxOutputBytes: 1024 * 1024,
            maxJournalBytes: 4 * 1024 * 1024,
            // The npm distribution includes real Wasm assets for an offline test.
            backend: {
                kind: 'webr',
                options: { baseUrl },
            },
        };
        // Exercise the same process entry point as a managed Interactive agent.
        launchDirectory = path.join(root, 'launcher');
        fs.mkdirSync(launchDirectory);
        fs.mkdirSync(config.storage, { mode: 0o700 });
        const configFile = path.join(config.storage, 'config.json');
        fs.writeFileSync(configFile, JSON.stringify(config));
        agent = spawn(
            process.execPath,
            [require.resolve('../../interactive/agentMain'), configFile],
            {
                cwd: launchDirectory,
                stdio: 'inherit',
            },
        );
        closed = once(agent, 'close');
        for (let i = 0; i < 500; i++) {
            const ready = readSessionManifest(config.storage, config.id, config.generation);
            if (ready?.status === 'idle') {
                manifest = ready;
                await connect();
                return;
            }
            if (ready?.startupError || agent.exitCode !== null || agent.signalCode !== null) {
                throw new Error(ready?.startupError ?? 'webR agent exited during startup');
            }
            await delay(20);
        }
        throw new Error('webR agent did not become ready');
    });

    teardown(async () => {
        client?.close();
        agent?.kill();
        await closed;
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function connect(): Promise<void> {
        events = [];
        client = new AgentClient(manifest);
        client.on('event', (event: SessionEvent) => events.push(event));
        await client.connect({ claim: true });
        await client.subscribe(0);
    }
    async function submit(code: string): Promise<string> {
        const id = randomUUID();
        await client.request('submit', { submission: { id, code } });
        return id;
    }
    async function wait(id: string | undefined, type: string): Promise<SessionEvent> {
        for (let i = 0; i < 500; i++) {
            const event = events.find((item) => item.executionId === id && item.type === type);
            if (event) {
                return event;
            }
            await delay(20);
        }
        throw new Error('Missing ' + type + ' for ' + id + ': ' + JSON.stringify(events.slice(-6)));
    }
    function inspect<T>(method: string, params: Record<string, unknown>): Promise<T> {
        return client.request<T>('inspect', { method, params });
    }
    function output(id: string): string {
        return events
            .filter((event) => event.type === 'stream' && event.executionId === id)
            .map((e) => e.data.text)
            .join('');
    }

    test('downloads a repository index with private host scratch files and the R project as its working directory', async () => {
        // This makes the upstream synchronous HTTP bridge fail in the launcher
        // directory even when a privileged runner could write to a read-only folder.
        fs.mkdirSync(path.join(launchDirectory, '.node-xmlhttprequest-sync-' + manifest.agentPid));
        const index = 'Package: fixture\nVersion: 1.0.0\n';
        const http = createServer((_request, response) => response.end(index));
        try {
            http.listen(0, '127.0.0.1');
            await once(http, 'listening');
            const address = http.address();
            assert.ok(address && typeof address === 'object');
            const id = await submit(
                [
                    'stopifnot(getwd() == "/project")',
                    'writeLines(webr::eval_js("process.cwd()"), "host-cwd.txt")',
                    `download.file("http://127.0.0.1:${address.port}/PACKAGES", "PACKAGES", quiet = TRUE)`,
                ].join('\n'),
            );
            assert.equal((await wait(id, 'finished')).data.state, 'success', output(id));
            assert.equal(fs.readFileSync(path.join(project, 'PACKAGES'), 'utf8'), index);
            const hostCwd = fs.readFileSync(path.join(project, 'host-cwd.txt'), 'utf8').trimEnd();
            assert.equal(fs.realpathSync(hostCwd), fs.realpathSync(path.join(root, 'session')));
        } finally {
            http.close();
        }
    });

    test('shows native table and list outputs with live paging and nested navigation', async () => {
        assert.equal(manifest.capabilities.tables, true);
        assert.equal(manifest.capabilities.inspection, false);
        const id = await submit(
            [
                'lst <- list(first = 1, nested = list(frame = mtcars), last = "end")',
                'View(mtcars)',
                'mtcars',
                'View(lst)',
                'lst',
            ].join('\n'),
        );
        assert.equal((await wait(id, 'finished')).data.state, 'success', output(id));
        const displays = events
            .filter((e) => e.executionId === id && e.type === 'display')
            .map((e) => e.data);
        assert.deepEqual(
            displays.map((d) => d.kind),
            ['table', 'table', 'list', 'list'],
        );
        const [table, , list] = displays;
        assert.equal(table.totalRows, 32);
        assert.equal((table.rows as unknown[]).length, 20);
        const preview = table.rows as Record<string, unknown>[];
        assert.equal(preview[0]['0'], 'Mazda RX4');
        assert.equal(preview[0]['1'], 21);
        assert.equal(typeof table.printedText, 'string');

        type TablePage = { totalRows: number; rows: Record<string, unknown>[] };
        const meta = await inspect<{
            totalRows: number;
            columns: { field: string; headerName: string }[];
        }>('dataview_init', { view_id: table.viewId });
        assert.equal(meta.totalRows, 32);
        assert.deepEqual(
            meta.columns.slice(1, 3).map((col) => col.headerName),
            ['mpg', 'cyl'],
        );
        const sorted = await inspect<TablePage>('dataview_page', {
            view_id: table.viewId,
            startRow: 0,
            endRow: 2,
            sortModel: [{ colId: '1', sort: 'desc' }],
        });
        assert.deepEqual(
            sorted.rows.map((row) => row['0']),
            ['Toyota Corolla', 'Fiat 128'],
        );
        const last = await inspect<TablePage>('dataview_page', {
            view_id: table.viewId,
            startRow: 31,
            endRow: 32,
        });
        assert.equal(last.rows[0]['0'], 'Volvo 142E');
        assert.deepEqual(
            (list.children as { label: string }[]).map((x) => x.label),
            ['$ first', '$ nested', '$ last'],
        );
        const nav = await inspect<{ title: string; breadcrumbs: unknown[] }>('listview_navigate', {
            view_id: list.viewId,
            path: [2],
        });
        assert.equal(nav.title, 'List$nested');
        assert.equal(nav.breadcrumbs.length, 2);
        const items = await inspect<{ children: { label: string }[] }>('workspace_children', {
            view_id: list.viewId,
            path: [2],
            start: 1,
        });
        assert.deepEqual(
            items.children.map((x) => x.label),
            ['$ frame'],
        );
        assert.equal(
            await inspect('listview_view', { view_id: list.viewId, path: [2], index: 1 }),
            true,
        );
        const panel = await wait(undefined, 'viewer');
        assert.equal(panel.data.method, 'dataview');
        const params = panel.data.params as { source: string; title: string; view_id: string };
        assert.equal(params.source, 'table');
        assert.equal(params.title, 'List$nested$frame');
        const nested = await inspect<TablePage>('dataview_page', {
            view_id: params.view_id,
            startRow: 31,
            endRow: 32,
        });
        assert.equal(nested.rows[0]['0'], 'Volvo 142E');
        await assert.rejects(inspect('workspace', {}), /inspection/);
        await assert.rejects(inspect('workspace_children', { name: 'mtcars' }), /inspection/);
    });

    test('bounds retained previews and uses handles for remaining table and list rows', async () => {
        const id = await submit('data.frame(x = seq_len(2000))\nas.list(seq_len(502))');
        assert.equal((await wait(id, 'finished')).data.state, 'success', output(id));
        const [table, list] = events
            .filter((e) => e.type === 'display' && e.executionId === id)
            .map((e) => e.data);
        assert.equal(table.sourceRows, 2000);
        assert.equal(table.totalRows, 1000);
        assert.equal((table.rows as unknown[]).length, 20);
        assert.notEqual(table.fullViewId, table.viewId);
        const full = await inspect<{ rows: Record<string, unknown>[] }>('dataview_page', {
            view_id: table.fullViewId,
            startRow: 1999,
            endRow: 2000,
        });
        assert.equal(full.rows[0]['1'], 2000);
        assert.equal((list.children as unknown[]).length, 500);
        assert.equal(list.next_start, 501);
        const rest = await inspect<{ children: { index: number }[] }>('workspace_children', {
            view_id: list.viewId,
            path: [],
            start: 501,
        });
        assert.deepEqual(
            rest.children.map((item) => item.index),
            [501, 502],
        );
        await assert.rejects(
            inspect('dataview_page', { view_id: table.fullViewId, startRow: 0, endRow: 1000000 }),
            /page|rows/i,
        );
    });

    test('mounts a project and retains R objects, files and PNG output across an editor reconnect', async () => {
        assert.equal(manifest.backend, 'webr');
        assert.equal(manifest.rPath, undefined);
        assert.equal(manifest.rPid, undefined);
        assert.match(manifest.rVersion!, /^R version /);
        fs.writeFileSync(path.join(project, 'data.csv'), 'x,y\n1,3\n2,5\n3,7\n');
        fs.writeFileSync(path.join(project, 'fit.R'), 'fit <- lm(y ~ x, read.csv("data.csv"))\n');
        const first = await submit(
            'source("fit.R")\nplot(1:3)\nplot(3:1)\nwarning("cell warning")',
        );
        assert.equal((await wait(first, 'finished')).data.state, 'success');
        assert.match(output(first), /cell warning/);
        const plots = events.filter(
            (event) => event.executionId === first && event.type === 'display',
        );
        assert.equal(plots.length, 2);
        for (const plot of plots) {
            assert.equal(plot.data.mime, 'image/png');
            assert.equal(typeof plot.data.asset, 'string');
        }
        client.close();
        await connect();
        const snapshot = await client.snapshot();
        assert.ok(snapshot.events.some((e) => e.executionId === first && e.type === 'display'));
        const next = await submit(
            'writeLines(as.character(unname(coef(fit)[2])), "slope.txt")\ncoef(fit)[2]',
        );
        assert.equal((await wait(next, 'finished')).data.state, 'success');
        assert.equal(fs.readFileSync(path.join(project, 'slope.txt'), 'utf8').trim(), '2');
    });

    test('delivers widgets, tables, text fragments and nested input in expression order', async () => {
        // Exercise the HTML transport without downloading an optional widget package in CI.
        const id = await submit(
            [
                'folder <- tempfile(); dir.create(folder); writeLines("<p>widget</p>", file.path(folder, "index.html"))',
                'emit <- environment(getOption("vscodeR.webR.execute"))$send_widget',
                'cat("prefix"); emit(folder, 1L); data.frame(x = 1:2); cat("next"); emit(folder, 1L)',
                'reply <- readline("value? "); cat(paste("answer", reply))',
            ].join('\n'),
        );
        const prompt = await wait(id, 'input');
        const seen = events
            .filter((item) => item.executionId === id)
            .flatMap((item) => {
                if (item.type === 'input') {
                    return ['input'];
                }
                if (item.type === 'display') {
                    return [String(item.data.kind)];
                }
                if (item.type === 'stream' && ['prefix', 'next'].includes(String(item.data.text))) {
                    return [String(item.data.text)];
                }
                return [];
            });
        assert.deepEqual(seen, ['prefix', 'html', 'table', 'next', 'html', 'input']);
        await client.request('input', { id: prompt.data.inputId, executionId: id, value: 'ok' });
        assert.equal((await wait(id, 'finished')).data.state, 'success');
        assert.match(output(id), /answer ok/);
    });

    test('reports cell errors, answers nested prompts, and interrupts a busy or waiting cell without losing R state', async () => {
        const bad = await submit('stop("sample error")');
        assert.equal((await wait(bad, 'finished')).data.state, 'error');
        assert.match(output(bad), /sample error/);
        const question = await submit('word <- readline("> "); cat(word)');
        const prompt = await wait(question, 'input');
        await client.request('input', {
            id: prompt.data.inputId,
            executionId: question,
            value: 'kept',
        });
        assert.equal((await wait(question, 'finished')).data.state, 'success');
        assert.match(output(question), /kept/);
        const busy = await submit('repeat { }');
        await wait(busy, 'started');
        await client.request('interrupt');
        assert.equal((await wait(busy, 'finished')).data.state, 'interrupted');
        const waiting = await submit('readline("another prompt")');
        await wait(waiting, 'input');
        await client.request('interrupt');
        assert.equal((await wait(waiting, 'finished')).data.state, 'interrupted');
        const next = await submit('cat(word)');
        assert.equal((await wait(next, 'finished')).data.state, 'success');
        assert.match(output(next), /kept/);
        const quitting = await submit('q("no", runLast=FALSE)');
        await wait(quitting, 'finished');
        assert.equal((await client.snapshot()).manifest.status, 'exited');
    });

    test('installs packages from the configured Wasm repository without replacing library or require', async () => {
        // Serve a tiny binary fixture through the ordinary package index and tarball paths.
        const http = await import('node:http');
        const server = http.createServer((request, response) => {
            const name = request.url?.split('/').at(-1);
            if (name === 'PACKAGES.rds' || name === 'vscoderfixture_1.0.0.tgz') {
                response.end(fs.readFileSync(path.join(project, name)));
            } else {
                response.writeHead(404).end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        try {
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            const id = await submit(`local({
                pkg <- "vscoderfixture"
                dir.create(file.path(pkg, "Meta"), recursive = TRUE)
                meta <- readRDS(system.file("Meta", "package.rds", package = "datasets"))
                meta$DESCRIPTION[c("Package", "Version")] <- c(pkg, "1.0.0")
                write.dcf(as.data.frame(as.list(meta$DESCRIPTION)), file.path(pkg, "DESCRIPTION"))
                saveRDS(meta, file.path(pkg, "Meta", "package.rds"))
                writeLines(character(), file.path(pkg, "NAMESPACE"))
                utils::tar("vscoderfixture_1.0.0.tgz", pkg, tar = "internal", compression = "gzip")
                index <- as.matrix(data.frame(Package = pkg, Version = "1.0.0",
                    Depends = NA_character_, Imports = NA_character_, LinkingTo = NA_character_, row.names = pkg))
                saveRDS(index, "PACKAGES.rds")

                lib <- tempfile()
                dir.create(lib)
                options(webr_pkg_repos = "http://127.0.0.1:${address.port}")
                install.packages(pkgs = pkg, lib, quiet = TRUE)
                stopifnot(identical(library, base::library), identical(require, base::require),
                    identical(requireNamespace, base::requireNamespace))
                library(pkg, character.only = TRUE, lib.loc = lib)
                stopifnot(as.character(utils::packageVersion(pkg, lib.loc = lib)) == "1.0.0")
            })`);
            assert.equal((await wait(id, 'finished')).data.state, 'success', output(id));
            const absent = await submit('install.packages("missingfixture", quiet = TRUE)');
            assert.equal((await wait(absent, 'finished')).data.state, 'error');
            assert.match(
                output(absent),
                /Could not install missingfixture from the webR binary repositories/,
            );
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
