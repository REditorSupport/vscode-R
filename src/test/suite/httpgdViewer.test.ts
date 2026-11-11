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
    teardown(() => {
        try {
            manager?.viewers.forEach((viewer) => viewer.dispose());
        } finally {
            sandbox.restore();
        }
    });

    test('focusing a correctly sized non-square plot does not request another render', async () => {
        const viewer = new TestViewer('localhost:1234', manager.viewerOptions);
        manager.viewers.push(viewer);
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
        manager.viewers.push(viewer);
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
        manager.viewers.push(viewer);
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

    test('owning process exit cancels queued work and leaves the open panel intact', async () => {
        const clock = sandbox.useFakeTimers();
        const state = lifetime();
        const request = sandbox.stub(state.viewer.api, 'getPlotText').resolves('<svg/>');
        const closePanel = sandbox.stub();
        state.viewer.webviewPanel = { dispose: closePanel } as unknown as vscode.WebviewPanel;
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
        sinon.assert.notCalled(state.errors);
        connect.resetHistory();
        state.fire('connected');
        sinon.assert.notCalled(connect);
        state.viewer.webviewPanel = undefined;
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
