import * as assert from 'assert';
import * as path from 'path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { JgdManager } from '../../plotViewer/jgdViewer';
import { HttpgdClient } from '../../plotViewer/httpgdClient';
import { extensionContext } from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { waitForValue } from '../common/sessionConnections';

const createRealWebviewPanel = vscode.window.createWebviewPanel;

suite('Standalone plot restoration', () => {
    let sandbox: sinon.SinonSandbox;
    let state: Map<string, unknown>;
    let secrets: Map<string, string>;
    let managers: CommonPlotManager[];
    let connect: sinon.SinonStub;
    let callbacks: Map<string, (...args: unknown[]) => Promise<void>>;
    let panels: Array<{
        panel: vscode.WebviewPanel;
        receive: (message: unknown) => Promise<void>;
        post: sinon.SinonStub;
    }>;

    setup(() => {
        sandbox = sinon.createSandbox();
        state = new Map();
        secrets = new Map();
        managers = [];
        callbacks = new Map();
        panels = [];
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        (extensionContext.workspaceState.get as sinon.SinonStub).callsFake(
            (key: string, fallback?: unknown) => state.get(key) ?? fallback,
        );
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            (key: string, value: unknown) => {
                state.set(key, structuredClone(value));
                return Promise.resolve();
            },
        );
        (extensionContext.secrets.get as sinon.SinonStub).callsFake((key: string) =>
            Promise.resolve(secrets.get(key)),
        );
        (extensionContext.secrets.store as sinon.SinonStub).callsFake(
            (key: string, value: string) => {
                secrets.set(key, value);
                return Promise.resolve();
            },
        );
        sandbox.stub(vscode.commands, 'registerCommand').callsFake((command, callback) => {
            callbacks.set(command, callback as (...args: unknown[]) => Promise<void>);
            return new vscode.Disposable(() => {});
        });
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(JgdManager.prototype, 'start');
        connect = sandbox.stub(HttpgdClient.prototype, 'connect').resolves();
        sandbox.stub(util, 'config').returns({
            get: (_key: string, fallback: unknown) => fallback,
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((viewType, title) => {
            const disposed = new vscode.EventEmitter<void>();
            let receive = (_message: unknown): unknown => undefined;
            const post = sandbox.stub().resolves(true);
            const panel = {
                title,
                viewType,
                active: true,
                reveal: sandbox.stub(),
                webview: {
                    html: '',
                    postMessage: post,
                    asWebviewUri: (uri: vscode.Uri) =>
                        uri.with({
                            scheme: 'https',
                            authority: `panel${panels.length}.vscode-resource.vscode-cdn.net`,
                        }),
                    onDidReceiveMessage: (callback: typeof receive) => {
                        receive = callback;
                        return new vscode.Disposable(() => {});
                    },
                },
                onDidDispose: disposed.event,
                onDidChangeViewState: () => new vscode.Disposable(() => {}),
                dispose: () => disposed.fire(),
            } as unknown as vscode.WebviewPanel;
            panels.push({
                panel,
                post,
                receive: async (message) => {
                    await receive(message);
                },
            });
            return panel;
        });
    });

    teardown(async () => {
        for (const manager of managers) {
            await manager.dispose();
        }
        sandbox.restore();
    });

    function manager(): CommonPlotManager {
        const value = new CommonPlotManager();
        value.initialize();
        managers.push(value);
        return value;
    }

    test('Show Viewers requests the standard plot from its original attached session after reload', async () => {
        const first = manager();
        const owner = {
            sessionId: 'a',
            host: 'host',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        } as session.Session;
        const request = sandbox
            .stub(session, 'sessionRequest')
            .resolves({ data: 'original', format: 'svg' });
        const resolve = sandbox.stub(session, 'resolvePlotSession').returns(owner);
        await first.showStandardPlot(owner);
        await panels[0].receive({ type: 'ready' });
        await first.dispose();
        assert.ok(
            !JSON.stringify([...state.values()]).includes('original'),
            'standard images are not persisted',
        );
        panels = [];
        request.resetHistory();
        request.resolves({ data: 'fresh-from-R', format: 'svg' });
        manager();
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(resolve);
        await panels[0].receive({ type: 'ready' });
        assert.strictEqual(request.lastCall.args[1], owner);
        sinon.assert.calledWith(panels[0].post, {
            type: 'update',
            data: 'fresh-from-R',
            format: 'svg',
        });
    });

    test('standard restoration waits for the owning session instead of showing an archived image', async () => {
        const first = manager();
        const owner = {
            sessionId: 'a',
            host: 'host',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        } as session.Session;
        sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
        const resolve = sandbox.stub(session, 'resolvePlotSession').returns(undefined);
        const information = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
        await first.showStandardPlot(owner);
        await panels[0].receive({ type: 'ready' });
        await first.dispose();
        panels = [];
        manager();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 0);
        sinon.assert.calledOnce(information);
        resolve.returns(owner);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
    });

    test('httpgd reconnects with its token and retains live rendering and removal after reload', async () => {
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=secret');
        first.httpgdManager.viewers[0].plots = [
            { id: '1', data: '<svg>not persisted</svg>', width: 400, height: 300, zoom: 1 },
        ];
        await first.dispose();
        assert.ok(!JSON.stringify([...state.values()]).includes('secret'));
        assert.ok(!JSON.stringify([...secrets.values()]).includes('<svg>'));
        panels = [];
        connect.resetHistory();
        const restored = manager();
        sinon.assert.notCalled(connect);
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
        const viewer = restored.httpgdManager.viewers[0];
        assert.strictEqual(viewer.token, 'secret');
        assert.deepStrictEqual(viewer.plots, []);
        viewer.plots = [{ id: 'live', data: '<svg/>', width: 1, height: 1, zoom: 1 }];
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>fresh</svg>');
        sandbox.stub(viewer.api, 'getPlots').returns([{ id: 'live' }]);
        await viewer.focusPlot('live');
        sinon.assert.called(render);
        const remove = sandbox.stub(viewer.api, 'removePlot').resolves();
        await viewer.closePlot('live');
        sinon.assert.calledWithExactly(remove, { id: 'live' });
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
    });

    test('httpgd reload fetches fresh plots from an authenticated server', async () => {
        connect.callThrough();
        let revision = 1;
        let removed = false;
        const requests: string[] = [];
        const server = http.createServer((request, response) => {
            if (request.headers['x-httpgd-token'] !== 'device-token') {
                response.writeHead(401).end();
                return;
            }
            const route = new URL(request.url!, 'http://localhost').pathname;
            requests.push(route);
            const state = { upid: revision, hsize: removed ? 0 : 1, active: true };
            switch (route) {
                case '/renderers':
                    response.end(
                        JSON.stringify({
                            renderers: [{ id: 'svgp', name: 'SVG', ext: 'svg', descr: 'SVG' }],
                        }),
                    );
                    break;
                case '/plots':
                    response.end(JSON.stringify({ state, plots: removed ? [] : [{ id: '1' }] }));
                    break;
                case '/plot':
                    response.end(`<svg><text>revision ${revision}</text></svg>`);
                    break;
                case '/remove':
                    removed = true;
                    response.end(JSON.stringify({ ...state, hsize: 0 }));
                    break;
                default:
                    response.end(JSON.stringify(state));
            }
        });
        server.on('upgrade', (_request, socket) => socket.destroy());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        let restored: CommonPlotManager | undefined;
        try {
            const first = manager();
            const address = server.address() as AddressInfo;
            await first.showHttpgdPlot(`http://127.0.0.1:${address.port}/live?token=device-token`);
            await waitForValue(() =>
                first.httpgdManager.viewers[0].plots.length ? true : undefined,
            );
            await first.dispose();
            revision = 2;
            requests.length = 0;
            restored = manager();
            await callbacks.get('r.plot.showViewers')!();
            const viewer = restored.httpgdManager.viewers[0];
            await waitForValue(() =>
                viewer.plots[0]?.data.includes('revision 2') ? true : undefined,
            );
            assert.ok(requests.includes('/renderers'));
            assert.ok(requests.includes('/plots'));
            assert.ok(requests.includes('/plot'));
            assert.ok(
                (await viewer.api.getPlotBytes({ id: '1', renderer: 'svgp' }))
                    .toString()
                    .includes('revision 2'),
            );
            await viewer.closePlot('1');
            assert.strictEqual(removed, true);
        } finally {
            await restored?.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('httpgd restoration does not replace a device that already attached with a new token', async () => {
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old');
        await first.dispose();
        const restored = manager();
        await restored.showHttpgdPlot('http://localhost:1234/live?token=new');
        const live = restored.httpgdManager.viewers[0];
        await callbacks.get('r.plot.showViewers')!();
        assert.deepStrictEqual(restored.httpgdManager.viewers, [live]);
        assert.strictEqual(live.token, 'new');
    });

    test('a real JGD webview receives and exports restored frames after its ready handshake', async () => {
        const first = manager();
        first.jgdManager.history.addPlot('old-device', {
            version: 1,
            sessionId: 'old-device',
            device: { width: 400, height: 300, dpi: 96, bg: 'magenta' },
            ops: [],
        });
        await first.dispose();
        let panel: vscode.WebviewPanel | undefined;
        let resolveReady!: () => void;
        let resolveExport!: (data: string) => void;
        const ready = new Promise<void>((resolve) => {
            resolveReady = resolve;
        });
        const exported = new Promise<string>((resolve) => {
            resolveExport = resolve;
        });
        (vscode.window.createWebviewPanel as sinon.SinonStub).callsFake(
            (...args: Parameters<typeof createRealWebviewPanel>) => {
                panel = createRealWebviewPanel(...args);
                panel.webview.onDidReceiveMessage((message: { type: string; data?: string }) => {
                    if (message.type === 'ready') {
                        resolveReady();
                    }
                    if (message.type === 'export_data' && message.data) {
                        resolveExport(message.data);
                    }
                });
                return panel;
            },
        );
        sandbox.stub(vscode.window, 'showSaveDialog').resolves(undefined);
        manager();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('Restored webview did not render/export')),
                15000,
            );
        });
        try {
            await callbacks.get('r.plot.showViewers')!();
            await Promise.race([ready, timeout]);
            await panel!.webview.postMessage({
                type: 'export',
                format: 'svg',
                width: 400,
                height: 300,
            });
            const svg = Buffer.from(await Promise.race([exported, timeout]), 'base64').toString(
                'utf8',
            );
            assert.ok(svg.includes('<svg'));
            assert.ok(svg.includes('magenta'), 'export must contain the restored plot');
        } finally {
            clearTimeout(timer);
            panel?.dispose();
        }
    });

    test('shutdown during credential loading does not reopen a connection or panel', async () => {
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=secret');
        await first.dispose();
        const value = [...secrets.values()][0];
        let finishRead!: (value: string) => void;
        (extensionContext.secrets.get as sinon.SinonStub).returns(
            new Promise<string>((resolve) => {
                finishRead = resolve;
            }),
        );
        connect.resetHistory();
        panels = [];
        const restored = manager();
        const showing = callbacks.get('r.plot.showViewers')!();
        const stopping = restored.dispose();
        finishRead(value);
        await Promise.all([showing, stopping]);
        sinon.assert.notCalled(connect);
        assert.strictEqual(panels.length, 0);
    });
});
