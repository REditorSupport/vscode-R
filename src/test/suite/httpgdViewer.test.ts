import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { HttpgdClient } from '../../plotViewer/httpgdClient';
import { HttpgdManager, HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { mockExtensionContext } from '../common/mockvscode';
import * as util from '../../util';

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
    const extensionRoot = path.resolve(__dirname, '../../..');
    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(HttpgdClient.prototype, 'connect').resolves();
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
});
