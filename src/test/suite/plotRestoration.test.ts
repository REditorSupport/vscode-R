import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { JgdManager } from '../../plotViewer/jgdViewer';
import type { JgdMessage } from '../../plotViewer/jgdSocketServer';
import type { PlotFrame } from '../../plotViewer/jgdPlotHistory';
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
            const panelId = panels.length;
            const disposed = new vscode.EventEmitter<void>();
            const listeners = new Set<(message: unknown) => unknown>();
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
                            authority: `panel${panelId}.vscode-resource.vscode-cdn.net`,
                        }),
                    onDidReceiveMessage: (callback: (message: unknown) => unknown) => {
                        listeners.add(callback);
                        return new vscode.Disposable(() => {
                            listeners.delete(callback);
                        });
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
                    await Promise.all([...listeners].map((listener) => listener(message)));
                },
            });
            return panel;
        });
    });

    teardown(async () => {
        for (const manager of managers) {
            await manager.dispose();
        }
        for (const { panel } of panels) {
            panel.dispose();
        }
        sandbox.restore();
    });

    function manager(): CommonPlotManager {
        const value = new CommonPlotManager();
        value.initialize();
        managers.push(value);
        return value;
    }

    function owner(id: string, pid: string): session.Session {
        return {
            sessionId: id,
            host: 'external-host',
            pid,
            rVer: 'R version 4.6.0 (2026-04-24)',
            processExited: false,
        } as session.Session;
    }

    test('all plot backends show the exact shared session indicator and retain it after reload', async () => {
        const a = owner('indicator-a', '12101');
        const b = owner('indicator-b', '12102');
        sandbox.stub(session, 'activeSession').value(b);
        sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
        sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => (source.sessionId === a.sessionId ? a : b));
        const first = manager();
        for (const [index, source] of [a, b].entries()) {
            await first.showStandardPlot(source);
            await first.showHttpgdPlot(
                `http://localhost:${1234 + index}/live?token=secret`,
                source,
            );
            first.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
            first.jgdManager.history.setSessionSource(source.sessionId, source);
        }
        async function checkIndicators() {
            await callbacks.get('r.plot.showViewers')!();
            assert.strictEqual(panels.length, 6);
            for (const source of [a, b]) {
                const label = `R 4.6.0: ${source.pid}`;
                const owned = panels.filter(({ panel }) =>
                    panel.webview.html.includes(`aria-label="${label}"`),
                );
                assert.strictEqual(owned.length, 3, 'each backend has its own session indicator');
                for (const item of owned) {
                    assert.strictEqual(item.panel.title, 'R Plot');
                    assert.ok(item.panel.webview.html.includes('class="viewer-session-tooltip"'));
                    assert.ok(item.panel.webview.html.includes('codicon.css'));
                    item.post.resetHistory();
                    await item.receive({ message: 'viewer-session/ready' });
                    sinon.assert.calledWithExactly(item.post, {
                        message: 'viewer-session/update',
                        text: label,
                    });
                }
            }
        }
        await checkIndicators();
        for (const { panel } of panels) {
            panel.dispose();
        }
        await first.dispose();
        panels = [];
        manager();
        await checkIndicators();
    });

    test('JGD binds live devices including late R attachments, but never guesses a restored owner', async () => {
        const events = new vscode.EventEmitter<import('../../api').RSessionConnectionChange>();
        sandbox.stub(session, 'onDidChangeSessionConnection').callsFake(events.event);
        const a = owner('jgd-owner-a', '12111');
        const b = owner('jgd-owner-b', '12112');
        const resolve = sandbox.stub(session, 'resolveJgdSessionSource');
        resolve.withArgs('r-12111-1').returns(a);
        const value = manager();
        const live = sandbox
            .stub(value.jgdManager.server, 'isConnected')
            .callsFake((id) => id !== 'restored');
        const deliver = startJgd(value);
        for (const [id, label] of [
            ['a', 'r-12111-1'],
            ['b', 'r-12112-1'],
            ['restored', 'r-12113-1'],
        ]) {
            value.jgdManager.history.addPlot(id, frame(id));
            value.jgdManager.history.setSessionLabel(id, label);
            deliver(id, { type: 'frame' });
        }
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 12111'));
        assert.ok(!panels[1].panel.webview.html.includes('class="viewer-session"'));
        resolve.withArgs('r-12112-1').returns(b);
        events.fire({
            kind: 'connected',
            session: { sessionId: b.sessionId, connectionId: 'late' },
        });
        assert.ok(panels[1].panel.webview.html.includes('R 4.6.0: 12112'));
        sinon.assert.neverCalledWith(resolve, 'r-12113-1');
        assert.strictEqual(value.jgdManager.history.sessionSource('b')?.sessionId, b.sessionId);
        live.returns(false);
        value.jgdManager.getViewer('a')!.updateToolbar();
        await panels[0].receive({ message: 'viewer-session/ready' });
        sinon.assert.calledWith(panels[0].post, {
            message: 'viewer-session/update',
            text: 'R 4.6.0: 12111',
        });
        events.dispose();
    });

    test('plot indicators update on owning process exit and release observations on tab close', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const kill = sandbox.stub(process, 'kill').returns(true);
        const source = owner('plot-exit', '12120');
        source.host = os.hostname();
        const value = manager();
        await value.showStandardPlot(source);
        await value.showHttpgdPlot('http://localhost:1234', source);
        value.jgdManager.history.addPlot('device', frame('device'));
        value.jgdManager.history.setSessionSource('device', source);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 3);
        kill.callsFake(() => {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        });
        await clock.tickAsync(1000);
        for (const { panel, post } of panels) {
            sinon.assert.calledWith(post, {
                message: 'viewer-session/update',
                text: 'R: (not attached)',
            });
            panel.dispose();
        }
        kill.resetHistory();
        await clock.tickAsync(2000);
        sinon.assert.notCalled(kill);
    });

    test('httpgd gains the session indicator when an existing URL is attached to R', async () => {
        const value = manager();
        await value.showHttpgdPlot('http://localhost:1234');
        await callbacks.get('r.plot.showViewers')!();
        assert.ok(!panels[0].panel.webview.html.includes('class="viewer-session"'));
        await value.showHttpgdPlot('http://localhost:1234', owner('late-httpgd', '12130'));
        assert.strictEqual(panels.length, 1);
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 12130'));
        await panels[0].receive({ message: 'viewer-session/ready' });
        sinon.assert.calledWith(panels[0].post, {
            message: 'viewer-session/update',
            text: 'R 4.6.0: 12130',
        });
    });

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
        request.resetHistory();
        resolve.resetHistory();
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.notCalled(request);
        sinon.assert.calledOnce(resolve);
        assert.strictEqual(panels.length, 1);
        const reattached = {
            sessionId: owner.sessionId,
            host: owner.host,
            pid: owner.pid,
            rVer: owner.rVer,
            processExited: false,
        } as session.Session;
        resolve.returns(reattached);
        panels[0].panel.dispose();
        await callbacks.get('r.plot.showViewers')!();
        await panels[1].receive({ type: 'ready' });
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.lastCall.args[1], reattached);
    });

    function startJgd(value: CommonPlotManager) {
        (JgdManager.prototype.start as sinon.SinonStub).callThrough();
        sandbox.stub(value.jgdManager.server, 'start');
        const onFrame = sandbox.stub(value.jgdManager.server, 'setOnFrame');
        value.jgdManager.start();
        return onFrame.firstCall.args[0] as (id: string, message: JgdMessage) => void;
    }

    function frame(sessionId: string, bg = 'white'): PlotFrame {
        return {
            version: 1,
            sessionId,
            device: { width: 400, height: 300, dpi: 96, bg },
            ops: [],
        };
    }

    test('JGD frames update only their own viewer without redundant toolbar messages', async () => {
        const value = manager();
        const deliver = startJgd(value);
        const history = value.jgdManager.history;
        history.addPlot('a', frame('a'));
        history.setSessionLabel('a', 'r-123-1');
        deliver('a', { type: 'frame' });
        await panels[0].receive({ type: 'ready' });
        const post = panels[0].post;
        post.resetHistory();
        for (let index = 0; index < 100; index++) {
            history.addPlot('b', frame('b'));
            deliver('b', { type: 'frame' });
        }
        sinon.assert.notCalled(post);
        assert.strictEqual(panels.length, 2);
        history.setSessionLabel('b', 'r-456-1');
        await panels[1].receive({ type: 'ready' });
        assert.strictEqual(panels[0].panel.title, 'R Plot');
        assert.strictEqual(panels[1].panel.title, 'R Plot');
        assert.ok(!panels[0].panel.webview.html.includes('session-select'));
        panels[1].post.resetHistory();

        for (let index = 0; index < 100; index++) {
            history.appendOps('a', { ...frame('a'), ops: [{ op: 'line', index }] });
            deliver('a', { type: 'frame' });
        }
        assert.strictEqual(post.withArgs(sinon.match({ type: 'render' })).callCount, 100);
        sinon.assert.notCalled(post.withArgs(sinon.match({ type: 'toolbar' })));
        sinon.assert.notCalled(panels[1].post);
        assert.strictEqual(history.currentPlot('a')?.ops.length, 100);
        await panels[0].receive({ type: 'ready' });
        sinon.assert.calledOnce(post.withArgs(sinon.match({ type: 'toolbar' })));
    });

    test('JGD tabs independently navigate, resize, measure text, remove plots and reopen', async () => {
        const value = manager();
        const metrics = sandbox.spy(value.jgdManager.server, 'setMeasureText');
        const dimensions = sandbox.spy(value.jgdManager.server, 'setGetDimensions');
        const deliver = startJgd(value);
        const resize = sandbox.stub(value.jgdManager.server, 'handleResize');
        const history = value.jgdManager.history;
        for (const id of ['a', 'b']) {
            history.addPlot(id, frame(id, `${id}1`));
            history.addPlot(id, frame(id, `${id}2`));
            deliver(id, { type: 'frame' });
            await panels.at(-1)!.receive({ type: 'ready' });
        }
        const a = value.jgdManager.getViewer('a')!;
        const b = value.jgdManager.getViewer('b')!;
        assert.notStrictEqual(a.id, b.id);
        Object.assign(panels[0].panel, { active: false });
        assert.strictEqual(value.activeViewer, b);
        await callbacks.get('r.plot.prevPlot')!(
            vscode.Uri.from({ scheme: 'webview', path: a.getPanelPath()! }),
        );
        assert.strictEqual(history.currentIndex('a'), 1);
        assert.strictEqual(history.currentIndex('b'), 2);
        sinon.assert.calledWithExactly(resize, 800, 600, 'a');
        await panels[0].receive({ type: 'resize', width: 700, height: 500 });
        await panels[1].receive({ type: 'resize', width: 900, height: 650 });
        sinon.assert.calledWithExactly(resize, 700, 500, 'a');
        sinon.assert.calledWithExactly(resize, 900, 650, 'b');
        const getDimensions = dimensions.firstCall.args[0];
        assert.deepStrictEqual(getDimensions('a'), { width: 700, height: 500 });
        assert.deepStrictEqual(getDimensions('b'), { width: 900, height: 650 });
        const measure = metrics.firstCall.args[0];
        panels[0].post.resetHistory();
        panels[1].post.resetHistory();
        const measured = measure(
            { type: 'metrics_request', id: 7, kind: 'strWidth', str: 'x' },
            96,
            'a',
        );
        const request = panels[0].post.lastCall.args[0] as { id: number };
        sinon.assert.notCalled(panels[1].post);
        await panels[0].receive({
            type: 'metrics_response',
            id: request.id,
            originalId: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        assert.deepStrictEqual(await measured, {
            type: 'metrics_response',
            id: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        await panels[0].receive({ type: 'deleteCurrent' });
        assert.strictEqual(history.count('a'), 1);
        assert.strictEqual(history.count('b'), 2);
        await b.handleCommand('resetPlots');
        assert.strictEqual(history.count('a'), 1);
        assert.strictEqual(history.count('b'), 0);
        panels[0].panel.dispose();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 3, 'only the closed tab is recreated');
        await panels[2].receive({ type: 'ready' });
        sinon.assert.calledWith(
            panels[2].post,
            sinon.match({ type: 'render', plot: sinon.match({ sessionId: 'a' }) }),
        );
    });

    test('JGD restores separate tabs with each session history position after reload', async () => {
        const first = manager();
        const history = first.jgdManager.history;
        history.addPlot('a', frame('a', 'a1'));
        history.addPlot('a', frame('a', 'a2'));
        history.addPlot('b', frame('b', 'b1'));
        history.addPlot('b', frame('b', 'b2'));
        history.navigatePrevious('a');
        await first.dispose();
        const restored = manager();
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 2);
        for (const [index, id, bg] of [
            [0, 'a', 'a1'],
            [1, 'b', 'b2'],
        ] as const) {
            await panels[index].receive({ type: 'ready' });
            sinon.assert.calledWith(
                panels[index].post,
                sinon.match({
                    type: 'render',
                    plot: sinon.match({ sessionId: id, device: sinon.match({ bg }) }),
                }),
            );
            assert.strictEqual(panels[index].panel.title, 'R Plot');
        }
        await restored.jgdManager.getViewer('b')!.handleCommand('firstPlot');
        assert.strictEqual(restored.jgdManager.history.currentIndex('a'), 1);
        assert.strictEqual(restored.jgdManager.history.currentIndex('b'), 1);
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

    test('httpgd restoration keeps credentials from an attachment arriving at its async boundary', async () => {
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old');
        await first.dispose();
        const restored = manager();
        const show = restored.httpgdManager.showViewer.bind(restored.httpgdManager);
        sandbox
            .stub(restored.httpgdManager, 'showViewer')
            .callsFake((url, source, onlyIfMissing) => {
                if (new URL(url).searchParams.get('token') === 'old') {
                    void show('http://localhost:1234/live?token=new');
                }
                return show(url, source, onlyIfMissing);
            });
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(restored.httpgdManager.viewers.length, 1);
        assert.strictEqual(restored.httpgdManager.viewers[0].token, 'new');
    });

    test('a real JGD webview receives and exports restored frames after its ready handshake', async () => {
        const first = manager();
        first.jgdManager.history.addPlot('old-device', {
            version: 1,
            sessionId: 'old-device',
            device: { width: 400, height: 300, dpi: 96, bg: 'magenta' },
            ops: [],
        });
        first.jgdManager.history.setSessionSource(
            'old-device',
            owner('jgd-real-indicator', '12140'),
        );
        await first.dispose();
        let panel: vscode.WebviewPanel | undefined;
        let resolveIndicator!: (message: { label: string; fontLoaded: boolean }) => void;
        const indicator = new Promise<{ label: string; fontLoaded: boolean }>((resolve) => {
            resolveIndicator = resolve;
        });
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
                panel.webview.onDidReceiveMessage(
                    (message: {
                        type: string;
                        data?: string;
                        label: string;
                        fontLoaded: boolean;
                    }) => {
                        if (message.type === 'indicator-check') {
                            resolveIndicator(message);
                        }
                        if (message.type === 'ready') {
                            resolveReady();
                        }
                        if (message.type === 'export_data' && message.data) {
                            resolveExport(message.data);
                        }
                    },
                );
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
            panel!.webview.html = panel!.webview.html.replace(
                '</body>',
                `<script>
                window.addEventListener('load', async () => {
                    await document.fonts.ready;
                    vscode.postMessage({ type: 'indicator-check', label: document.querySelector('.viewer-session').getAttribute('aria-label'), fontLoaded: document.fonts.check('16px codicon') });
                });
            </script></body>`,
            );
            await Promise.race([ready, timeout]);
            const details = await Promise.race([indicator, timeout]);
            assert.strictEqual(details.label, 'R 4.6.0: 12140');
            assert.strictEqual(
                details.fontLoaded,
                true,
                'the shared information icon font loads under the JGD CSP',
            );
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
