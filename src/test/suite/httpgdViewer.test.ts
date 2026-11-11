import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { HttpgdClient } from '../../plotViewer/httpgdClient';
import { HttpgdManager, HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { mockExtensionContext } from '../common/mockvscode';
import * as util from '../../util';
import * as session from '../../session';
import type { ViewerSessionContext } from '../../viewerSession';
import type { RSessionConnectionChange } from '../../api';

class LifecycleViewer extends HttpgdViewer {
    resizeTo(width: number, height: number): void {
        this.handleResize(height, width);
    }
    resizeNow(): void {
        this.handleResize(600, 900, true);
    }
    queueResize(): void {
        this.handleResize(600, 900);
    }
    queueRefresh(): Promise<void> {
        return this.refreshPlotsDelayed([{ id: '1' }]);
    }
}

class TestViewer extends HttpgdViewer {
    renderCount = 0;
    resize(height: number, width: number): void {
        this.handleResize(height, width);
    }
    protected override resizePlot(): Promise<void> {
        this.renderCount++;
        return Promise.resolve();
    }
    protected override refreshPlots(): Promise<void> {
        this.renderCount++;
        return Promise.resolve();
    }
}

suite('httpgd viewer requests', () => {
    let sandbox: sinon.SinonSandbox;
    let manager: HttpgdManager;
    let connect: sinon.SinonStub;
    const extensionRoot = path.resolve(__dirname, '../../..');
    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extensionRoot, sandbox);
        connect = sandbox.stub(HttpgdClient.prototype, 'connect').resolves();
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(util, 'config').returns({
            get: (_key: string, fallback: unknown) => fallback,
        } as vscode.WorkspaceConfiguration);
        manager = new HttpgdManager();
    });
    teardown(async () => {
        try {
            manager.dispose();
            await manager.saveConnections();
        } finally {
            sandbox.restore();
        }
    });

    test('focusing a correctly sized non-square plot does not request another render', async () => {
        const viewer = new TestViewer('localhost:1234', manager.viewerOptions);
        manager.registerViewer(viewer);
        viewer.plots = [{ id: '1', data: '<svg/>', width: 800, height: 600, zoom: 1 }];
        await viewer.focusPlot('1');
        assert.strictEqual(viewer.renderCount, 0);
        viewer.viewWidth = 900;
        await viewer.focusPlot('1');
        assert.strictEqual(viewer.renderCount, 1);
    });

    test('resizing uses its configured interval independently of plot refresh', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const viewer = new TestViewer('localhost:1234', {
            ...manager.viewerOptions,
            refreshTimeoutLength: 10,
            resizeTimeoutLength: 100,
        });
        manager.registerViewer(viewer);
        viewer.resize(600, 900);
        await clock.tickAsync(10);
        assert.strictEqual(viewer.renderCount, 0);
        await clock.tickAsync(90);
        assert.strictEqual(viewer.renderCount, 1);
    });

    test('HTTPS URLs stay HTTPS when opening the live viewer', async () => {
        await manager.showViewer('https://plots.example:8443/live?token=secret%26value');
        const open = sandbox.stub(vscode.env, 'openExternal').resolves(true);
        manager.viewers[0].openExternal();
        assert.strictEqual(
            open.firstCall.args[0].toString(true),
            'https://plots.example:8443/live?token=secret%26value',
        );
        assert.strictEqual(manager.viewers[0].origin, 'https://plots.example:8443');
    });

    test('a changed device token replaces the connection at the same origin', async () => {
        await manager.showViewer('http://localhost:1234/live?token=first');
        const old = manager.viewers[0];
        const show = sandbox.stub(old, 'show');
        await manager.showViewer('http://localhost:1234/live?token=first');
        sinon.assert.calledOnce(show);
        const disconnect = sandbox.spy(old.api, 'disconnect');
        await manager.showViewer('http://localhost:1234/live?token=second');
        sinon.assert.calledOnce(disconnect);
        assert.strictEqual(manager.viewers.length, 1);
        assert.notStrictEqual(manager.viewers[0], old);
        assert.strictEqual(manager.viewers[0].token, 'second');
    });

    for (const token of ['', '?token=fixed']) {
        for (const exited of [false, true]) {
            test(`a replacement session gets a new httpgd client (${token || 'no token'}, exited=${exited})`, async () => {
                const source = {
                    sessionId: 'original',
                    host: 'remote',
                    pid: '123',
                    rVer: '4.6.0',
                    processExited: false,
                };
                const url = `http://localhost:1234/live${token}`;
                await manager.showViewer(url, source);
                const old = manager.viewers[0];
                const disconnect = sandbox.spy(old.api, 'disconnect');
                const closePanel = sandbox.stub();
                old.webviewPanel = { dispose: closePanel } as unknown as vscode.WebviewPanel;
                manager.registerActiveViewer(old);
                if (exited) {
                    old.dispose();
                }
                const replacement = { ...source, sessionId: 'replacement', pid: '456' };
                await manager.showViewer(url, replacement);
                assert.strictEqual(manager.viewers.length, 1);
                assert.notStrictEqual(manager.viewers[0], old);
                assert.deepStrictEqual(manager.viewers[0].connection.source, replacement);
                assert.strictEqual(manager.viewers[0].isDisposed, false);
                assert.strictEqual(manager.recentlyActiveViewers.includes(old), false);
                sinon.assert.calledOnce(disconnect);
                sinon.assert.calledOnce(closePanel);
                sinon.assert.calledTwice(connect);
                old.webviewPanel = undefined;
            });
        }
    }

    test('a disposed httpgd client is replaced even when ownership and credentials match', async () => {
        const source = {
            sessionId: 'owner',
            host: 'remote',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        };
        const url = 'http://localhost:1234/live?token=fixed';
        await manager.showViewer(url, source);
        const old = manager.viewers[0];
        const show = sandbox.stub(old, 'show');
        await manager.showViewer(url, { ...source });
        assert.strictEqual(manager.viewers[0], old, 'same live process still reuses its viewer');
        sinon.assert.calledOnce(show);
        old.dispose();
        await manager.showViewer(url, source);
        assert.notStrictEqual(manager.viewers[0], old);
        sinon.assert.calledTwice(connect);
    });

    function lifetime() {
        const source = {
            sessionId: 'owner',
            host: 'remote',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        };
        let exited = false;
        let exit!: () => void;
        const released = sandbox.stub();
        const context: ViewerSessionContext = {
            sessionId: source.sessionId,
            source,
            get hasExited() {
                return exited;
            },
            observeExit: (callback) => {
                exit = callback;
                return { dispose: released };
            },
            getHtml: () => '',
            attach: () => {},
        };
        sandbox.stub(session, 'getViewerSessionContext').returns(context);
        const events = new vscode.EventEmitter<RSessionConnectionChange>();
        sandbox.stub(session, 'onDidChangeSessionConnection').callsFake(events.event);
        const resolve = sandbox
            .stub(session, 'resolvePlotSession')
            .returns(source as session.Session);
        const viewer = new LifecycleViewer('localhost:1234', {
            ...manager.viewerOptions,
            source,
            resizeTimeoutLength: 100,
            refreshTimeoutLength: 10,
        });
        viewer.activePlot = '1';
        manager.registerViewer(viewer);
        const disconnect = sandbox.spy(viewer.api, 'disconnect');
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        const fire = (kind: RSessionConnectionChange['kind'], sessionId = source.sessionId) =>
            events.fire({ kind, session: { sessionId, connectionId: 'connection' } });
        return {
            source,
            viewer,
            resolve,
            disconnect,
            errors,
            released,
            fire,
            exit: () => {
                exited = true;
                exit();
            },
        };
    }

    test('owning process exit deletes history and cancels queued work while leaving the rendered plot alone', async () => {
        const clock = sandbox.useFakeTimers();
        const state = lifetime();
        const request = sandbox.stub(state.viewer.api, 'getPlotText').resolves('<svg/>');
        const closePanel = sandbox.stub();
        const panel = { dispose: closePanel, webview: { html: '<svg/>' } };
        state.viewer.webviewPanel = panel as unknown as vscode.WebviewPanel;
        manager.registerActiveViewer(state.viewer);
        state.viewer.queueResize();
        await state.viewer.queueRefresh();
        state.exit();
        await clock.tickAsync(200);
        state.viewer.resizeNow();
        await state.viewer.queueRefresh();
        await clock.tickAsync(200);
        sinon.assert.notCalled(request);
        sinon.assert.calledOnce(state.disconnect);
        sinon.assert.calledOnce(state.released);
        sinon.assert.notCalled(closePanel);
        assert.strictEqual(panel.webview.html, '<svg/>');
        assert.strictEqual(state.viewer.webviewPanel, undefined);
        assert.deepStrictEqual(state.viewer.plots, []);
        assert.strictEqual(state.viewer.activePlot, undefined);
        sinon.assert.notCalled(state.errors);
        assert.deepStrictEqual(manager.viewers, []);
        assert.deepStrictEqual(manager.recentlyActiveViewers, []);
        state.viewer.show();
        manager.registerActiveViewer(state.viewer);
        assert.deepStrictEqual(manager.recentlyActiveViewers, []);
        connect.resetHistory();
        state.fire('connected');
        await manager.showViewer('http://localhost:1234', { ...state.source });
        assert.strictEqual(await manager.restoreConnection({ ...state.source }), undefined);
        sinon.assert.notCalled(connect);
        state.viewer.webviewPanel = undefined;
    });

    test('reconnect renders at the viewport size received while disconnected despite a late old render', async () => {
        const clock = sandbox.useFakeTimers();
        const state = lifetime();
        let finish!: (svg: string) => void;
        const request = sandbox.stub(state.viewer.api, 'getPlotText');
        request.onFirstCall().returns(
            new Promise<string>((resolve) => {
                finish = resolve;
            }),
        );
        request.onSecondCall().resolves('<svg/>');
        state.viewer.resizeNow();
        state.resolve.returns(undefined);
        state.fire('disconnected');
        state.viewer.resizeTo(1200, 700);
        finish('<svg/>');
        await clock.tickAsync(200);
        sinon.assert.calledOnce(request);

        state.resolve.returns(state.source as session.Session);
        state.fire('connected');
        await state.viewer.queueRefresh();
        await clock.tickAsync(10);
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.secondCall.args[0], {
            id: '1',
            width: 1200,
            height: 700,
            zoom: 1,
            renderer: 'svgp',
        });
        assert.strictEqual(
            state.viewer.webviewPanel,
            undefined,
            'reconnect must not reopen a closed panel',
        );
    });

    test('session disconnect suppresses in-flight refresh errors and reconnect resumes only its owner', async () => {
        const clock = sandbox.useFakeTimers();
        const state = lifetime();
        let fail!: (error: Error) => void;
        const request = sandbox.stub(state.viewer.api, 'getPlotText').returns(
            new Promise<string>((_resolve, reject) => {
                fail = reject;
            }),
        );
        state.viewer.resizeNow();
        state.resolve.returns(undefined);
        state.fire('disconnected');
        fail(new Error('connect ECONNREFUSED'));
        await clock.tickAsync(0);
        sinon.assert.calledOnce(state.disconnect);
        sinon.assert.notCalled(state.errors);
        request.resetHistory();
        state.viewer.queueResize();
        await state.viewer.queueRefresh();
        await clock.tickAsync(200);
        sinon.assert.notCalled(request);
        connect.resetHistory();
        state.fire('connected', 'another-owner');
        sinon.assert.notCalled(connect);
        state.resolve.returns(state.source as session.Session);
        state.fire('connected');
        sinon.assert.calledOnce(connect);
        request.rejects(new Error('a real render error'));
        state.viewer.resizeNow();
        await clock.tickAsync(0);
        sinon.assert.calledOnce(state.errors);
    });
});
