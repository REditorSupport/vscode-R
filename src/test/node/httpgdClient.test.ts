import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Duplex } from 'node:stream';
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { HttpgdClient, HttpgdState } from '../../plotViewer/httpgdClient';

const nativeWebSocket = globalThis.WebSocket;

class TestWebSocket {
    static instances: TestWebSocket[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: URL) { TestWebSocket.instances.push(this); }
    open(): void { this.readyState = 1; this.onopen?.(); }
    message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
    close(): void { this.readyState = 3; this.onclose?.(); }
}

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() > deadline) { throw new Error('Timed out waiting for httpgd client'); }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

suite('Internal httpgd client', () => {
    let server: Server;
    let upgradedSocket: Duplex | undefined;
    let client: HttpgdClient;
    let origin: string;
    let remote: HttpgdState;
    let ids: string[];
    let requests: { path: string; token?: string }[];
    let websocketDescriptor: PropertyDescriptor | undefined;
    let held: ServerResponse[];
    let holdPlots: boolean;
    let invalidPlots: boolean;
    let notifications: string[][];
    const binary = Buffer.from([0, 255, 128, 13, 10]);

    setup(async () => {
        upgradedSocket = undefined;
        remote = { upid: 1, hsize: 1, active: true };
        ids = ['1'];
        requests = [];
        held = [];
        holdPlots = invalidPlots = false;
        notifications = [];
        TestWebSocket.instances = [];
        websocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
        Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true });
        server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', origin);
            requests.push({ path: url.pathname + url.search, token: request.headers['x-httpgd-token'] as string | undefined });
            if (request.headers['x-httpgd-token'] !== 'secret') { response.writeHead(401); response.end(); return; }
            response.setHeader('Content-Type', 'application/json');
            if (url.pathname === '/state') { response.end(JSON.stringify(remote)); }
            else if (url.pathname === '/plots') {
                if (holdPlots) { held.push(response); }
                else { response.end(JSON.stringify(invalidPlots ? {} : { state: remote, plots: ids.map(id => ({ id })) })); }
            } else if (url.pathname === '/renderers') {
                response.end(JSON.stringify({ renderers: [{ id: 'svgp', name: 'SVG', ext: '.svg', descr: 'SVG plot' }] }));
            } else if (url.pathname === '/plot') {
                response.end(url.searchParams.get('renderer') === 'svgp' ? '<svg>日本語</svg>' : binary);
            } else if (url.pathname === '/remove') {
                ids = ids.filter(id => id !== url.searchParams.get('id'));
                remote = { ...remote, upid: remote.upid + 1, hsize: ids.length };
                response.end(JSON.stringify(remote));
            } else { response.writeHead(404); response.end(); }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        client = new HttpgdClient(origin, 'secret', { pollIntervalMs: 20, retryIntervalMs: 80, webSocketTimeoutMs: 60 });
        client.onPlotsChanged(value => notifications.push(value.plots.map(plot => plot.id)));
    });
    teardown(async () => {
        client.disconnect();
        upgradedSocket?.destroy();
        if (websocketDescriptor) { Object.defineProperty(globalThis, 'WebSocket', websocketDescriptor); }
        else { Reflect.deleteProperty(globalThis, 'WebSocket'); }
        for (const response of held) { response.destroy(); }
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    test('loads the initial snapshot, SVG, binary exports and renderers with authentication', async () => {
        await client.connect();
        assert.deepStrictEqual(client.getPlots(), [{ id: '1' }]);
        assert.strictEqual(client.getRenderers()[0].id, 'svgp');
        assert.strictEqual(await client.getPlotText({ id: '1', renderer: 'svgp', width: 10.6, height: 20.4, zoom: 2 }), '<svg>日本語</svg>');
        assert.deepStrictEqual(await client.getPlotBytes({ id: '1', renderer: 'png' }), binary);
        assert.ok(requests.some(request => request.path === '/plot?id=1&renderer=svgp&width=11&height=20&zoom=2'));
        assert.ok(requests.every(request => request.token === 'secret'));
        await client.removePlot({ id: '1' });
        assert.deepStrictEqual(client.getPlots(), []);
        assert.deepStrictEqual(notifications, [['1'], []]);
    });
    test('polls a server on port 10080, including when native WebSocket rejects it', async () => {
        if (typeof nativeWebSocket === 'function') { globalThis.WebSocket = nativeWebSocket; }
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(10080, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
        });
        origin = 'http://127.0.0.1:10080';
        client = new HttpgdClient(origin, 'secret', { pollIntervalMs: 20, retryIntervalMs: 80, webSocketTimeoutMs: 60 });
        await client.connect();
        ids = ['2']; remote = { ...remote, upid: 2 };
        await until(() => client.getPlots()[0]?.id === '2');
        assert.deepStrictEqual(await client.getPlotBytes({ id: '2', renderer: 'png' }), binary);
    });
    test('polls without WebSocket and only fetches plots after a state change', async () => {
        await client.connect();
        await until(() => requests.filter(request => request.path === '/state').length >= 2);
        assert.strictEqual(requests.filter(request => request.path === '/plots').length, 1);
        ids = ['1', '2']; remote = { ...remote, upid: 2, hsize: 2 };
        await until(() => client.getPlots().length === 2);
        assert.deepStrictEqual(notifications, [['1'], ['1', '2']]);
    });
    test('uses native WebSocket notifications and falls back after a disconnect', async () => {
        globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
        await client.connect();
        const socket = TestWebSocket.instances[0];
        assert.strictEqual(socket.url.protocol, 'ws:');
        assert.strictEqual(socket.url.searchParams.get('token'), 'secret');
        socket.open();
        await until(() => requests.filter(request => request.path === '/plots').length === 2);
        ids = ['2']; remote = { ...remote, upid: 2 };
        socket.message(remote);
        await until(() => client.getPlots()[0]?.id === '2');
        socket.close();
        ids = ['3']; remote = { ...remote, upid: 3 };
        await until(() => client.getPlots()[0]?.id === '3');
        await until(() => TestWebSocket.instances.length === 2);
        TestWebSocket.instances[1].open();
        await until(() => requests.filter(request => request.path === '/plots').length >= 5);
    });
    test('receives notifications through an actual native WebSocket connection', async function () {
        if (typeof nativeWebSocket !== 'function') { this.skip(); }
        globalThis.WebSocket = nativeWebSocket;
        server.on('upgrade', (request, socket) => {
            assert.strictEqual(new URL(request.url ?? '/', origin).searchParams.get('token'), 'secret');
            const key = request.headers['sec-websocket-key'];
            assert.strictEqual(typeof key, 'string');
            const accept = createHash('sha1').update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
            upgradedSocket = socket;
        });
        await client.connect();
        await until(() => notifications.length === 2);
        ids = ['2']; remote = { ...remote, upid: 2 };
        const message = Buffer.from(JSON.stringify(remote));
        // The fixture's state JSON is a short, unmasked server text frame.
        assert.ok(message.length < 126);
        assert.ok(upgradedSocket);
        upgradedSocket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
        await until(() => client.getPlots()[0]?.id === '2');
    });
    test('falls back when WebSocket cannot open', async () => {
        globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
        await client.connect();
        await until(() => TestWebSocket.instances[0].readyState === 3);
        ids = ['2']; remote = { ...remote, upid: 2 };
        await until(() => client.getPlots()[0]?.id === '2');
    });
    test('serializes plot refreshes and retains updates received during a request', async () => {
        globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
        await client.connect();
        const socket = TestWebSocket.instances[0];
        socket.open();
        await until(() => requests.filter(request => request.path === '/plots').length === 2);
        holdPlots = true;
        remote = { ...remote, upid: 2 }; socket.message(remote);
        await until(() => held.length === 1);
        const stale = { state: remote, plots: [{ id: '2' }] };
        ids = ['3']; remote = { ...remote, upid: 3 }; socket.message(remote);
        assert.strictEqual(held.length, 1);
        holdPlots = false;
        held[0].end(JSON.stringify(stale));
        await until(() => client.getPlots()[0]?.id === '3');
    });
    test('aborts pending requests and stops notifications and timers on disconnect', async () => {
        await client.connect();
        holdPlots = true;
        remote = { ...remote, upid: 2 };
        await until(() => held.length === 1);
        client.disconnect();
        const count = requests.length;
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(requests.length, count);
        assert.deepStrictEqual(notifications, [['1']]);
        await assert.rejects(client.getPlotBytes({ id: '1' }), /disconnected/);
    });
    test('rejects malformed protocol responses and recovers on polling', async () => {
        invalidPlots = true;
        await assert.rejects(client.connect(), /Invalid httpgd plots/);
        invalidPlots = false;
        await until(() => client.getPlots().length === 1);
    });
});
