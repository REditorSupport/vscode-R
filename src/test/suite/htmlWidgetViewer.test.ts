import * as assert from 'assert';
import fs from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { HtmlViewerSessionAccess, initializeHtmlWidgetViewers, restoreHtmlViewer, showWebView, shutdownHtmlWidgetViewers } from '../../webViewer';
import { extensionContext } from '../../extension';
import { widgetHistoryKey, WidgetHistory } from '../../webViewer/history';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred } from '../common/sessionConnections';

suite('Session-aware HTML widget Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let read: sinon.SinonStub;
    const owners: session.Session[] = [];
    const panels: vscode.WebviewPanel[] = [];
    const receivers = new Map<vscode.WebviewPanel, (message: unknown) => Promise<void>>();
    const savedState = new Map<string, unknown>();
    const viewerSessions: HtmlViewerSessionAccess = {
        resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
        getActiveSessionId: () => session.activeSession?.sessionId,
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        savedState.clear();
        (extensionContext.workspaceState.get as sinon.SinonStub).callsFake((key: string, fallback: unknown) => savedState.get(key) ?? fallback);
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake((key: string, value: unknown) => {
            savedState.set(key, JSON.parse(JSON.stringify(value)));
            return Promise.resolve();
        });
        initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        read = sandbox.stub(fs, 'readFile');
        read.callsFake(file => Promise.resolve(
            `<div>${String(file)}</div><script src="lib/widget.js"></script>`));
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title, _column, options) => {
            const disposed = new vscode.EventEmitter<void>();
            const listeners: Array<(message: unknown) => unknown> = [];
            let closed = false;
            const webview = {
                html: '', options, cspSource: 'webview-test:',
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
                    listeners.push(listener);
                    return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
                },
                postMessage: sandbox.stub().resolves(true),
            };
            const panel = {
                title, viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
                get webview() {
                    assert.strictEqual(closed, false, 'Disposed panels must not be accessed');
                    return webview;
                },
                onDidDispose: disposed.event,
                onDidChangeViewState: sandbox.stub(),
                dispose: () => {
                    if (closed) { return; }
                    closed = true; disposed.fire(); disposed.dispose(); listeners.length = 0;
                },
            } as unknown as vscode.WebviewPanel;
            panels.push(panel);
            receivers.set(panel, async message => { await Promise.all(listeners.map(listener => listener(message))); });
            return panel;
        });
    });

    teardown(async () => {
        panels.splice(0).forEach(panel => { panel.dispose(); });
        await shutdownHtmlWidgetViewers();
        receivers.clear();
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
        return showWebView(file, title, viewer, session.getViewerSessionContext(source.sessionId));
    }

    function outputTitle(panel: vscode.WebviewPanel): string | undefined {
        assert.strictEqual(panel.title, 'HTML Viewer');
        return /<title>(.*?)<\/title>/.exec(panel.webview.html)?.[1];
    }

    function widgetDocument(panel: vscode.WebviewPanel): string {
        const attribute = /data-widget-document="([^"]*)"/.exec(panel.webview.html)?.[1];
        assert.ok(attribute, 'Widgets must render in an iframe separate from the toolbar');
        return attribute.replace(/&(amp|lt|gt|quot|#39);/g, entity => ({
            '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
        })[entity]!);
    }

    async function navigate(panel: vscode.WebviewPanel, direction: 'back' | 'forward', generation?: number): Promise<void> {
        await receivers.get(panel)!({
            message: 'widget/navigate', direction,
            generation: generation ?? Number(/data-generation="(\d+)"/.exec(panel.webview.html)?.[1]),
        });
    }

    async function remove(panel: vscode.WebviewPanel, generation?: number): Promise<void> {
        await receivers.get(panel)!({
            message: 'widget/remove',
            generation: generation ?? Number(/data-generation="(\d+)"/.exec(panel.webview.html)?.[1]),
        });
    }

    function disabled(panel: vscode.WebviewPanel, button: 'back' | 'forward' | 'remove'): boolean {
        return new RegExp(`<button id="widget-${button}"[^>]*\\bdisabled`).test(panel.webview.html);
    }

    test('uses the initialized extension context for both globe icon themes', async () => {
        const context = {
            ...extensionContext,
            asAbsolutePath: (relative: string) => path.join('/viewer-extension', relative),
        };
        initializeHtmlWidgetViewers(context, viewerSessions);
        await show('/tmp/icon.html', owner('html-icon'));
        assert.deepStrictEqual(panels[0].iconPath, {
            dark: vscode.Uri.file(path.join('/viewer-extension', 'images/icons/dark/globe.svg')),
            light: vscode.Uri.file(path.join('/viewer-extension', 'images/icons/light/globe.svg')),
        });
    });

    test('restoration reads the configured editor group and defaults to Two when none is set', async () => {
        const source = owner('html-restore-view-column');
        const configuration = sandbox.stub(vscode.workspace, 'getConfiguration');
        await show('/tmp/view-column.html', source);
        for (const viewer of [undefined, 'Three']) {
            await shutdownHtmlWidgetViewers();
            const records = savedState.get(widgetHistoryKey) as WidgetHistory[];
            delete records[0].viewColumn;
            configuration.withArgs('r').returns({
                get: (key: string) => key === 'session.viewers.viewColumn' && viewer ? { viewer } : undefined,
            } as vscode.WorkspaceConfiguration);
            initializeHtmlWidgetViewers(extensionContext, viewerSessions);
            await restoreHtmlViewer(source.sessionId);
            const options = (vscode.window.createWebviewPanel as sinon.SinonStub).lastCall.args[2] as { viewColumn: vscode.ViewColumn };
            assert.strictEqual(options.viewColumn, viewer ? vscode.ViewColumn.Three : vscode.ViewColumn.Two);
        }
    });

    test('reuses one panel per session and updates widget dependencies without moving its editor group', async () => {
        const first = owner('html-first');
        const second = owner('html-second');
        await show('/tmp/widget-a/index.html', first);
        await show('/tmp/widget-b/index.html', second);
        await show('/tmp/widget-c/index.html', first, 'Updated Viewer', 'Beside');
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(outputTitle(panels[0]), 'Updated Viewer');
        assert.ok(panels[0].webview.html.includes('/tmp/widget-c/index.html'));
        assert.ok(widgetDocument(panels[0]).includes('<base href="file:///tmp/widget-c/">'));
        assert.ok(widgetDocument(panels[0]).includes('src="lib/widget.js"'));
        assert.ok(panels[1].webview.html.includes('/tmp/widget-b/index.html'));
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.[0].fsPath, vscode.Uri.file('/tmp/widget-c').fsPath);
        assert.deepStrictEqual((panels[0].reveal as sinon.SinonStub).lastCall.args, [vscode.ViewColumn.Two, true]);
        assert.ok(panels[0].webview.html.includes(`R 4.6.1: ${first.pid}`));
        assert.ok(panels[1].webview.html.includes(`R 4.6.1: ${second.pid}`));
        assert.ok(!widgetDocument(panels[0]).includes('widget-toolbar'));
        assert.ok(!widgetDocument(panels[0]).includes('viewer-session'));
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
        assert.strictEqual(outputTitle(panels[0]), 'Latest');
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.[0].fsPath, vscode.Uri.file('/tmp/latest').fsPath);
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

    test('Find activates its owning panel and ignores stale requests without changing history', async () => {
        const command = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        const source = owner('html-find');
        await show('/tmp/a.html', source, 'A');
        const panel = panels[0];
        const previousGeneration = Number(/data-generation="(\d+)"/.exec(panel.webview.html)?.[1]);
        await show('/tmp/b.html', source, 'B');
        await show('/tmp/other.html', owner('html-find-other'), 'Other');
        const html = panel.webview.html;
        const generation = Number(/data-generation="(\d+)"/.exec(html)?.[1]);
        await receivers.get(panel)!({ message: 'widget/find', generation: previousGeneration });
        await receivers.get(panel)!({ message: 'widget/find' });
        sinon.assert.notCalled(command);
        const reveal = (panel as unknown as { reveal: sinon.SinonStub }).reveal;
        reveal.resetHistory();
        await receivers.get(panel)!({ message: 'widget/find', generation });
        sinon.assert.calledOnceWithExactly(command, 'editor.action.webvieweditor.showFind');
        sinon.assert.calledOnceWithExactly(reveal, vscode.ViewColumn.Two, false);
        assert.strictEqual(panel.webview.html, html);
        assert.ok(panel.webview.html.includes('2 / 2'));
        panel.dispose();
        await receivers.get(panel)!({ message: 'widget/find', generation });
        sinon.assert.calledOnce(command);
    });

    test('unowned HTML pages retain independent panels', async () => {
        await showWebView('/tmp/page-a/index.html', 'Page Viewer', 'Two');
        await showWebView('/tmp/page-b/index.html', 'Page Viewer', 'Two');
        assert.strictEqual(panels.length, 2);
        assert.ok(!panels[0].webview.html.includes('widget-toolbar'));
        assert.ok(panels.every(panel => panel.title === 'HTML Viewer'));
    });

    test('Back and Forward browse only the owning session with correct boundary states', async () => {
        const first = owner('html-history-first');
        const second = owner('html-history-second');
        await show('/tmp/a/index.html', first, 'A');
        const panel = panels[0];
        assert.ok(disabled(panel, 'back') && disabled(panel, 'forward'));
        await show('/tmp/b/index.html', first, 'B');
        await show('/tmp/other/index.html', second, 'Other');
        const other = panels[1].webview.html;
        assert.ok(!disabled(panel, 'back') && disabled(panel, 'forward'));
        assert.ok(panel.webview.html.includes('2 / 2'));
        await navigate(panel, 'back');
        assert.strictEqual(outputTitle(panel), 'A');
        assert.ok(widgetDocument(panel).includes('/tmp/a/index.html'));
        assert.strictEqual(panel.webview.options.localResourceRoots?.[0].fsPath, vscode.Uri.file('/tmp/a').fsPath);
        assert.ok(disabled(panel, 'back') && !disabled(panel, 'forward'));
        const firstHtml = panel.webview.html;
        await navigate(panel, 'back');
        assert.strictEqual(panel.webview.html, firstHtml);
        await navigate(panel, 'forward');
        assert.strictEqual(outputTitle(panel), 'B');
        assert.ok(!disabled(panel, 'back') && disabled(panel, 'forward'));
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(panels[1].webview.html, other);
    });

    test('new output while browsing history appends without losing existing forward entries', async () => {
        const source = owner('html-history-append');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await navigate(panels[0], 'back');
        await show('/tmp/c.html', source, 'C');
        assert.ok(panels[0].webview.html.includes('3 / 3'));
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'B');
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'A');
    });

    test('removing a middle output preserves other sessions and remaining Back/Forward history', async () => {
        const source = owner('html-remove-middle');
        const other = owner('html-remove-other');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await show('/tmp/c.html', source, 'C');
        await show('/tmp/other.html', other, 'Other');
        const otherHtml = panels[1].webview.html;
        await navigate(panels[0], 'back');
        await remove(panels[0]);
        assert.strictEqual(outputTitle(panels[0]), 'A');
        assert.ok(panels[0].webview.html.includes('1 / 2'));
        assert.ok(disabled(panels[0], 'back') && !disabled(panels[0], 'forward'));
        assert.ok(panels[0].webview.html.includes('codicon-error'));
        await navigate(panels[0], 'forward');
        assert.strictEqual(outputTitle(panels[0]), 'C');
        assert.strictEqual(panels[1].webview.html, otherHtml);
        const stored = savedState.get(widgetHistoryKey) as WidgetHistory[];
        assert.deepStrictEqual(stored.find(record => record.source.sessionId === source.sessionId)?.history.map(item => item.title), ['A', 'C']);
    });

    test('removing the first and last outputs selects the remaining neighbor', async () => {
        const source = owner('html-remove-boundaries');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await show('/tmp/c.html', source, 'C');
        await navigate(panels[0], 'back');
        await navigate(panels[0], 'back');
        await remove(panels[0]);
        assert.strictEqual(outputTitle(panels[0]), 'B');
        assert.ok(panels[0].webview.html.includes('1 / 2'));
        await navigate(panels[0], 'forward');
        await remove(panels[0]);
        assert.strictEqual(outputTitle(panels[0]), 'B');
        assert.ok(panels[0].webview.html.includes('1 / 1'));
        assert.ok(disabled(panels[0], 'back') && disabled(panels[0], 'forward'));
    });

    test('removing the last entry clears persisted history and keeps an empty Viewer ready for new output', async () => {
        const source = owner('html-remove-empty');
        await show('/tmp/a.html', source, 'A');
        await remove(panels[0]);
        assert.strictEqual(panels[0].title, 'HTML Viewer');
        assert.ok(widgetDocument(panels[0]).includes('No HTML outputs in this session'));
        assert.ok(panels[0].webview.html.includes('0 / 0'));
        assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)));
        assert.deepStrictEqual(savedState.get(widgetHistoryKey), []);
        assert.strictEqual(read.callCount, 1, 'Empty history must not reload the deleted file');
        await remove(panels[0]);
        await navigate(panels[0], 'back');
        await navigate(panels[0], 'forward');
        assert.strictEqual(read.callCount, 1);
        await show('/tmp/b.html', source, 'B');
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(outputTitle(panels[0]), 'B');
        assert.ok(panels[0].webview.html.includes('1 / 1'));
        assert.ok(!disabled(panels[0], 'remove'));
    });

    test('removed entries stay removed after closing, extension-host recreation, and restoration', async () => {
        const source = owner('html-remove-reload');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await remove(panels[0]);
        panels[0].dispose();
        await shutdownHtmlWidgetViewers();
        initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(outputTitle(panels[1]), 'A');
        assert.ok(panels[1].webview.html.includes('1 / 1'));
        await remove(panels[1]);
        panels[1].dispose();
        await shutdownHtmlWidgetViewers();
        initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        const information = sandbox.stub(vscode.window, 'showInformationMessage');
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2, 'Deleted history must not reopen a Viewer');
        sinon.assert.calledOnce(information);
    });

    test('late removal renders and stale remove messages cannot replace or delete newer output', async () => {
        const source = owner('html-remove-stale');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        const generation = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        const slow = deferred<string>();
        read.onCall(2).returns(slow.promise);
        const pending = remove(panels[0]);
        await show('/tmp/c.html', source, 'C');
        const latest = panels[0].webview.html;
        slow.resolve('<div>A</div>');
        await pending;
        await remove(panels[0], generation);
        assert.strictEqual(panels[0].webview.html, latest);
        assert.strictEqual(outputTitle(panels[0]), 'C');
        assert.ok(panels[0].webview.html.includes('2 / 2'));
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'A');
    });

    test('late history loads and stale toolbar messages cannot replace newer output', async () => {
        const source = owner('html-history-stale');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        const generation = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        const slow = deferred<string>();
        read.onCall(2).returns(slow.promise);
        const pending = navigate(panels[0], 'back');
        await show('/tmp/c.html', source, 'C');
        const latest = panels[0].webview.html;
        slow.resolve('<div>A</div>');
        await pending;
        await navigate(panels[0], 'back', generation);
        assert.strictEqual(panels[0].webview.html, latest);
        assert.strictEqual(outputTitle(panels[0]), 'C');
    });

    test('missing historical files show an error and Forward still returns to available output', async () => {
        const source = owner('html-history-missing');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        read.onCall(2).rejects(Object.assign(new Error('Missing file'), { code: 'ENOENT' }));
        await navigate(panels[0], 'back');
        assert.ok(widgetDocument(panels[0]).includes('This HTML widget could not be loaded'));
        assert.ok(!disabled(panels[0], 'forward'));
        await navigate(panels[0], 'forward');
        assert.ok(widgetDocument(panels[0]).includes('/tmp/b.html'));
    });

    test('closing releases the panel bridge but retains history and the last selected widget for restore', async () => {
        const source = owner('html-history-close');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await navigate(panels[0], 'back');
        const webview = panels[0].webview;
        panels[0].dispose();
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(outputTitle(panels[1]), 'A');
        assert.ok(panels[1].webview.html.includes('1 / 2'));
        await navigate(panels[1], 'forward');
        assert.strictEqual(outputTitle(panels[1]), 'B');
        assert.strictEqual((webview.postMessage as sinon.SinonStub).callCount, 0);
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2, 'Restoration must reuse an open Viewer');
    });

    test('confirmed session exit clears retained history even with its Viewer closed', async () => {
        const source = owner('html-history-closed-exit');
        await show('/tmp/a.html', source);
        panels[0].dispose();
        source.processExited = true;
        const information = sandbox.stub(vscode.window, 'showInformationMessage');
        await restoreHtmlViewer(source.sessionId);
        await shutdownHtmlWidgetViewers();
        assert.strictEqual(panels.length, 1);
        assert.deepStrictEqual(savedState.get(widgetHistoryKey), []);
        sinon.assert.calledOnce(information);
    });

    test('new output after closing appends to retained history', async () => {
        const source = owner('html-history-append-after-close');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        panels[0].dispose();
        await show('/tmp/c.html', source);
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[1].webview.html.includes('3 / 3'));
        await navigate(panels[1], 'back');
        assert.strictEqual(outputTitle(panels[1]), 'B');
    });

    test('restores persisted selection after extension-host recreation and transport reconnect', async () => {
        const source = owner('html-history-reload');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await navigate(panels[0], 'back');
        await shutdownHtmlWidgetViewers();
        session.unregisterSessionTransport(source);
        initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        const reconnected = owner(source.sessionId);
        reconnected.pid = source.pid;
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(outputTitle(panels[1]), 'A');
        assert.ok(panels[1].webview.html.includes('1 / 2'));
        assert.ok(panels[1].webview.html.includes(`R 4.6.1: ${source.pid}`));
        await navigate(panels[1], 'forward');
        assert.strictEqual(outputTitle(panels[1]), 'B');
        await show('/tmp/c.html', reconnected, 'C');
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[1].webview.html.includes('3 / 3'));
    });

    test('restores a detached session without attaching its Viewer to the active session', async () => {
        const source = owner('html-history-detached');
        await show('/tmp/a.html', source, 'Detached widget');
        panels[0].dispose();
        session.unregisterSessionTransport(source);
        const other = owner('html-history-active');
        sandbox.stub(session, 'activeSession').value(other);
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(outputTitle(panels[1]), 'Detached widget');
        assert.ok(panels[1].webview.html.includes(`R 4.6.1: ${source.pid}`));
        assert.ok(!panels[1].webview.html.includes(`R 4.6.1: ${other.pid}`));
    });

    test('restoration follows the injected active session and resolves the saved process', async () => {
        const first = owner('html-injected-first');
        const second = owner('html-injected-second');
        await show('/tmp/first.html', first, 'First');
        await show('/tmp/second.html', second, 'Second');
        panels.forEach(panel => { panel.dispose(); });
        const active = sandbox.stub(viewerSessions, 'getActiveSessionId').returns(first.sessionId);
        const resolve = sandbox.spy(viewerSessions, 'resolveSession');
        const pick = sandbox.stub(vscode.window, 'showQuickPick');
        sandbox.stub(session, 'activeSession').value(undefined);

        await restoreHtmlViewer();
        assert.strictEqual(outputTitle(panels[2]), 'First');
        assert.strictEqual(resolve.lastCall.args[0].sessionId, first.sessionId);
        assert.strictEqual(resolve.lastCall.args[0].pid, first.pid);

        active.returns(second.sessionId);
        await restoreHtmlViewer();
        assert.strictEqual(outputTitle(panels[3]), 'Second');
        assert.strictEqual(resolve.lastCall.args[0].sessionId, second.sessionId);
        assert.strictEqual(resolve.lastCall.args[0].pid, second.pid);
        sinon.assert.notCalled(pick);
    });

    test('command chooses among retained sessions when none is active', async () => {
        const first = owner('html-history-pick-first');
        const second = owner('html-history-pick-second');
        await show('/tmp/first.html', first, 'First');
        await show('/tmp/second.html', second, 'Second');
        panels.forEach(panel => { panel.dispose(); });
        session.unregisterSessionTransport(first);
        session.unregisterSessionTransport(second);
        const pick = sandbox.stub(vscode.window, 'showQuickPick').callsFake((items: unknown) =>
            Promise.resolve((items as Array<vscode.QuickPickItem>)[1]));
        await restoreHtmlViewer();
        sinon.assert.calledOnce(pick);
        assert.strictEqual(outputTitle(panels[2]), 'Second');
        assert.ok(panels[2].webview.html.includes(`R 4.6.1: ${second.pid}`));
    });

    test('restoring unavailable HTML keeps history navigation available', async () => {
        const source = owner('html-history-restore-missing');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        panels[0].dispose();
        read.onCall(2).rejects(Object.assign(new Error('Missing file'), { code: 'ENOENT' }));
        await restoreHtmlViewer(source.sessionId);
        assert.ok(widgetDocument(panels[1]).includes('This HTML widget could not be loaded'));
        await navigate(panels[1], 'back');
        assert.strictEqual(outputTitle(panels[1]), 'A');
        const stored = savedState.get(widgetHistoryKey) as WidgetHistory[];
        assert.strictEqual(stored[0].index, 0);
    });

    test('session info updates after process exit without reloading the widget or its history', async () => {
        const source = owner('html-history-exit');
        await show('/tmp/a.html', source);
        await show('/tmp/b.html', source);
        const html = panels[0].webview.html;
        source.processExited = true;
        assert.deepStrictEqual((panels[0].webview.postMessage as sinon.SinonStub).lastCall.args, [{
            message: 'viewer-session/update', text: 'R: (not attached)',
        }]);
        assert.strictEqual(panels[0].webview.html, html);
        await navigate(panels[0], 'back');
        assert.ok(widgetDocument(panels[0]).includes('/tmp/a.html'));
        assert.ok(panels[0].webview.html.includes('R: (not attached)'));
    });

    test('full widget documents keep scripts and styles in the iframe and escape their title', async () => {
        const source = owner('html-history-document');
        read.resolves('<!doctype html><html><head><style>body { margin: 0 }</style></head><body><script src="lib/widget.js"></script><div>Widget</div></body></html>');
        await show('/tmp/widget/index.html', source, '<Widget "title">');
        const document = widgetDocument(panels[0]);
        assert.ok(document.startsWith('<!doctype html><html><head><meta'));
        assert.ok(document.includes('<base href="file:///tmp/widget/">'));
        assert.ok(document.includes('<style>body { margin: 0 }</style>'));
        assert.ok(document.includes('src="lib/widget.js"'));
        assert.ok(document.includes('/dist/webviews/webview/widget.js'));
        assert.ok(panels[0].webview.html.includes('title="&lt;Widget &quot;title&quot;&gt;"'));
    });

    test('history is bounded to the latest 50 outputs', async () => {
        const source = owner('html-history-limit');
        for (let i = 0; i < 51; i++) { await show(`/tmp/widget-${i}.html`, source, `Widget ${i}`); }
        assert.ok(panels[0].webview.html.includes('50 / 50'));
        for (let i = 0; i < 49; i++) { await navigate(panels[0], 'back'); }
        assert.strictEqual(outputTitle(panels[0]), 'Widget 1');
        assert.ok(disabled(panels[0], 'back'));
    });
});
