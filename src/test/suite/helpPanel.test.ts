import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import { HelpPanel } from '../../helpViewer/panel';
import type { HelpFile, RHelp } from '../../helpViewer';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('Help panel navigation', () => {
    let sandbox: sinon.SinonSandbox;
    let panel: vscode.WebviewPanel;
    let help: HelpPanel;
    let closed: vscode.EventEmitter<void>;
    let load: sinon.SinonStub;
    let postMessage: sinon.SinonStub;

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((finish) => {
            resolve = finish;
        });
        return { promise, resolve };
    }

    async function settleNavigation(navigation: Promise<void>): Promise<void> {
        await navigation;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async function markHistoryStale(): Promise<void> {
        load.resolves(undefined);
        await help.refresh();
        load.resetHistory();
    }

    setup(async () => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox
            .stub(util, 'config')
            .returns({ get: () => 'Two' } as unknown as vscode.WorkspaceConfiguration);
        closed = new vscode.EventEmitter<void>();
        load = sandbox.stub();
        postMessage = sandbox.stub().resolves(true);
        panel = {
            active: true,
            reveal: sandbox.stub(),
            dispose: () => closed.fire(),
            onDidDispose: closed.event,
            onDidChangeViewState: sandbox.stub(),
            webview: {
                html: '',
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: sandbox.stub(),
                postMessage,
            },
        } as unknown as vscode.WebviewPanel;
        help = new HelpPanel(
            { webviewScriptPath: '/help.js', webviewStylePath: '/help.css' },
            { getHelpFileForPath: load } as unknown as RHelp,
            panel,
        );
        await help.showHelpFile({ requestPath: '/first', html: '<body>First</body>' });
        await help.showHelpFile({ requestPath: '/second', html: '<body>Second</body>' });
    });

    teardown(() => {
        try {
            help?.dispose();
            closed?.dispose();
        } finally {
            sandbox.restore();
        }
    });

    test('Back still works when a webview cannot acknowledge its scroll position', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = help.goBack();
        await clock.tickAsync(1000);
        await pending;
        assert.match(panel.webview.html, /First/);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('closing the panel settles pending navigation without waiting for a timeout', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = help.goBack();
        panel.dispose();
        await pending;
        assert.strictEqual(help.panel, undefined);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('failed delivery falls back immediately instead of waiting for the scroll timeout', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        postMessage.resolves(false);
        await help.goBack();
        await clock.tickAsync(0);
        assert.match(panel.webview.html, /First/);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('closing Help during a refresh fetch does not recreate its panel', async () => {
        const fetched = deferred<HelpFile>();
        load.returns(fetched.promise);
        const create = sandbox.stub(vscode.window, 'createWebviewPanel');
        const refresh = help.refresh();
        sinon.assert.calledOnceWithExactly(load, '/second', undefined, true);
        panel.dispose();
        fetched.resolve({ requestPath: '/second', html: '<body>Refreshed</body>' });
        await refresh;
        assert.strictEqual(help.panel, undefined);
        sinon.assert.notCalled(create);
        sinon.assert.notCalled(postMessage);
    });

    test('a newer refresh wins when the older page fetch completes first', async () => {
        const first = deferred<HelpFile>();
        const second = deferred<HelpFile>();
        load.onFirstCall().returns(first.promise);
        load.onSecondCall().returns(second.promise);
        postMessage.resolves(false);
        const older = help.refresh();
        const newer = help.refresh();
        first.resolve({ requestPath: '/second', html: '<body>Older refresh</body>' });
        await older;
        const htmlAfterOlder = panel.webview.html;
        second.resolve({ requestPath: '/second', html: '<body>Latest refresh</body>' });
        await newer;
        assert.match(htmlAfterOlder, /Second/);
        assert.doesNotMatch(htmlAfterOlder, /Older refresh/);
        assert.match(panel.webview.html, /Latest refresh/);
        sinon.assert.calledOnce(postMessage);
    });

    test('an older preview scroll timeout cannot invalidate a newer pending refresh', async () => {
        await help.showHelpFile({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Original preview</body>',
        });
        const original = panel.webview.html;
        const second = deferred<HelpFile>();
        load.onFirstCall().resolves({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Older preview</body>',
        });
        load.onSecondCall().returns(second.promise);
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const older = help.refreshPreview('/pkg');
        await clock.tickAsync(0);
        sinon.assert.calledOnce(postMessage);
        const newer = help.refreshPreview('/pkg');
        await clock.tickAsync(1000);
        await older;
        const htmlAfterOlder = panel.webview.html;
        second.resolve({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Latest preview</body>',
        });
        await clock.tickAsync(1000);
        await newer;
        assert.strictEqual(htmlAfterOlder, original);
        assert.match(panel.webview.html, /Latest preview/);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('closing Help during a refresh scroll wait leaves it closed and cancels its timer', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        load.resolves({ requestPath: '/second', html: '<body>Refreshed</body>' });
        const create = sandbox.stub(vscode.window, 'createWebviewPanel');
        const refresh = help.refresh();
        await clock.tickAsync(0);
        sinon.assert.calledOnce(postMessage);
        panel.dispose();
        await refresh;
        assert.strictEqual(help.panel, undefined);
        assert.strictEqual(clock.countTimers(), 0);
        sinon.assert.notCalled(create);
    });

    test('navigation while a refresh fetch is pending keeps the newly selected page', async () => {
        const fetched = deferred<HelpFile>();
        load.returns(fetched.promise);
        const refresh = help.refresh();
        await help.showHelpFile({ requestPath: '/third', html: '<body>Third</body>' });
        fetched.resolve({ requestPath: '/second', html: '<body>Refreshed second</body>' });
        await refresh;
        assert.match(panel.webview.html, /Third/);
        sinon.assert.notCalled(postMessage);
    });

    test('navigation while a refresh awaits scroll prevents stale replacement', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        load.resolves({ requestPath: '/second', html: '<body>Refreshed second</body>' });
        const refresh = help.refresh();
        await clock.tickAsync(0);
        sinon.assert.calledOnce(postMessage);
        await help.showHelpFile({ requestPath: '/third', html: '<body>Third</body>' });
        await clock.tickAsync(1000);
        await refresh;
        assert.match(panel.webview.html, /Third/);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('closing during async page preparation prevents a late write to the disposed webview', async () => {
        const external = deferred<vscode.Uri>();
        sandbox.stub(vscode.env, 'asExternalUri').returns(external.promise);
        const prepared = help.showHelpFile({
            requestPath: '/math',
            url: 'http://localhost:1234/math',
            html: '<body><script src="katex.js"></script>Math</body>',
        });
        await Promise.resolve();
        panel.dispose();
        external.resolve(vscode.Uri.parse('http://localhost:1234/katex.js'));
        assert.strictEqual(await prepared, false);
        assert.doesNotMatch(panel.webview.html, /Math/);
        assert.strictEqual(help.panel, undefined);
    });

    test('a preview refresh cannot cancel a selected page awaiting HTML preparation', async () => {
        await help.showHelpFile({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Old preview</body>',
        });
        const external = deferred<vscode.Uri>();
        const preparing = deferred<void>();
        sandbox.stub(vscode.env, 'asExternalUri').callsFake(() => {
            preparing.resolve();
            return external.promise;
        });
        load.resolves({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Refreshed old preview</body>',
        });
        postMessage.resolves(false);
        const selected = help.showHelpFile({
            requestPath: '/destination',
            url: 'http://localhost:1234/destination',
            html: '<body>Selected destination<script src="katex.js"></script></body>',
        });
        await preparing.promise;
        await help.refreshPreview('/pkg');
        external.resolve(vscode.Uri.parse('http://localhost:1234/katex.js'));
        assert.strictEqual(await selected, true);
        assert.match(panel.webview.html, /Selected destination/);
        assert.doesNotMatch(panel.webview.html, /Old preview|Refreshed old preview/);
        sinon.assert.notCalled(load);
    });

    test('a preview refresh cannot cancel a selected page whose file is pending', async () => {
        await help.showHelpFile({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Old preview</body>',
        });
        const file = deferred<HelpFile>();
        load.resolves({
            requestPath: '/second',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Refreshed old preview</body>',
        });
        postMessage.resolves(false);
        const selected = help.showHelpFile(file.promise);
        await help.refreshPreview('/pkg');
        file.resolve({ requestPath: '/destination', html: '<body>Selected destination</body>' });
        assert.strictEqual(await selected, true);
        assert.match(panel.webview.html, /Selected destination/);
        sinon.assert.notCalled(load);
    });

    test('a preview refresh during stale Back navigation preserves the selected destination', async () => {
        await help.showHelpFile({
            requestPath: '/third',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>History C</body>',
        });
        postMessage.resolves(false);
        await markHistoryStale();
        const file = deferred<HelpFile>();
        const requested = deferred<void>();
        load.withArgs('/second', true, true).callsFake(() => {
            requested.resolve();
            return file.promise;
        });
        load.withArgs('/third', undefined, true).resolves({
            requestPath: '/third',
            packageDir: '/pkg',
            isPreview: true,
            html: '<body>Refreshed C</body>',
        });
        const back = help.goBack();
        await requested.promise;
        await help.refreshPreview('/pkg');
        file.resolve({ requestPath: '/second', html: '<body>History B</body>' });
        await settleNavigation(back);
        assert.match(panel.webview.html, /History B/);
        sinon.assert.neverCalledWith(load, '/third', undefined, true);
        await settleNavigation(help.goForward());
        assert.match(panel.webview.html, /History C/);
    });

    test('a cancelled stale Back navigation does not remove its history destination', async () => {
        await help.showHelpFile({ requestPath: '/third', html: '<body>History C</body>' });
        postMessage.resolves(false);
        await markHistoryStale();
        const file = deferred<HelpFile>();
        const requested = deferred<void>();
        load.withArgs('/second', true, true).callsFake(() => {
            requested.resolve();
            return file.promise;
        });
        const back = help.goBack();
        await requested.promise;
        await help.showHelpFile({ requestPath: '/fourth', html: '<body>Selected D</body>' });
        file.resolve({ requestPath: '/second', html: '<body>History B</body>' });
        await settleNavigation(back);
        assert.match(panel.webview.html, /Selected D/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /History C/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /History B/);
    });

    test('a cancelled stale Forward navigation keeps its destination for retry', async () => {
        await help.showHelpFile({ requestPath: '/third', html: '<body>History C</body>' });
        postMessage.resolves(false);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /Second/);
        await markHistoryStale();
        const file = deferred<HelpFile>();
        const requested = deferred<void>();
        load.withArgs('/third', true, true).callsFake(() => {
            requested.resolve();
            return file.promise;
        });
        const forward = help.goForward();
        await requested.promise;
        await help.showHelpFile(
            { requestPath: '/second', html: '<body>B replacement</body>' },
            false,
        );
        file.resolve({ requestPath: '/third', html: '<body>History C</body>' });
        await settleNavigation(forward);
        assert.match(panel.webview.html, /B replacement/);
        await settleNavigation(help.goForward());
        assert.match(panel.webview.html, /History C/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /B replacement/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /First/);
    });

    test('a rejected stale Back fetch preserves history and allows refresh and retry', async () => {
        await help.showHelpFile({ requestPath: '/third', html: '<body>History C</body>' });
        postMessage.resolves(false);
        await markHistoryStale();
        const failure = new Error('Back fetch failed');
        const backLoad = load.withArgs('/second', true, true);
        backLoad.onFirstCall().rejects(failure);
        backLoad
            .onSecondCall()
            .resolves({ requestPath: '/second', html: '<body>History B</body>' });
        await assert.rejects(help.goBack(), (error) => error === failure);
        assert.match(panel.webview.html, /History C/);
        load.withArgs('/third', undefined, true).resolves({
            requestPath: '/third',
            html: '<body>Refreshed C</body>',
        });
        await help.refresh();
        assert.match(panel.webview.html, /Refreshed C/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /History B/);
        await settleNavigation(help.goForward());
        assert.match(panel.webview.html, /Refreshed C/);
    });

    test('failed Forward HTML preparation preserves its destination and allows refresh and retry', async () => {
        await help.showHelpFile({ requestPath: '/third', html: '<body>History C</body>' });
        postMessage.resolves(false);
        await settleNavigation(help.goBack());
        await markHistoryStale();
        load.withArgs('/third', true, true).resolves({
            requestPath: '/third',
            url: 'http://localhost:1234/third',
            html: '<body>History C math<script src="katex.js"></script></body>',
        });
        const failure = new Error('Forward HTML preparation failed');
        const external = sandbox.stub(vscode.env, 'asExternalUri');
        external.onFirstCall().rejects(failure);
        external.onSecondCall().resolves(vscode.Uri.parse('http://localhost:1234/katex.js'));
        await assert.rejects(help.goForward(), (error) => error === failure);
        assert.match(panel.webview.html, /Second/);
        load.withArgs('/second', undefined, true).resolves({
            requestPath: '/second',
            html: '<body>Refreshed B</body>',
        });
        await help.refresh();
        assert.match(panel.webview.html, /Refreshed B/);
        await settleNavigation(help.goForward());
        assert.match(panel.webview.html, /History C math/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /Refreshed B/);
        await settleNavigation(help.goBack());
        assert.match(panel.webview.html, /First/);
    });
});
