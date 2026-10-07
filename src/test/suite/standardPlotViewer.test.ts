import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { StandardPlotViewer } from '../../plotViewer/standardViewer';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
    return Promise.resolve().then(() => Promise.resolve());
}

suite('Standard plot viewer request coordination', () => {
    let sandbox: sinon.SinonSandbox;
    let viewer: StandardPlotViewer;
    let panels: Array<{
        panel: vscode.WebviewPanel;
        resize: (width: number, height: number) => Promise<void>;
        postMessage: sinon.SinonStub;
    }>;

    setup(() => {
        sandbox = sinon.createSandbox();
        panels = [];
        const root = path.resolve(__dirname, '../../..');
        mockExtensionContext(root, sandbox);
        sandbox.stub(session, 'globalPipePath').value('test-pipe');
        sandbox.stub(util, 'config').returns({
            get: (key: string, defaultValue?: unknown) => key === 'plot.format' ? 'svglite' : defaultValue
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake(() => {
            const disposed = new vscode.EventEmitter<void>();
            let receiveMessage: ((message: { type: string; width?: number; height?: number }) => Promise<void>) | undefined;
            const postMessage = sandbox.stub().resolves(true);
            const panel = {
                title: 'R Plot',
                viewColumn: vscode.ViewColumn.Two,
                reveal: sandbox.stub(),
                webview: {
                    html: '',
                    postMessage,
                    onDidReceiveMessage: (listener: typeof receiveMessage) => { receiveMessage = listener; },
                },
                onDidDispose: disposed.event,
                dispose: () => { disposed.fire(); disposed.dispose(); },
            } as unknown as vscode.WebviewPanel;
            panels.push({
                panel,
                postMessage,
                resize: (width, height) => receiveMessage?.({ type: 'resize', width, height }) ?? Promise.resolve(),
            });
            return panel;
        });
        viewer = new StandardPlotViewer();
    });

    teardown(() => {
        viewer.dispose();
        sandbox.restore();
    });

    test('coalesces resize and update bursts and uses the latest size for each followup', async () => {
        const firstRequest = deferred<unknown>();
        const secondRequest = deferred<unknown>();
        const thirdRequest = deferred<unknown>();
        const secondStarted = deferred<void>();
        const thirdStarted = deferred<void>();
        const request = sandbox.stub(session, 'sessionRequest').callsFake(() => {
            if (request.callCount === 1) { return firstRequest.promise; }
            if (request.callCount === 2) { secondStarted.resolve(); return secondRequest.promise; }
            thirdStarted.resolve();
            return thirdRequest.promise;
        });

        await viewer.update();
        const firstPanel = panels[0];
        const firstResize = firstPanel.resize(100, 100);
        const update = viewer.update();
        const latestResize = firstPanel.resize(400, 600);
        const anotherResize = firstPanel.resize(300, 500);
        sinon.assert.calledOnce(request);

        firstRequest.resolve({ data: 'first', format: 'svg' });
        await secondStarted.promise;
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.secondCall.args[0], {
            method: 'plot_latest',
            params: { width: 300, height: 500, format: 'svglite', devArgs: undefined }
        });

        const pendingResize = firstPanel.resize(700, 800);
        const pendingUpdate = viewer.update();
        sinon.assert.calledTwice(request);
        secondRequest.resolve({ data: 'second', format: 'svg' });
        await thirdStarted.promise;
        sinon.assert.calledThrice(request);
        assert.deepStrictEqual(request.thirdCall.args[0], {
            method: 'plot_latest',
            params: { width: 700, height: 800, format: 'svglite', devArgs: undefined }
        });
        thirdRequest.resolve({ data: 'third', format: 'svg' });
        await Promise.all([firstResize, update, latestResize, anotherResize, pendingResize, pendingUpdate]);
        sinon.assert.calledOnce(firstPanel.postMessage.withArgs({ type: 'update', data: 'third', format: 'svg' }));
    });

    test('does not retry a failed request, and a later resize can start a new request', async () => {
        const request = sandbox.stub(session, 'sessionRequest');
        request.onFirstCall().rejects(new Error('transport failed'));
        request.onSecondCall().resolves({ data: 'recovered', format: 'svg' });
        await viewer.update();

        await panels[0].resize(100, 100);
        sinon.assert.calledOnce(request);
        await panels[0].resize(200, 300);
        sinon.assert.calledTwice(request);
        sinon.assert.calledOnce(panels[0].postMessage);
    });

    test('keeps the old request in flight across disposal and ignores its response after recreation', async () => {
        const firstRequest = deferred<unknown>();
        const secondRequest = deferred<unknown>();
        const secondStarted = deferred<void>();
        const request = sandbox.stub(session, 'sessionRequest').callsFake(() => {
            if (request.callCount === 1) { return firstRequest.promise; }
            secondStarted.resolve();
            return secondRequest.promise;
        });
        await viewer.update();
        const oldPanel = panels[0];
        const oldResize = oldPanel.resize(100, 100);

        viewer.dispose();
        await viewer.update();
        const newPanel = panels[1];
        const newResize = newPanel.resize(900, 700);
        await oldPanel.resize(333, 444);
        sinon.assert.calledOnce(request);

        firstRequest.resolve({ data: 'stale', format: 'svg' });
        await secondStarted.promise;
        sinon.assert.notCalled(oldPanel.postMessage);
        sinon.assert.calledTwice(request);
        const recreatedRequest = request.secondCall.args[0] as {
            params: { width: number; height: number };
        };
        assert.strictEqual(recreatedRequest.params.width, 900);
        assert.strictEqual(recreatedRequest.params.height, 700);
        secondRequest.resolve({ data: 'current', format: 'svg' });
        await Promise.all([oldResize, newResize]);
        sinon.assert.calledOnceWithExactly(newPanel.postMessage, {
            type: 'update', data: 'current', format: 'svg'
        });
    });

    test('does not post a response from a session that stopped being active', async () => {
        const firstSession = {} as session.Session;
        const nextSession = {} as session.Session;
        const activeSession = sandbox.stub(session, 'activeSession').value(firstSession);
        const requestResult = deferred<unknown>();
        sandbox.stub(session, 'sessionRequest').returns(requestResult.promise);
        await viewer.update();
        const resize = panels[0].resize(100, 100);

        activeSession.value(nextSession);
        requestResult.resolve({ data: 'stale session', format: 'svg' });
        await resize;
        sinon.assert.notCalled(panels[0].postMessage);
    });

    test('waits for the initial webview resize before requesting the first plot', async () => {
        const request = sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
        await viewer.update();
        sinon.assert.notCalled(request);
        await panels[0].resize(640, 480);
        sinon.assert.calledOnce(request);
    });

    test('handles a request that resolves without plot data without becoming stuck', async () => {
        const request = sandbox.stub(session, 'sessionRequest');
        request.onFirstCall().resolves(undefined);
        request.onSecondCall().resolves({ data: 'next plot', format: 'svg' });
        await viewer.update();
        await panels[0].resize(100, 100);
        sinon.assert.calledOnce(request);
        await panels[0].resize(200, 200);
        sinon.assert.calledTwice(request);
    });

    test('does not schedule an automatic retry after a request returns no data', async () => {
        const first = deferred<unknown>();
        const request = sandbox.stub(session, 'sessionRequest').returns(first.promise);
        await viewer.update();
        const resize = panels[0].resize(100, 100);
        const duringRequest = panels[0].resize(200, 200);
        first.resolve(undefined);
        await Promise.all([resize, duringRequest]);
        await flushMicrotasks();
        sinon.assert.calledOnce(request);
    });
});
