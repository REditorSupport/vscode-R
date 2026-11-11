import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { PlotHistory } from '../../plotViewer/jgdPlotHistory';
import { JgdMessage, JgdSocketServer } from '../../plotViewer/jgdSocketServer';
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
                throw new Error(
                    'Live plot tests require processx, later, jsonlite, jgd, httpgd and svglite',
                );
            }
        } catch (error) {
            if (process.env.VSCR_REQUIRE_PLOT_TESTS === '1') {
                throw error;
            }
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

    for (const [backend, deviceMode] of [
        ['jgd', 'default'],
        ['jgd', 'reused'],
        ['jgd', 'explicit-reused'],
        ['jgd', 'explicit'],
        ['standard', 'default'],
        ['httpgd', 'default'],
    ] as const) {
        const reuseDevice = deviceMode === 'reused' || deviceMode === 'explicit-reused';
        const explicitDevice = deviceMode === 'explicit' || deviceMode === 'explicit-reused';
        const name = reuseDevice
            ? `jgd preserves closed-device history when ${explicitDevice ? 'an explicit device' : 'R'} reuses a device number`
            : explicitDevice
              ? 'explicit JGD devices resume plot delivery after reconnect'
              : `${backend} retains its live R plot across renderer and session reconnect`;
        test(name, async () => {
            let history = new PlotHistory();
            let jgd: JgdSocketServer;
            let server: net.Server;
            let r: ChildProcessWithoutNullStreams | undefined;
            let httpgd: HttpgdClient | undefined;
            let externalRenderer: net.Server | undefined;
            const externalSockets = new Set<net.Socket>();
            const externalFrames: JgdMessage[] = [];
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
                if (explicitDevice && !reuseDevice) {
                    await evaluate('jgd::jgd(width=4, height=3, dpi=144); TRUE');
                }
                await evaluate('plot(1:3, main="first plot"); TRUE');
                if (backend === 'jgd') {
                    await until(() => (history.count() === 1 ? true : undefined));
                }
                const closedHistory = reuseDevice
                    ? structuredClone(history.snapshot().sessions[0])
                    : undefined;
                if (reuseDevice) {
                    await evaluate('old_device <- dev.cur(); dev.off(); TRUE');
                    if (explicitDevice) {
                        await evaluate('jgd::jgd(width=4, height=3, dpi=144); TRUE');
                    }
                }
                await evaluate('plot(3:1, main="before reload"); TRUE');
                if (reuseDevice) {
                    await evaluate('stopifnot(dev.cur() == old_device); TRUE');
                }
                const plotsBeforeReload = 2;
                let originalId: string | undefined;
                let httpgdUrl: string | undefined;
                if (backend === 'jgd') {
                    originalId = await until(() =>
                        history
                            .snapshot()
                            .sessions.reduce((n, entry) => n + entry.plots.length, 0) ===
                            plotsBeforeReload && history.getActiveSessionId() !== closedHistory?.id
                            ? history.getActiveSessionId()
                            : undefined,
                    );
                    if (explicitDevice) {
                        // The extension resolves explicit devices through the attached
                        // session and native PID label before persisting their history.
                        const source = await evaluate(
                            'list(sessionId=sess:::.session_id(), host=unname(Sys.info()[["nodename"]]), pid=as.character(Sys.getpid()), rVer=as.character(getRversion()), processExited=FALSE)',
                        );
                        history.setSessionSource(
                            originalId,
                            source as unknown as import('../../viewerSession').ViewerSessionSource,
                        );
                    } else {
                        assert.ok(history.sessionSource(originalId)?.sessionId);
                    }
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
                const deviceIds = history.sessionIds();
                if (backend === 'jgd') {
                    // Preserve the live viewport size, not just the dimensions
                    // originally passed to the device factory.
                    jgd!.handleResize(864, 648, originalId!);
                    await evaluate('.Call(jgd:::C_jgd_poll_resize); TRUE');
                    await until(() =>
                        history.latestPlot(originalId!)?.device.width === 864 &&
                        history.latestPlot(originalId!)?.device.height === 648
                            ? true
                            : undefined,
                    );
                    await evaluate('device_geometry <- c(dev.size("in"), dev.size("px")); TRUE');
                }
                if (explicitDevice) {
                    externalRenderer = net.createServer((socket) => {
                        externalSockets.add(socket);
                        socket.on('close', () => externalSockets.delete(socket));
                        socket.write(
                            JSON.stringify({
                                type: 'server_info',
                                serverName: 'other-renderer',
                                protocolVersion: 1,
                                transport: 'tcp',
                            }) + '\n',
                        );
                        let buffer = '';
                        socket.on('data', (data) => {
                            buffer += data.toString();
                            let end: number;
                            while ((end = buffer.indexOf('\n')) >= 0) {
                                const message = JSON.parse(buffer.slice(0, end)) as JgdMessage;
                                buffer = buffer.slice(end + 1);
                                if (message.type === 'metrics_request') {
                                    socket.write(
                                        JSON.stringify({
                                            type: 'metrics_response',
                                            id: message.id,
                                            width: 8,
                                            ascent: 8,
                                            descent: 2,
                                        }) + '\n',
                                    );
                                } else if (message.type === 'frame') {
                                    externalFrames.push(message);
                                }
                            }
                        });
                    });
                    await new Promise<void>((resolve) =>
                        externalRenderer!.listen(0, '127.0.0.1', resolve),
                    );
                    const port = (externalRenderer.address() as net.AddressInfo).port;
                    await evaluate(
                        `own_device <- dev.cur(); jgd::jgd(socket="tcp://127.0.0.1:${port}"); external_device <- dev.cur(); plot(1:2, main="external renderer"); dev.set(own_device); TRUE`,
                    );
                }
                const saved: unknown = JSON.parse(JSON.stringify(history.snapshot()));
                await stopServers();
                await evaluate('sess:::.transport_disconnect(silent=TRUE, reconnect=TRUE); TRUE');
                if (backend === 'standard') {
                    await evaluate('plot(2:4, main="while disconnected"); TRUE');
                }
                history = new PlotHistory();
                history.restore(saved);
                notifications.length = 0;
                await startServers();
                await connect();
                if (backend === 'jgd') {
                    await evaluate(
                        'stopifnot(isTRUE(all.equal(c(dev.size("in"), dev.size("px")), device_geometry))); TRUE',
                    );
                }
                if (explicitDevice) {
                    // Reopening assigns a logical ID and transfers the existing
                    // timeline entry, rather than duplicating its current plot.
                    const restoredId = await until(() =>
                        history.sessionIds().find((id) => !deviceIds.includes(id)),
                    );
                    assert.ok(history.sessionSource(restoredId)?.sessionId);
                    assert.ok(jgd!.isConnected(restoredId));
                    assert.equal(history.count(restoredId), 2);
                    assert.equal(history.count(originalId), 0);
                    assert.equal(history.sessionIds().length, reuseDevice ? 2 : 1);
                    if (closedHistory) {
                        assert.deepEqual(
                            history
                                .snapshot()
                                .sessions.find((entry) => entry.id === closedHistory.id)?.plots,
                            closedHistory.plots,
                        );
                        assert.equal(jgd!.isConnected(closedHistory.id), false);
                    }
                    history.navigateFirst(restoredId);
                    assert.equal(history.currentRIndex(restoredId), closedHistory?.plots[0].rIndex);
                    assert.ok(
                        JSON.stringify(history.currentPlot(restoredId)?.ops).includes('first plot'),
                    );
                    history.navigateLast(restoredId);
                    assert.ok(
                        JSON.stringify(history.latestPlot(restoredId)?.ops).includes(
                            'before reload',
                        ),
                    );
                    await evaluate('plot(2:4, main="after reload"); TRUE');
                    await until(() => (history.count(restoredId) === 3 ? true : undefined));
                    assert.ok(
                        JSON.stringify(history.latestPlot(restoredId)?.ops).includes(
                            'after reload',
                        ),
                    );
                    await evaluate(
                        'restored_device <- dev.cur(); stopifnot(restored_device != external_device); dev.set(external_device); stopifnot(jgd::jgd_server_info()$server_name == "other-renderer"); plot(2:1, main="still external"); dev.set(restored_device); TRUE',
                    );
                    await until(() =>
                        externalFrames.some((message) =>
                            JSON.stringify(message.plot?.ops).includes('still external'),
                        )
                            ? true
                            : undefined,
                    );
                } else if (backend === 'jgd') {
                    await until(() =>
                        jgd!.isConnected(originalId!) &&
                        history.latestPlot(originalId!)?.rIndex === 0
                            ? true
                            : undefined,
                    );
                    assert.deepEqual(history.sessionIds(), deviceIds);
                    assert.equal(
                        history.count(originalId),
                        plotsBeforeReload,
                        'replay replaces the latest plot instead of duplicating history',
                    );
                    if (closedHistory) {
                        assert.deepEqual(
                            history
                                .snapshot()
                                .sessions.find((entry) => entry.id === closedHistory.id),
                            closedHistory,
                            'a reused R device number must not overwrite the closed device history',
                        );
                        assert.equal(jgd!.isConnected(closedHistory.id), false);
                    }
                    history.navigateFirst(originalId);
                    assert.equal(
                        history.currentRIndex(originalId),
                        reuseDevice ? closedHistory!.plots[0].rIndex : undefined,
                        'old replay indices must not target the replacement device',
                    );
                    history.navigateLast(originalId);
                    await evaluate('plot(2:4, main="after reload"); TRUE');
                    await until(() =>
                        history.count(originalId) === plotsBeforeReload + 1 ? true : undefined,
                    );
                    assert.deepEqual(history.sessionIds(), deviceIds);

                    // JGD stores frame extensions in snapshots, so resizing the
                    // restored plot still sends restoring=true after a new plot.
                    const latest = structuredClone(history.latestPlot(originalId!));
                    history.navigatePrevious(originalId);
                    assert.equal(history.currentRIndex(originalId), 0);
                    let resized: JgdMessage | undefined;
                    jgd!.setOnFrame((_id, message) => {
                        if (message.resizeReplay) {
                            resized = message;
                        }
                    });
                    jgd!.handleResize(900, 700, originalId!);
                    await evaluate('.Call(jgd:::C_jgd_poll_resize); TRUE');
                    const response = await until(() => resized);
                    assert.equal(response.plotIndex, 0);
                    assert.equal(
                        (response.ext?.vscodeR as { restoring?: boolean })?.restoring,
                        true,
                    );
                    assert.equal(history.currentPlot(originalId)?.device.width, 900);
                    assert.equal(history.currentPlot(originalId)?.device.height, 700);
                    assert.equal(history.currentRIndex(originalId), 0);
                    assert.equal(history.currentIndex(originalId), plotsBeforeReload);
                    assert.equal(history.count(originalId), plotsBeforeReload + 1);
                    assert.deepEqual(
                        history.latestPlot(originalId!),
                        latest,
                        'resizing the restored historical plot must preserve the new plot',
                    );
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
                    assert.equal(
                        await until(
                            () =>
                                notifications.find((item) => item.method === 'plot_updated')?.params
                                    .restoring,
                        ),
                        true,
                        'reattachment refreshes existing standard viewers without opening closed ones',
                    );
                    const plot = await evaluate(
                        'sess:::handle_plot_latest(list(format="svglite"))',
                    );
                    assert.ok(
                        Buffer.from(plot.data, 'base64').toString().includes('while disconnected'),
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
                for (const socket of externalSockets) {
                    socket.destroy();
                }
                if (externalRenderer) {
                    await new Promise<void>((resolve) => externalRenderer!.close(() => resolve()));
                }
            }
        });
    }
});
