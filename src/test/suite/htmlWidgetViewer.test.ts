import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import * as util from '../../util';
import { showWebView } from '../../webViewer';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred } from '../common/sessionConnections';

suite('Session-aware HTML widget Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let read: sinon.SinonStub;
    const owners: session.Session[] = [];
    const panels: vscode.WebviewPanel[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        read = sandbox.stub(util, 'readContent').callsFake(file => Promise.resolve(
            `<div>${String(file)}</div><script src="lib/widget.js"></script>`));
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title, _column, options) => {
            const disposed = new vscode.EventEmitter<void>();
            const received = new vscode.EventEmitter<unknown>();
            let closed = false;
            const webview = {
                html: '', options, cspSource: 'webview-test:',
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: received.event, postMessage: sandbox.stub().resolves(true),
            };
            const panel = {
                title, viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
                get webview() {
                    assert.strictEqual(closed, false, 'Disposed panels must not be accessed');
                    return webview;
                },
                onDidDispose: disposed.event,
                dispose: () => {
                    if (closed) { return; }
                    closed = true; disposed.fire(); disposed.dispose(); received.dispose();
                },
            } as unknown as vscode.WebviewPanel;
            panels.push(panel);
            return panel;
        });
    });

    teardown(() => {
        panels.splice(0).forEach(panel => { panel.dispose(); });
        owners.splice(0).forEach(owner => session.unregisterSessionTransport(owner));
        sandbox.restore();
    });

    function owner(id: string): session.Session {
        const result = session.registerSessionTransport(id, 'widget-test-host', '/tmp', sandbox.stub().resolves({}));
        result.pid = String(1000 + owners.length); result.rVer = '4.6.1';
        owners.push(result);
        return result;
    }

    function show(file: string, source: session.Session, title = 'Viewer', viewer: string | boolean = 'Two') {
        return showWebView(file, title, viewer, source.sessionId);
    }

    test('reuses one panel per session and updates widget dependencies without moving its editor group', async () => {
        const first = owner('html-first');
        const second = owner('html-second');
        await show('/tmp/widget-a/index.html', first);
        await show('/tmp/widget-b/index.html', second);
        await show('/tmp/widget-c/index.html', first, 'Updated Viewer', 'Beside');
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(panels[0].title, 'Updated Viewer');
        assert.ok(panels[0].webview.html.includes('/tmp/widget-c/index.html'));
        assert.ok(panels[0].webview.html.includes('/tmp/widget-c/lib/widget.js'));
        assert.ok(panels[1].webview.html.includes('/tmp/widget-b/index.html'));
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.[0].fsPath, '/tmp/widget-c');
        assert.deepStrictEqual((panels[0].reveal as sinon.SinonStub).lastCall.args, [vscode.ViewColumn.Two, true]);
        assert.ok(!panels[0].webview.html.includes('viewer-session'));
        assert.ok(!panels[1].webview.html.includes('viewer-session'));
    });

    test('concurrent requests share a panel and the newest request wins', async () => {
        const source = owner('html-concurrent');
        const slow = deferred<string>();
        read.onFirstCall().returns(slow.promise);
        const pending = show('/tmp/slow/index.html', source, 'Old');
        await show('/tmp/latest/index.html', source, 'Latest');
        assert.strictEqual(panels.length, 1);
        const latest = panels[0].webview.html;
        slow.resolve('<div>Old HTML</div>');
        await pending;
        assert.strictEqual(panels[0].webview.html, latest);
        assert.strictEqual(panels[0].title, 'Latest');
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.[0].fsPath, '/tmp/latest');
    });

    test('closing during a load allows a new panel and discards the old result', async () => {
        const source = owner('html-close');
        const slow = deferred<string>();
        read.onFirstCall().returns(slow.promise);
        const pending = show('/tmp/closed/index.html', source);
        panels[0].dispose();
        await show('/tmp/new/index.html', source);
        slow.resolve('<div>Closed output</div>');
        await pending;
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[1].webview.html.includes('/tmp/new/index.html'));
    });

    test('reconnecting the same session reuses its panel while a fresh process has its own', async () => {
        const source = owner('html-reconnect');
        await show('/tmp/before/index.html', source);
        session.unregisterSessionTransport(source);
        const reconnected = owner('html-reconnect');
        reconnected.pid = source.pid;
        await show('/tmp/after/index.html', reconnected);
        assert.strictEqual(panels.length, 1);
        const restarted = owner('html-restarted');
        await show('/tmp/restarted/index.html', restarted);
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[0].webview.html.includes('/tmp/after/index.html'));
    });

    test('disabled viewing opens externally without creating or changing a panel', async () => {
        const source = owner('html-disabled');
        const external = sandbox.stub(vscode.env, 'openExternal').resolves(true);
        await show('/tmp/widget/index.html', source, 'Viewer', false);
        assert.strictEqual(panels.length, 0);
        sinon.assert.calledOnce(external);
        sinon.assert.notCalled(read);
    });

    test('unowned HTML pages retain independent panels', async () => {
        await showWebView('/tmp/page-a/index.html', 'Page Viewer', 'Two');
        await showWebView('/tmp/page-b/index.html', 'Page Viewer', 'Two');
        assert.strictEqual(panels.length, 2);
    });
});
