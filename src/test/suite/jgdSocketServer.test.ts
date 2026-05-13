import * as assert from 'assert';
import * as net from 'net';
import { PlotHistory, PlotFrame } from '../../plotViewer/jgdPlotHistory';
import { JgdSocketServer, JgdMessage } from '../../plotViewer/jgdSocketServer';

let plotCounter = 0;
function makePlotMsg(label: string, width = 400, height = 300, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
        if (msg.newPage === undefined) msg.newPage = true;
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
                    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift()!);
                    return new Promise((res) => { lineResolve = res; });
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
            if (current) shownPlots.push(current);
            else if (msg.plot) shownPlots.push(msg.plot as PlotFrame);
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
        for (const c of clients) c.close();
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

            server.handleResize(1000, 700);
            const resizeMsg = JSON.parse(await client.readLine()) as { type: string; plotIndex: number };
            assert.strictEqual(resizeMsg.type, 'resize');
            assert.strictEqual(resizeMsg.plotIndex, 0);

            client.send(makePlotMsg('RED-resized', 1000, 700, { resizeReplay: true, plotIndex: 0 }));
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
            const msg = JSON.parse(await client.readLine()) as { type: string; width: number; height: number };
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

            const resp = JSON.parse(await client.readLine()) as { type: string; id: number; width: number };
            assert.strictEqual(resp.type, 'metrics_response');
            assert.strictEqual(resp.id, 7);
            assert.strictEqual(resp.width, 42);
            assert.strictEqual(measuredRequests.length, 1);
        });
    });
});
