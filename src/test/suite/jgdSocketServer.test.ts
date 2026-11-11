import * as assert from 'assert';
import * as net from 'net';
import { PlotHistory, PlotFrame } from '../../plotViewer/jgdPlotHistory';
import { JgdSocketServer, JgdMessage } from '../../plotViewer/jgdSocketServer';

let plotCounter = 0;
function makePlotMsg(
    label: string,
    width = 400,
    height = 300,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    const msg: Record<string, unknown> = {
        type: 'frame',
        plot: {
            version: 1,
            sessionId: '',
            device: { width, height, dpi: 96, bg: label },
            ops: [{ op: 'rect', label }],
        },
        ...extra,
    };
    if (!extra.resizeReplay && !extra.incremental && msg.plotNumber === undefined) {
        msg.plotNumber = plotCounter++;
        if (msg.newPage === undefined) {
            msg.newPage = true;
        }
    }
    return msg;
}

interface ClientHelper {
    socket: net.Socket;
    send: (msg: object) => void;
    readLine: () => Promise<string>;
    close: () => void;
}

function uriToConnectPath(uri: string): string {
    const NPIPE_PREFIX = 'npipe:////./pipe/';
    if (uri.startsWith(NPIPE_PREFIX)) {
        return `\\\\.\\pipe\\${uri.slice(NPIPE_PREFIX.length)}`;
    }
    return uri;
}

function connectClient(socketUri: string): Promise<ClientHelper> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = '';
        const lineQueue: string[] = [];
        let lineResolve: ((line: string) => void) | null = null;

        socket.on('data', (data) => {
            buffer += data.toString();
            let idx: number;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, idx);
                buffer = buffer.substring(idx + 1);
                if (lineResolve) {
                    const r = lineResolve;
                    lineResolve = null;
                    r(line);
                } else {
                    lineQueue.push(line);
                }
            }
        });

        socket.on('error', (err) => {
            if (lineResolve) {
                const r = lineResolve;
                lineResolve = null;
                r('');
            }
            reject(err);
        });

        socket.connect(uriToConnectPath(socketUri), () => {
            resolve({
                socket,
                send: (msg: object) => socket.write(JSON.stringify(msg) + '\n'),
                readLine: () => {
                    if (lineQueue.length > 0) {
                        return Promise.resolve(lineQueue.shift()!);
                    }
                    return new Promise((res) => {
                        lineResolve = res;
                    });
                },
                close: () => socket.destroy(),
            });
        });
    });
}

function waitMs(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

suite('JGD SocketServer', () => {
    let history: PlotHistory;
    let server: JgdSocketServer;
    let clients: ClientHelper[];
    let shownPlots: PlotFrame[];
    let measuredRequests: JgdMessage[];
    let closedSessions: string[];
    let dims: { width: number; height: number };

    setup(async () => {
        plotCounter = 0;
        history = new PlotHistory(50);
        server = new JgdSocketServer(history);
        clients = [];
        shownPlots = [];
        measuredRequests = [];
        closedSessions = [];
        dims = { width: 800, height: 600 };

        server.setOnFrame((_sessionId, msg) => {
            const current = history.currentPlot();
            if (current) {
                shownPlots.push(current);
            } else if (msg.plot) {
                shownPlots.push(msg.plot as PlotFrame);
            }
        });

        server.setMeasureText((request) => {
            measuredRequests.push(request);
            return Promise.resolve({
                type: 'metrics_response',
                id: request.id,
                width: 42,
                ascent: 10,
                descent: 3,
            });
        });

        server.setGetDimensions(() => dims);

        server.setOnDeviceClosed((sessionId) => {
            closedSessions.push(sessionId);
        });

        server.start();
        await new Promise<void>((resolve) => server.onReady(resolve));
    });

    teardown(() => {
        for (const c of clients) {
            c.close();
        }
        server.stop();
    });

    async function connect(): Promise<ClientHelper> {
        const client = await connectClient(server.getSocketPath());
        clients.push(client);
        client.send({ type: 'hello' });
        await client.readLine(); // server_info
        await client.readLine(); // initial resize
        return client;
    }

    suite('frame routing', () => {
        test('resize replays retain their target when snapshots carry restoration metadata', async () => {
            const identity = {
                sessionId: 'session-a',
                host: 'localhost',
                pid: '123',
                rVer: '4.5.0',
                processExited: false,
                deviceId: '1',
            };
            async function sendFrame(client: ClientHelper, message: object) {
                client.send(message);
                client.send({ type: 'metrics_request', id: 42, kind: 'strWidth', str: 'barrier' });
                await client.readLine();
            }
            const original = await connect();
            await sendFrame(
                original,
                makePlotMsg('original', 400, 300, {
                    newPage: true,
                    plotNumber: 0,
                    ext: { vscodeR: identity },
                }),
            );
            const id = history.getActiveSessionId();
            const replacement = await connect();
            const ext = { vscodeR: { ...identity, restoring: true } };
            await sendFrame(
                replacement,
                makePlotMsg('restored', 400, 300, {
                    newPage: true,
                    plotNumber: 0,
                    ext,
                }),
            );
            assert.strictEqual(history.count(id), 1, 'initial replay replaces the latest plot');
            await sendFrame(
                replacement,
                makePlotMsg('new plot', 400, 300, {
                    newPage: true,
                    plotNumber: 1,
                    ext: { vscodeR: identity },
                }),
            );
            const latest = structuredClone(history.latestPlot(id));
            history.navigatePrevious(id);
            const resize = makePlotMsg('resized restored plot', 900, 700, {
                resizeReplay: true,
                plotIndex: 0,
                plotNumber: 1,
                ext,
            });
            await sendFrame(replacement, resize);
            assert.strictEqual(history.currentPlot(id)?.device.bg, 'resized restored plot');
            assert.strictEqual(history.currentRIndex(id), 0);
            assert.strictEqual(history.currentIndex(id), 1);
            assert.strictEqual(history.count(id), 2);
            assert.deepStrictEqual(history.latestPlot(id), latest);

            history.removeCurrent(id);
            await sendFrame(replacement, resize);
            assert.strictEqual(
                history.count(id),
                1,
                'late resize must not resurrect a deleted plot',
            );
            assert.deepStrictEqual(history.latestPlot(id), latest);

            await sendFrame(
                replacement,
                makePlotMsg('stale current-page resize', 900, 700, {
                    resizeReplay: true,
                    plotNumber: 0,
                    ext,
                }),
            );
            assert.deepStrictEqual(history.latestPlot(id), latest);
        });

        test('reconnects the original device within its shared session history', async () => {
            const identity = {
                sessionId: 'session-a',
                host: 'localhost',
                pid: '123',
                rVer: '4.5.0',
                processExited: false,
                deviceId: '1',
            };
            async function sendFrame(
                client: ClientHelper,
                label: string,
                source: object,
                restoring = false,
            ) {
                client.send(
                    makePlotMsg(label, 400, 300, {
                        plotNumber: 0,
                        newPage: true,
                        ext: { vscodeR: { ...source, restoring } },
                    }),
                );
                client.send({ type: 'metrics_request', id: 42, kind: 'strWidth', str: 'barrier' });
                await client.readLine();
            }
            const original = await connect();
            await sendFrame(original, 'original', identity);
            const id = history.getActiveSessionId();
            await sendFrame(await connect(), 'other device', { ...identity, deviceId: '2' });
            await sendFrame(await connect(), 'other session', {
                ...identity,
                sessionId: 'session-b',
                pid: '456',
            });
            const replacement = await connect();
            await sendFrame(replacement, 'restored', identity, true);
            assert.strictEqual(history.sessionIds().length, 3);
            assert.strictEqual(history.count(id), 2);
            assert.strictEqual(history.latestPlot(id)?.device.bg, 'restored');
            await waitMs(50); // Let the old socket close after its replacement connects.
            assert.ok(server.isConnected(id));
            await sendFrame(replacement, 'new plot', identity);
            assert.strictEqual(history.count(id), 3);
            assert.strictEqual(history.sessionIds().length, 3);
        });

        test('reconnect replay does not restore a plot the user deleted', async () => {
            const identity = {
                sessionId: 'session-a',
                host: 'localhost',
                pid: '123',
                rVer: '4.5.0',
                processExited: false,
                deviceId: '1',
            };
            const original = await connect();
            original.send(makePlotMsg('original', 400, 300, { ext: { vscodeR: identity } }));
            await waitMs(50);
            const id = history.getActiveSessionId();
            history.removeCurrent(id);
            const replacement = await connect();
            replacement.send(
                makePlotMsg('replayed', 400, 300, {
                    ext: { vscodeR: { ...identity, restoring: true } },
                }),
            );
            replacement.send({ type: 'metrics_request', id: 42, kind: 'strWidth', str: 'barrier' });
            await replacement.readLine();
            assert.strictEqual(history.count(id), 0);
            replacement.send(makePlotMsg('new plot', 400, 300, { ext: { vscodeR: identity } }));
            replacement.send({ type: 'metrics_request', id: 43, kind: 'strWidth', str: 'barrier' });
            await replacement.readLine();
            assert.strictEqual(history.count(id), 1);
        });

        test('resizes only the requested device, regardless of the latest active session', async () => {
            const first = await connect();
            const second = await connect();
            first.send(makePlotMsg('A'));
            second.send(makePlotMsg('B'));
            await waitMs(50);
            const firstId = history
                .sessionIds()
                .find((id) => history.latestPlot(id)?.device.bg === 'A')!;
            server.handleResize(1000, 700, firstId);
            assert.strictEqual((JSON.parse(await first.readLine()) as JgdMessage).type, 'resize');
            second.send({ type: 'metrics_request', id: 42, kind: 'strWidth', str: 'barrier' });
            assert.strictEqual(
                (JSON.parse(await second.readLine()) as JgdMessage).type,
                'metrics_response',
            );
        });

        test('shared navigation resizes the selected device and deduplicates its live size', async () => {
            const first = await connect();
            const second = await connect();
            const source = {
                sessionId: 'r',
                host: 'host',
                pid: '123',
                rVer: '4.5.0',
                processExited: false,
            };
            async function send(
                client: ClientHelper,
                label: string,
                deviceId: string,
                plotNumber: number,
            ) {
                client.send(
                    makePlotMsg(label, 400, 300, {
                        plotNumber,
                        newPage: true,
                        ext: { vscodeR: { ...source, deviceId } },
                    }),
                );
                client.send({ type: 'metrics_request', id: 42, kind: 'strWidth', str: 'barrier' });
                await client.readLine();
            }
            await send(first, 'A0', 'a', 0);
            const firstId = history.getActiveSessionId();
            await send(second, 'B0', 'b', 0);
            const secondId = history.getActiveSessionId();
            await send(first, 'A1', 'a', 1);
            history.navigatePrevious(firstId); // B0 is still B's live plot.
            server.handleResize(900, 700, firstId);
            assert.deepStrictEqual(JSON.parse(await second.readLine()), {
                type: 'resize',
                width: 900,
                height: 700,
            });
            server.handleResize(900, 700, firstId);
            second.send({ type: 'metrics_request', id: 43, kind: 'strWidth', str: 'barrier' });
            assert.strictEqual(
                (JSON.parse(await second.readLine()) as JgdMessage).type,
                'metrics_response',
            );
            history.navigateFirst(secondId); // A0 needs A's snapshot index, not B's.
            server.handleResize(900, 700, secondId);
            assert.deepStrictEqual(JSON.parse(await first.readLine()), {
                type: 'resize',
                width: 900,
                height: 700,
                plotIndex: 0,
            });
            assert.strictEqual(history.currentPlot(firstId)?.device.bg, 'A0');
        });

        test('routes normal frame to addPlot', async () => {
            const client = await connect();

            client.send(makePlotMsg('A'));
            await waitMs(50);

            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');
            assert.strictEqual(shownPlots.length, 1);
        });

        test('routes incremental frame via appendOps', async () => {
            const client = await connect();

            client.send(makePlotMsg('A'));
            await waitMs(50);

            client.send({
                type: 'frame',
                plot: {
                    version: 1,
                    sessionId: '',
                    device: { width: 400, height: 300, dpi: 96, bg: 'A' },
                    ops: [{ op: 'line', label: 'extra' }],
                },
                incremental: true,
            });
            await waitMs(50);

            assert.strictEqual(history.count(), 1);
            const ops = history.currentPlot()?.ops as { op: string }[] | undefined;
            assert.strictEqual(ops?.length, 2);
            assert.strictEqual(shownPlots.length, 2);
        });

        test('routes resizeReplay frame to replaceLatest', async () => {
            const client = await connect();

            client.send(makePlotMsg('A'));
            await waitMs(50);

            client.send(makePlotMsg('A-resized', 1000, 700, { resizeReplay: true }));
            await waitMs(50);

            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A-resized');
        });
    });

    suite('resize after delete (jgd#11)', () => {
        test('resize after delete-latest uses plotIndex', async () => {
            const client = await connect();

            client.send(makePlotMsg('RED'));
            await waitMs(50);
            client.send(makePlotMsg('BLUE'));
            await waitMs(50);
            assert.strictEqual(history.count(), 2);

            history.removeCurrent();
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'RED');

            server.handleResize(1000, 700, history.getActiveSessionId());
            const resizeMsg = JSON.parse(await client.readLine()) as {
                type: string;
                plotIndex: number;
            };
            assert.strictEqual(resizeMsg.type, 'resize');
            assert.strictEqual(resizeMsg.plotIndex, 0);

            client.send(
                makePlotMsg('RED-resized', 1000, 700, { resizeReplay: true, plotIndex: 0 }),
            );
            await waitMs(50);

            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'RED-resized');
        });
    });

    suite('initial connection', () => {
        test('sends current panel dimensions on connect', async () => {
            dims = { width: 500, height: 400 };
            const client = await connectClient(server.getSocketPath());
            clients.push(client);
            client.send({ type: 'hello' });
            const info = JSON.parse(await client.readLine()) as { type: string };
            assert.strictEqual(info.type, 'server_info');
            const msg = JSON.parse(await client.readLine()) as {
                type: string;
                width: number;
                height: number;
            };
            assert.strictEqual(msg.type, 'resize');
            assert.strictEqual(msg.width, 500);
            assert.strictEqual(msg.height, 400);
        });
    });

    suite('close message', () => {
        test('forwards close with session id', async () => {
            const client = await connect();

            client.send({ type: 'close' });
            await waitMs(50);

            assert.strictEqual(closedSessions.length, 1);
            assert.ok(closedSessions[0].match(/^session-/));
        });
    });

    suite('metrics', () => {
        test('forwards metrics_request and returns response', async () => {
            const client = await connect();

            client.send({
                type: 'metrics_request',
                id: 7,
                kind: 'strWidth',
                str: 'hello',
                gc: { font: { size: 12, family: 'sans' } },
            });

            const resp = JSON.parse(await client.readLine()) as {
                type: string;
                id: number;
                width: number;
            };
            assert.strictEqual(resp.type, 'metrics_response');
            assert.strictEqual(resp.id, 7);
            assert.strictEqual(resp.width, 42);
            assert.strictEqual(measuredRequests.length, 1);
        });

        test('font measurement receives the owning session and DPI without leaking across connections', async () => {
            const first = await connect();
            const second = await connect();
            server.setMeasureText((request, dpi, sessionId) =>
                Promise.resolve({ type: 'metrics_response', id: request.id, dpi, sessionId }),
            );
            first.send({
                type: 'frame',
                newPage: true,
                plot: {
                    version: 1,
                    device: { width: 800, height: 600, dpi: 144, bg: 'white' },
                    ops: [],
                },
            });
            first.send({ type: 'metrics_request', id: 1, kind: 'strWidth', str: 'hello' });
            second.send({ type: 'metrics_request', id: 2, kind: 'strWidth', str: 'hello' });
            const firstResponse = JSON.parse(await first.readLine()) as {
                dpi: number;
                sessionId: string;
            };
            const secondResponse = JSON.parse(await second.readLine()) as {
                dpi: number;
                sessionId: string;
            };
            assert.strictEqual(firstResponse.dpi, 144);
            assert.strictEqual(secondResponse.dpi, 96);
            assert.strictEqual(firstResponse.sessionId, history.getActiveSessionId());
            assert.notStrictEqual(firstResponse.sessionId, secondResponse.sessionId);
        });
    });
});
