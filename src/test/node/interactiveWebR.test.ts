import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionAgent } from '../../interactive/agentMain';
import { prepareNodeWebR } from '../../webr/nodeRuntime';
import { AgentClient } from '../../interactive/client';
import type { AgentConfig, SessionEvent, SessionManifest } from '../../interactive/protocol';

suite('R Interactive webR provider', function () {
    this.timeout(60000);
    let root: string;
    let project: string;
    let agent: SessionAgent;
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
        agent = new SessionAgent(config);
        manifest = await agent.start();
        await connect();
    });

    teardown(async () => {
        client?.close();
        await agent?.close();
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
    async function wait(id: string, type: string): Promise<SessionEvent> {
        for (let i = 0; i < 500; i++) {
            const event = events.find((item) => item.executionId === id && item.type === type);
            if (event) {
                return event;
            }
            await delay(20);
        }
        throw new Error('Missing ' + type + ' for ' + id + ': ' + JSON.stringify(events.slice(-6)));
    }
    function output(id: string): string {
        return events
            .filter((event) => event.type === 'stream' && event.executionId === id)
            .map((e) => e.data.text)
            .join('');
    }

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
