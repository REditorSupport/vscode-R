import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { PlotHistory } from '../../plotViewer/jgdPlotHistory';
import { JgdSocketServer } from '../../plotViewer/jgdSocketServer';
import { HttpgdClient } from '../../plotViewer/httpgdClient';

const run = promisify(execFile);
async function until<T>(read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const result = read();
        if (result !== undefined) {
            return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for plot reconnect');
}

suite('Live R plot reconnect', function () {
    this.timeout(60000);
    let directory: string;
    let library: string;
    suiteSetup(async function () {
        try {
            const probe = await run('Rscript', [
                '--vanilla',
                '-e',
                'cat(all(vapply(c("processx", "later", "jsonlite", "jgd", "httpgd", "svglite"), requireNamespace, logical(1), quietly=TRUE)))',
            ]);
            if (probe.stdout.trim() !== 'TRUE') {
                this.skip();
            }
        } catch {
            this.skip();
        }
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plot-reconnect-'));
        library = path.join(directory, 'library');
        await fs.mkdir(library);
        await run('R', [
            'CMD',
            'INSTALL',
            '--no-test-load',
            `--library=${library}`,
            path.resolve('dist/resources/sess'),
        ]);
    });
    suiteTeardown(async () => {
        if (directory) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    for (const backend of ['jgd', 'standard', 'httpgd']) {
        test(`${backend} retains its live R plot across renderer and session reconnect`, async () => {
            let history = new PlotHistory();
            let jgd: JgdSocketServer;
            let server: net.Server;
            let r: ChildProcessWithoutNullStreams | undefined;
            let httpgd: HttpgdClient | undefined;
            const sockets = new Set<net.Socket>();
            const notifications: Array<{
                method: string;
                params: { url?: string; restoring?: boolean };
            }> = [];
            let endpoint = '';
            let generation = 0;
            async function startServers() {
                generation++;
                endpoint =
                    process.platform === 'win32'
                        ? `\\\\.\\pipe\\plot-reconnect-${process.pid}-${generation}`
                        : path.join(directory, `sess-${generation}.sock`);
                server = net.createServer((socket) => {
                    sockets.add(socket);
                    socket.on('close', () => sockets.delete(socket));
                    let buffer = '';
                    socket.on('data', (data) => {
                        buffer += data.toString();
                        let index: number;
                        while ((index = buffer.indexOf('\n')) >= 0) {
                            notifications.push(
                                JSON.parse(
                                    buffer.slice(0, index),
                                ) as (typeof notifications)[number],
                            );
                            buffer = buffer.slice(index + 1);
                        }
                    });
                });
                await new Promise<void>((resolve) => server.listen(endpoint, resolve));
                jgd = new JgdSocketServer(history);
                jgd.setMeasureText((request) =>
                    Promise.resolve({
                        type: 'metrics_response',
                        id: request.id,
                        width: 8,
                        ascent: 8,
                        descent: 2,
                    }),
                );
                await new Promise<void>((resolve) => {
                    jgd.onReady(resolve);
                    jgd.start();
                });
            }
            async function stopServers() {
                jgd?.stop();
                for (const socket of sockets) {
                    socket.destroy();
                }
                if (server) {
                    await new Promise<void>((resolve) => server.close(() => resolve()));
                }
            }
            try {
                await startServers();
                r = spawn('R', ['--vanilla', '--slave'], {
                    env: { ...process.env, R_LIBS_USER: library, JGD_SOCKET: jgd!.getSocketPath() },
                });
                let output = '';
                let errors = '';
                r.stdout.on('data', (data: Buffer) => {
                    output += data.toString();
                });
                r.stderr.on('data', (data: Buffer) => {
                    errors += data.toString();
                });
                let sequence = 0;
                async function evaluate(code: string): Promise<{ data: string; error?: string }> {
                    const marker = `PLOT_RESULT_${++sequence}:`;
                    r!.stdin.write(
                        `tryCatch({value <- {${code}}; cat(${JSON.stringify(marker)}, jsonlite::toJSON(value, auto_unbox=TRUE), "\\n", sep="")}, error=function(e) cat(${JSON.stringify(marker)}, jsonlite::toJSON(list(error=conditionMessage(e)), auto_unbox=TRUE), "\\n", sep=""))\n`,
                    );
                    const line = await until(() => {
                        if (r!.exitCode !== null) {
                            throw new Error(`R exited: ${errors}`);
                        }
                        const start = output.indexOf(marker);
                        const end = output.indexOf('\n', start);
                        return start >= 0 && end >= 0
                            ? output.slice(start + marker.length, end)
                            : undefined;
                    });
                    const result = JSON.parse(line) as { data: string; error?: string };
                    assert.ok(!result?.error, `${result?.error}\n${errors}`);
                    return result;
                }
                const connect = () =>
                    evaluate(
                        `Sys.setenv(JGD_SOCKET=${JSON.stringify(jgd!.getSocketPath())}); sess::connect(${JSON.stringify(endpoint)}, use_rstudioapi=FALSE, plot_backend="${backend}"); TRUE`,
                    );
                await connect();
                await evaluate('plot(1:3, main="first plot"); TRUE');
                await evaluate('plot(3:1, main="before reload"); TRUE');
                let originalId: string | undefined;
                let httpgdUrl: string | undefined;
                if (backend === 'jgd') {
                    originalId = await until(() =>
                        history.count() === 2 ? history.getActiveSessionId() : undefined,
                    );
                    assert.ok(history.sessionSource(originalId)?.sessionId);
                } else if (backend === 'httpgd') {
                    httpgdUrl = await until(
                        () => notifications.find((item) => item.method === 'httpgd')?.params.url,
                    );
                    const url = new URL(httpgdUrl);
                    httpgd = new HttpgdClient(
                        url.origin,
                        url.searchParams.get('token') ?? undefined,
                    );
                    await httpgd.connect();
                    assert.equal(httpgd.getPlots().length, 2);
                    httpgd.disconnect();
                } else {
                    const plot = await evaluate(
                        'sess:::handle_plot_latest(list(format="svglite"))',
                    );
                    assert.ok(
                        Buffer.from(plot.data, 'base64').toString().includes('before reload'),
                    );
                }
                const saved: unknown = JSON.parse(JSON.stringify(history.snapshot()));
                await stopServers();
                await evaluate('sess:::.transport_disconnect(silent=TRUE, reconnect=TRUE); TRUE');
                history = new PlotHistory();
                history.restore(saved);
                notifications.length = 0;
                await startServers();
                await connect();
                if (backend === 'jgd') {
                    await until(() =>
                        jgd!.isConnected(originalId!) &&
                        history.latestPlot(originalId!)?.rIndex === 0
                            ? true
                            : undefined,
                    );
                    assert.deepEqual(history.sessionIds(), [originalId]);
                    assert.equal(
                        history.count(originalId),
                        2,
                        'replay replaces the latest plot instead of duplicating history',
                    );
                    history.navigateFirst(originalId);
                    assert.equal(
                        history.currentRIndex(originalId),
                        undefined,
                        'old replay indices must not target the replacement device',
                    );
                    history.navigateLast(originalId);
                    await evaluate('plot(2:4, main="after reload"); TRUE');
                    await until(() => (history.count(originalId) === 3 ? true : undefined));
                    assert.deepEqual(history.sessionIds(), [originalId]);
                } else if (backend === 'httpgd') {
                    assert.equal(
                        await until(
                            () =>
                                notifications.find((item) => item.method === 'httpgd')?.params.url,
                        ),
                        httpgdUrl,
                    );
                    assert.equal(
                        notifications.find((item) => item.method === 'httpgd')?.params.restoring,
                        true,
                    );
                    const url = new URL(httpgdUrl!);
                    httpgd = new HttpgdClient(
                        url.origin,
                        url.searchParams.get('token') ?? undefined,
                    );
                    await httpgd.connect();
                    assert.equal(httpgd.getPlots().length, 2);
                    const svg = await httpgd.getPlotText({
                        id: httpgd.getPlots()[1].id,
                        renderer: 'svgp',
                    });
                    assert.ok(svg.includes('before reload'));
                } else {
                    assert.ok(
                        !notifications.some((item) => item.method === 'plot_updated'),
                        'reattachment must not announce an existing standard plot as new',
                    );
                    const plot = await evaluate(
                        'sess:::handle_plot_latest(list(format="svglite"))',
                    );
                    assert.ok(
                        Buffer.from(plot.data, 'base64').toString().includes('before reload'),
                    );
                }
            } finally {
                httpgd?.disconnect();
                if (r && r.exitCode === null) {
                    const exited = new Promise<void>((resolve) => r!.once('exit', () => resolve()));
                    r.kill();
                    await exited;
                }
                await stopServers();
            }
        });
    }
});
