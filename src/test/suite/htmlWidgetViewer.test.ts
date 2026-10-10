import * as assert from 'assert';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { HtmlViewerSessionAccess, initializeHtmlWidgetViewers, restoreHtmlViewer, runHtmlViewerCommand, showWebView, shutdownHtmlWidgetViewers } from '../../webViewer';
import { extensionContext } from '../../extension';
import { widgetHistoryKey, WidgetHistory } from '../../webViewer/history';
import type { HtmlViewerPanelState } from '../../webViewer/webviewMessages';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred } from '../common/sessionConnections';

suite('Session-aware HTML widget Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let read: sinon.SinonStub;
    const owners: session.Session[] = [];
    const panels: vscode.WebviewPanel[] = [];
    const receivers = new Map<vscode.WebviewPanel, (message: unknown) => Promise<void>>();
    let viewerManager: ReturnType<typeof initializeHtmlWidgetViewers>;
    let activePanel: vscode.WebviewPanel | undefined;
    let execute: sinon.SinonStub;
    let information: sinon.SinonStub;
    const contexts = new Map<string, unknown>();
    const viewEvents = new Map<vscode.WebviewPanel, vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>>();
    const savedState = new Map<string, unknown>();
    let trustedWorkspace: boolean;
    let workspaceRoots: string[];
    let autoLoad: boolean;
    const progressTasks: Array<{ messages: string[]; done: boolean }> = [];
    const viewerSessions: HtmlViewerSessionAccess = {
        resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
        getActiveSessionId: () => session.activeSession?.sessionId,
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        trustedWorkspace = false;
        workspaceRoots = [];
        autoLoad = true;
        progressTasks.length = 0;
        sandbox.stub(vscode.window, 'withProgress').callsFake((options, task) => {
            assert.strictEqual(options.location, vscode.ProgressLocation.Window);
            const state = { messages: [] as string[], done: false };
            progressTasks.push(state);
            return task({ report: update => { if (update.message) { state.messages.push(update.message); } } },
                { isCancellationRequested: false, onCancellationRequested: sandbox.stub() }).then(result => {
                state.done = true;
                return result;
            });
        });
        sandbox.stub(vscode.workspace, 'isTrusted').get(() => trustedWorkspace);
        sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => workspaceRoots.map((root, index) => ({
            uri: vscode.Uri.file(path.resolve(root)), name: 'HTML viewer test workspace', index,
        })));
        activePanel = undefined;
        contexts.clear();
        execute = sandbox.stub(vscode.commands, 'executeCommand').callThrough();
        execute.withArgs('setContext').callsFake((_command: string, key: string, value: unknown) => { contexts.set(key, value); return Promise.resolve(); });
        information = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        savedState.clear();
        (extensionContext.workspaceState.get as sinon.SinonStub).callsFake((key: string, fallback: unknown) => savedState.get(key) ?? fallback);
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake((key: string, value: unknown) => {
            savedState.set(key, JSON.parse(JSON.stringify(value)));
            return Promise.resolve();
        });
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        read = sandbox.stub(fs, 'readFile');
        read.callsFake(file => Promise.resolve(
            `<div>${String(file)}</div><script src="lib/widget.js"></script>`));
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title, _column, options) => {
            const disposed = new vscode.EventEmitter<void>();
            const viewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
            const listeners: Array<(message: unknown) => unknown> = [];
            let closed = false;
            let html = '';
            const webview = {
                get html() { return html; },
                set html(value: string) {
                    html = value;
                    const generation = Number(/data-generation="(\d+)"/.exec(value)?.[1]);
                    if (autoLoad && generation) {
                        queueMicrotask(() => { void receivers.get(panel)?.({ message: 'widget/loaded', generation }); });
                    }
                },
                options, cspSource: 'webview-test:',
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
                    listeners.push(listener);
                    return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
                },
                postMessage: sandbox.stub().resolves(true),
            };
            const panel = {
                title, viewType: 'r.htmlViewer', viewColumn: vscode.ViewColumn.Two,
                get active() { return activePanel === panel; },
                reveal: sandbox.stub().callsFake((_column: vscode.ViewColumn, preserveFocus: boolean) => {
                    if (!preserveFocus) { activate(panel); }
                }),
                get webview() {
                    assert.strictEqual(closed, false, 'Disposed panels must not be accessed');
                    return webview;
                },
                onDidDispose: disposed.event,
                onDidChangeViewState: viewState.event,
                dispose: () => {
                    if (closed) { return; }
                    closed = true; disposed.fire(); disposed.dispose(); viewState.dispose(); listeners.length = 0;
                },
            } as unknown as vscode.WebviewPanel;
            panels.push(panel);
            activePanel = panel;
            viewEvents.set(panel, viewState);
            receivers.set(panel, async message => { await Promise.all(listeners.map(listener => listener(message))); });
            return panel;
        });
    });

    teardown(async () => {
        panels.splice(0).forEach(panel => { panel.dispose(); });
        await shutdownHtmlWidgetViewers();
        receivers.clear();
        viewEvents.clear();
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
        const reference = panelReference(panel);
        const states = savedState.get('r.htmlViewer.panels') as HtmlViewerPanelState[];
        const state = states.find(state => state.id === reference.id)!;
        const item = state.history[state.index];
        assert.ok(panel.webview.html.includes(`<div>${item.file}</div>`), 'The retained title must belong to the rendered output');
        return item.title;
    }

    function widgetDocument(panel: vscode.WebviewPanel): string {
        assert.ok(!panel.webview.html.includes('widget-frame'), 'Outputs must render directly without the private iframe');
        return panel.webview.html;
    }

    function activate(panel?: vscode.WebviewPanel): void {
        activePanel = panel;
        for (const [viewer, emitter] of viewEvents) { emitter.fire({ webviewPanel: viewer }); }
    }

    function position(panel: vscode.WebviewPanel): string {
        const entry = [...viewerManager.viewers.values()].find(entry => entry.panel === panel)!;
        return `${entry.state.index + 1} / ${entry.state.history.length}`;
    }

    function panelReference(panel: vscode.WebviewPanel): { id: string } {
        const value = /data-viewer-state="([^"]*)"/.exec(panel.webview.html)![1].replace(/&quot;/g, '"');
        return JSON.parse(value) as { id: string };
    }

    async function reloadPanel(panel: vscode.WebviewPanel, reference = panelReference(panel)): Promise<void> {
        await shutdownHtmlWidgetViewers(true);
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        const serializer = (vscode.window.registerWebviewPanelSerializer as sinon.SinonStub).lastCall.args[1] as vscode.WebviewPanelSerializer;
        await serializer.deserializeWebviewPanel(panel, reference);
    }

    async function info(panel: vscode.WebviewPanel): Promise<string> {
        activate(panel);
        await runHtmlViewerCommand('info');
        const label = panel.title.startsWith('HTML Viewer · ') ? panel.title.slice('HTML Viewer · '.length) : '';
        await runHtmlViewerCommand('info');
        return label;
    }

    async function navigate(panel: vscode.WebviewPanel, direction: 'back' | 'forward', oldGeneration?: number): Promise<void> {
        if (oldGeneration !== undefined) {
            await receivers.get(panel)!({ message: 'widget/navigate', direction, generation: oldGeneration });
        } else {
            activate(panel);
            await runHtmlViewerCommand(direction);
        }
    }

    async function remove(panel: vscode.WebviewPanel): Promise<void> {
        activate(panel);
        await runHtmlViewerCommand('remove');
    }

    function disabled(panel: vscode.WebviewPanel, button: 'back' | 'forward' | 'remove'): boolean {
        activate(panel);
        const key = { back: 'canGoBack', forward: 'canGoForward', remove: 'canRemove' }[button];
        return contexts.get(`r.htmlViewer.${key}`) !== true;
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
            viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
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
        assert.ok(panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === vscode.Uri.file('/tmp/widget-c').fsPath));
        assert.deepStrictEqual((panels[0].reveal as sinon.SinonStub).lastCall.args, [vscode.ViewColumn.Two, true]);
        assert.ok((await info(panels[0])).includes(`R 4.6.1: ${first.pid}`));
        assert.ok((await info(panels[1])).includes(`R 4.6.1: ${second.pid}`));
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
        assert.ok(panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === vscode.Uri.file('/tmp/latest').fsPath));
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
        reconnected.host = source.host.toUpperCase();
        await show('/tmp/after/index.html', reconnected);
        assert.strictEqual(panels.length, 1);
        const restarted = owner('html-restarted');
        await show('/tmp/restarted/index.html', restarted);
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[0].webview.html.includes('/tmp/after/index.html'));
    });

    for (const change of ['host', 'pid'] as const) {
        test(`a reused session ID with a different ${change} gets its own panel and retained history`, async () => {
            const source = owner(`html-reused-${change}`);
            await show('/tmp/old.html', source, 'Old');
            const originalHtml = panels[0].webview.html;
            session.unregisterSessionTransport(source);
            const replacement = owner(source.sessionId);
            replacement.pid = change === 'pid' ? '98765' : source.pid;
            replacement.host = change === 'host' ? 'replacement-host' : source.host;
            await show('/tmp/new.html', replacement, 'New');
            assert.strictEqual(panels.length, 2);
            assert.strictEqual(panels[0].webview.html, originalHtml);
            assert.strictEqual(outputTitle(panels[1]), 'New');
            assert.strictEqual(position(panels[1]), '1 / 1');
            const retained = savedState.get(widgetHistoryKey) as WidgetHistory[];
            assert.strictEqual(retained.length, 1);
            assert.strictEqual(retained[0].source.host, replacement.host);
            assert.strictEqual(retained[0].source.pid, replacement.pid);
            assert.deepStrictEqual(retained[0].history.map(item => item.title), ['New']);

            // Closing the original panel must not overwrite the replacement's
            // history or remove it from the panel-reuse map.
            panels[0].dispose();
            await show('/tmp/next.html', replacement, 'Next');
            assert.strictEqual(panels.length, 2);
            assert.strictEqual(position(panels[1]), '2 / 2');
            panels[1].dispose();
            await restoreHtmlViewer(replacement.sessionId);
            assert.strictEqual(panels.length, 3);
            assert.strictEqual(outputTitle(panels[2]), 'Next');
            await navigate(panels[2], 'back');
            assert.strictEqual(outputTitle(panels[2]), 'New');
        });
    }

    test('disabled viewing opens externally without creating or changing a panel', async () => {
        const source = owner('html-disabled');
        const external = sandbox.stub(vscode.env, 'openExternal').resolves(true);
        await show('/tmp/widget/index.html', source, 'Viewer', false);
        assert.strictEqual(panels.length, 0);
        sinon.assert.calledOnce(external);
        sinon.assert.notCalled(read);
    });

    test('Find activates its owning panel and ignores stale requests without changing history', async () => {
        const command = execute.withArgs('editor.action.webvieweditor.showFind').resolves();
        const source = owner('html-find');
        await show('/tmp/a.html', source, 'A');
        const panel = panels[0];
        const previousGeneration = Number(/data-generation="(\d+)"/.exec(panel.webview.html)?.[1]);
        await show('/tmp/b.html', source, 'B');
        await show('/tmp/other.html', owner('html-find-other'), 'Other');
        const html = panel.webview.html;
        const currentGeneration = Number(/data-generation="(\d+)"/.exec(html)?.[1]);
        await receivers.get(panel)!({ message: 'widget/find', generation: previousGeneration });
        await receivers.get(panel)!({ message: 'widget/find' });
        sinon.assert.notCalled(command);
        const reveal = (panel as unknown as { reveal: sinon.SinonStub }).reveal;
        reveal.resetHistory();
        await receivers.get(panel)!({ message: 'widget/find', generation: currentGeneration });
        sinon.assert.calledOnceWithExactly(command, 'editor.action.webvieweditor.showFind');
        sinon.assert.calledOnceWithExactly(reveal, vscode.ViewColumn.Two, false);
        assert.strictEqual(panel.webview.html, html);
        assert.strictEqual(position(panel), '2 / 2');
        panel.dispose();
        await receivers.get(panel)!({ message: 'widget/find', generation: currentGeneration });
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
        assert.strictEqual(position(panel), '2 / 2');
        const roots = panel.webview.options.localResourceRoots;
        assert.ok(!roots?.some(root => root.fsPath === vscode.Uri.file('/tmp/other').fsPath));
        await navigate(panel, 'back');
        assert.strictEqual(panel.webview.options.localResourceRoots, roots, 'Back must not change permissions or reload the previous document');
        assert.strictEqual(outputTitle(panel), 'A');
        assert.ok(widgetDocument(panel).includes('/tmp/a/index.html'));
        assert.ok(panel.webview.options.localResourceRoots?.some(root => root.fsPath === vscode.Uri.file('/tmp/a').fsPath));
        assert.ok(disabled(panel, 'back') && !disabled(panel, 'forward'));
        const firstHtml = panel.webview.html;
        await navigate(panel, 'back');
        assert.strictEqual(panel.webview.html, firstHtml);
        await navigate(panel, 'forward');
        assert.strictEqual(panel.webview.options.localResourceRoots, roots, 'Forward must not change permissions or reload the previous document');
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
        assert.strictEqual(position(panels[0]), '3 / 3');
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'B');
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'A');
    });

    test('removing output revokes its resource directory without affecting another session', async () => {
        const source = owner('html-remove-resource-root');
        await show('/tmp/a/index.html', source, 'A');
        await show('/tmp/b/index.html', source, 'B');
        await show('/tmp/other/index.html', owner('html-resource-other'), 'Other');
        const otherRoots = panels[1].webview.options.localResourceRoots;
        await remove(panels[0]);
        const roots = panels[0].webview.options.localResourceRoots!;
        assert.ok(roots.some(root => root.fsPath === vscode.Uri.file('/tmp/a').fsPath));
        assert.ok(!roots.some(root => root.fsPath === vscode.Uri.file('/tmp/b').fsPath));
        assert.strictEqual(panels[1].webview.options.localResourceRoots, otherRoots);
        await remove(panels[0]);
        assert.ok(!panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === vscode.Uri.file('/tmp/a').fsPath));
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
        assert.strictEqual(position(panels[0]), '1 / 2');
        assert.ok(disabled(panels[0], 'back') && !disabled(panels[0], 'forward'));
        assert.ok(!disabled(panels[0], 'remove'));
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
        assert.strictEqual(position(panels[0]), '1 / 2');
        await navigate(panels[0], 'forward');
        await remove(panels[0]);
        assert.strictEqual(outputTitle(panels[0]), 'B');
        assert.strictEqual(position(panels[0]), '1 / 1');
        assert.ok(disabled(panels[0], 'back') && disabled(panels[0], 'forward'));
    });

    test('removing the last entry clears persisted history and keeps an empty Viewer ready for new output', async () => {
        const source = owner('html-remove-empty');
        await show('/tmp/a.html', source, 'A');
        await remove(panels[0]);
        assert.strictEqual(panels[0].title, 'HTML Viewer');
        assert.ok(widgetDocument(panels[0]).includes('No HTML outputs in this session'));
        assert.strictEqual(position(panels[0]), '0 / 0');
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
        assert.strictEqual(position(panels[0]), '1 / 1');
        assert.ok(!disabled(panels[0], 'remove'));
    });

    test('removed entries stay removed after closing, extension-host recreation, and restoration', async () => {
        const source = owner('html-remove-reload');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await remove(panels[0]);
        panels[0].dispose();
        await shutdownHtmlWidgetViewers();
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(outputTitle(panels[1]), 'A');
        assert.strictEqual(position(panels[1]), '1 / 1');
        await remove(panels[1]);
        panels[1].dispose();
        await shutdownHtmlWidgetViewers();
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        information.resetHistory();
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2, 'Deleted history must not reopen a Viewer');
        sinon.assert.calledOnce(information);
    });

    test('late removal renders cannot replace or delete newer output', async () => {
        const source = owner('html-remove-stale');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        const slow = deferred<string>();
        read.onCall(2).returns(slow.promise);
        const pending = remove(panels[0]);
        await show('/tmp/c.html', source, 'C');
        const latest = panels[0].webview.html;
        slow.resolve('<div>A</div>');
        await pending;
        assert.strictEqual(panels[0].webview.html, latest);
        assert.strictEqual(outputTitle(panels[0]), 'C');
        assert.strictEqual(position(panels[0]), '2 / 2');
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'A');
    });

    test('late history loads and stale document navigation cannot replace newer output', async () => {
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
        assert.strictEqual(position(panels[1]), '1 / 2');
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
        information.resetHistory();
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
        assert.strictEqual(position(panels[1]), '3 / 3');
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
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        const reconnected = owner(source.sessionId);
        reconnected.pid = source.pid;
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(outputTitle(panels[1]), 'A');
        assert.strictEqual(position(panels[1]), '1 / 2');
        assert.ok((await info(panels[1])).includes(`R 4.6.1: ${source.pid}`));
        await navigate(panels[1], 'forward');
        assert.strictEqual(outputTitle(panels[1]), 'B');
        await show('/tmp/c.html', reconnected, 'C');
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(position(panels[1]), '3 / 3');
    });

    test('reload rebinds the original tab, history selection, Info state, and exit listener', async () => {
        const source = owner('html-reload-original');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await navigate(panels[0], 'back');
        await runHtmlViewerCommand('info');
        const panel = panels[0];
        (panel.reveal as sinon.SinonStub).resetHistory();
        await reloadPanel(panel);
        assert.strictEqual(panels.length, 1, 'Reload must rebind the original panel');
        assert.strictEqual(position(panel), '1 / 2');
        assert.ok(panel.webview.html.includes('/tmp/a.html'));
        assert.strictEqual(panel.title, `HTML Viewer · R 4.6.1: ${source.pid}`);
        assert.strictEqual((panel.reveal as sinon.SinonStub).callCount, 0);
        await runHtmlViewerCommand('forward');
        assert.strictEqual(position(panel), '2 / 2');
        source.processExited = true;
        assert.strictEqual(panel.title, 'HTML Viewer · R: (not attached)');
    });

    test('reload cannot bring back an output removed from the last history entry', async () => {
        const source = owner('html-reload-empty');
        await show('/tmp/a.html', source, 'A');
        const reference = panelReference(panels[0]);
        await remove(panels[0]);
        const reads = read.callCount;
        await reloadPanel(panels[0], reference);
        assert.strictEqual(position(panels[0]), '0 / 0');
        assert.ok(panels[0].webview.html.includes('No HTML outputs'));
        assert.strictEqual(read.callCount, reads);
        await show('/tmp/b.html', source, 'B');
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(position(panels[0]), '1 / 1');
    });

    test('reload preserves an open exited viewer without restoring its closed-session history', async () => {
        const source = owner('html-reload-exited');
        await show('/tmp/a.html', source, 'A');
        await runHtmlViewerCommand('info');
        source.processExited = true;
        source.pid = ''; source.rVer = '';
        await reloadPanel(panels[0]);
        assert.strictEqual(panels[0].title, 'HTML Viewer · R: (not attached)');
        assert.ok(panels[0].webview.html.includes('/tmp/a.html'));
        assert.deepStrictEqual(savedState.get(widgetHistoryKey), []);
        panels[0].dispose();
        await restoreHtmlViewer(source.sessionId);
        assert.strictEqual(panels.length, 1, 'An exited process must not regain retained history');
    });

    test('reload keeps reused session IDs with different PIDs bound to their own processes', async () => {
        const original = owner('html-reload-reused');
        await show('/tmp/old.html', original, 'Old');
        await runHtmlViewerCommand('info');
        const reference = panelReference(panels[0]);
        session.unregisterSessionTransport(original);
        const replacement = owner(original.sessionId);
        replacement.pid = '98765';
        await show('/tmp/new.html', replacement, 'New');
        await reloadPanel(panels[0], reference);
        activate(panels[0]);
        assert.strictEqual(panels[0].title, `HTML Viewer · R 4.6.1: ${original.pid}`);
        assert.ok(panels[0].webview.html.includes('/tmp/old.html'));
        assert.strictEqual(viewerManager.histories.entries.get(replacement.sessionId)?.source.pid, replacement.pid);
        original.processExited = true;
        assert.strictEqual(panels[0].title, 'HTML Viewer · R: (not attached)');
        assert.strictEqual(viewerManager.histories.entries.get(replacement.sessionId)?.source.pid, replacement.pid);
    });

    test('reload ignores output-supplied paths and restores standalone HTML into its original panel', async () => {
        await showWebView('/tmp/standalone.html', 'Standalone', 'Two');
        const reference = { ...panelReference(panels[0]), history: [{ file: '/tmp/forged.html', title: 'Forged' }], index: 0 };
        await reloadPanel(panels[0], reference);
        assert.strictEqual(panels.length, 1);
        assert.ok(panels[0].webview.html.includes('/tmp/standalone.html'));
        assert.ok(!panels[0].webview.html.includes('/tmp/forged.html'));
        assert.strictEqual(panels[0].title, 'HTML Viewer');
    });

    test('a pending pre-reload render cannot overwrite the rebound original panel', async () => {
        const source = owner('html-reload-pending');
        await show('/tmp/a.html', source, 'A');
        const slow = deferred<string>();
        read.onCall(1).returns(slow.promise);
        const pending = show('/tmp/b.html', source, 'B');
        await reloadPanel(panels[0]);
        const latest = panels[0].webview.html;
        assert.ok(latest.includes('/tmp/b.html'));
        slow.resolve('<div>Obsolete pre-reload render</div>');
        await pending;
        assert.strictEqual(panels[0].webview.html, latest);
        assert.strictEqual(position(panels[0]), '2 / 2');
    });

    test('output arriving before deserialization merges into the original tab without leaving a duplicate viewer', async () => {
        const source = owner('html-reload-notification');
        await show('/tmp/a.html', source, 'A');
        const original = panels[0];
        const reference = panelReference(original);
        await shutdownHtmlWidgetViewers(true);
        viewerManager = initializeHtmlWidgetViewers(extensionContext, viewerSessions);
        await show('/tmp/b.html', source, 'B');
        const serializer = (vscode.window.registerWebviewPanelSerializer as sinon.SinonStub).lastCall.args[1] as vscode.WebviewPanelSerializer;
        await serializer.deserializeWebviewPanel(original, reference);
        activate(original);
        assert.strictEqual(viewerManager.viewers.size, 1);
        assert.strictEqual([...viewerManager.viewers.values()][0].panel, original);
        assert.strictEqual(position(original), '2 / 2');
        assert.ok(original.webview.html.includes('/tmp/b.html'));
        await navigate(original, 'back');
        assert.ok(original.webview.html.includes('/tmp/a.html'));
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
        assert.ok((await info(panels[1])).includes(`R 4.6.1: ${source.pid}`));
        assert.ok(!(await info(panels[1])).includes(`R 4.6.1: ${other.pid}`));
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
        assert.ok((await info(panels[2])).includes(`R 4.6.1: ${second.pid}`));
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

    test('visible session info updates immediately after process exit without reloading the widget', async () => {
        const source = owner('html-history-exit');
        await show('/tmp/a.html', source);
        await show('/tmp/b.html', source);
        activate(panels[0]);
        await runHtmlViewerCommand('info');
        const html = panels[0].webview.html;
        const reads = read.callCount;
        source.processExited = true;
        assert.strictEqual(panels[0].title, 'HTML Viewer · R: (not attached)');
        assert.strictEqual(panels[0].webview.html, html);
        assert.strictEqual(read.callCount, reads);
        await navigate(panels[0], 'back');
        assert.ok(widgetDocument(panels[0]).includes('/tmp/a.html'));
        assert.strictEqual(panels[0].title, 'HTML Viewer · R: (not attached)');
        await runHtmlViewerCommand('info');
        assert.strictEqual(panels[0].title, 'HTML Viewer');
        assert.strictEqual(await info(panels[0]), 'R: (not attached)');
    });

    test('process exit respects hidden Info and updates only its originating background tab', async () => {
        const source = owner('html-background-exit');
        await show('/tmp/a.html', source);
        activate(panels[0]);
        await runHtmlViewerCommand('info');
        const other = owner('html-background-alive');
        await show('/tmp/other.html', other);
        await runHtmlViewerCommand('info');
        source.processExited = true;
        assert.strictEqual(panels[0].title, 'HTML Viewer · R: (not attached)');
        assert.strictEqual(panels[1].title, `HTML Viewer · R 4.6.1: ${other.pid}`);
        await runHtmlViewerCommand('info');
        other.processExited = true;
        assert.strictEqual(panels[1].title, 'HTML Viewer');
        assert.strictEqual(await info(panels[1]), 'R: (not attached)');
    });

    test('closing a panel releases its title exit subscription', async () => {
        const source = owner('html-title-exit-dispose');
        const context = session.getViewerSessionContext(source.sessionId)!;
        const observe = sandbox.spy(context, 'observeExit');
        await showWebView('/tmp/a.html', 'A', 'Two', context);
        const dispose = sandbox.spy(observe.lastCall.returnValue, 'dispose');
        panels[0].dispose();
        sinon.assert.calledOnce(dispose);
    });

    test('full widget documents retain scripts, styles, and authored titles without an iframe', async () => {
        const source = owner('html-history-document');
        read.resolves('<!doctype html><html><head><title>Authored &amp; original</title><style>body { margin: 0 }</style></head><body><script src="lib/widget.js"></script><div>Widget</div></body></html>');
        await show('/tmp/widget/index.html', source, '<Widget "title">');
        const document = widgetDocument(panels[0]);
        assert.ok(document.startsWith('<!doctype html><html><head><meta'));
        assert.ok(document.includes('<base href="file:///tmp/widget/">'));
        assert.ok(document.includes('<style>body { margin: 0 }</style>'));
        assert.ok(document.includes('src="lib/widget.js"'));
        assert.ok(document.includes('/dist/webviews/webview/index.js'));
        assert.ok(document.includes('<title>Authored &amp; original</title>'));
        assert.ok(!document.includes('&lt;Widget &quot;title&quot;&gt;'));
        assert.strictEqual(panels[0].title, 'HTML Viewer');
    });

    test('viewer resources are inserted without rewriting the original HTML source', async () => {
        const original = `<!doctype html><!-- <head></body> --><html><HEAD data-example=">">
            <title>Original title</title><style>p::after { content: '</body>'; }</style>
            </HEAD><BODY><svg><title>Accessible chart</title></svg>
            <script>const example = '</body>'; const markup = '<svg><title>Template</title></svg>';</script>
            <textarea><head></body></textarea></BODY></html>`;
        read.resolves(original);
        await showWebView('/tmp/document.html', 'History title', 'Two');
        const rendered = panels[0].webview.html;
        const headStart = original.indexOf('<HEAD data-example=">">') + '<HEAD data-example=">">'.length;
        const headEnd = rendered.indexOf('\n            <title>Original title</title>', headStart);
        const scriptStart = rendered.lastIndexOf('<script src=');
        const scriptEnd = rendered.indexOf('</script>', scriptStart) + '</script>'.length;
        assert.ok(rendered.slice(headStart, headEnd).startsWith('<meta http-equiv="Content-Security-Policy"'));
        assert.ok(rendered.slice(scriptStart, scriptEnd).includes('/dist/webviews/webview/index.js'));
        assert.strictEqual(rendered.slice(0, headStart) + rendered.slice(headEnd, scriptStart) + rendered.slice(scriptEnd), original);
    });

    test('fragments without a document title do not receive the history title', async () => {
        await showWebView('/tmp/fragment.html', 'History title', 'Two');
        assert.ok(panels[0].webview.html.includes('<div>/tmp/fragment.html</div>'));
        assert.ok(!panels[0].webview.html.includes('<title>'));
    });

    test('local authored bases resolve against the HTML file and allow their resource directories', async () => {
        const file = path.resolve('/tmp/output/index.html');
        for (const fixture of [
            { href: 'assets/', target: '/tmp/output/assets/', root: '/tmp/output/assets' },
            { href: '', target: '/tmp/output/index.html', root: '/tmp/output' },
            { href: vscode.Uri.file(path.resolve('/tmp/output/assets.html')).toString(), target: '/tmp/output/assets.html', root: '/tmp/output' },
            { href: 'data:text/plain,ignored', target: '/tmp/output/index.html', root: '/tmp/output' },
            { href: 'https://[', target: '/tmp/output/index.html', root: '/tmp/output' },
        ]) {
            read.resolves(`<!doctype html><html><head><base target="_self"><base HREF='${fixture.href}' data-authored="yes"><base href="ignored/"></head><body>Output</body></html>`);
            await showWebView(file, 'Authored base', 'Two');
            const panel = panels[panels.length - 1];
            let expected = vscode.Uri.file(path.resolve(fixture.target)).toString();
            if (fixture.target.endsWith('/') && !expected.endsWith('/')) { expected += '/'; }
            assert.ok(panel.webview.html.includes(`<base href="${expected}" data-authored="yes">`), fixture.href);
            assert.ok(panel.webview.html.includes('<base target="_self">'));
            assert.ok(panel.webview.html.includes('<base href="ignored/">'));
            assert.strictEqual((panel.webview.html.match(/<base /g) ?? []).length, 3);
            assert.ok(panel.webview.options.localResourceRoots?.some(uri => uri.fsPath === vscode.Uri.file(path.resolve(fixture.root)).fsPath), fixture.href);
        }
    });

    test('authored bases cannot grant access to the filesystem root or unrelated directories', async () => {
        const file = path.resolve('/tmp/output/index.html');
        for (const href of ['/', '../', '../../', '../output-other/', '../shared%20assets/',
            vscode.Uri.file(path.resolve('/tmp/external/')).toString() + '/']) {
            read.resolves(`<html><head><base href="${href}"></head><body>Output</body></html>`);
            await showWebView(file, 'Untrusted base', 'Two');
            assert.deepStrictEqual(panels[panels.length - 1].webview.options.localResourceRoots?.map(uri => uri.fsPath), [
                vscode.Uri.file(path.dirname(file)).fsPath,
                vscode.Uri.file(path.join(extensionContext.extensionPath, 'dist/webviews/webview')).fsPath,
            ], href);
        }
    });

    test('shared authored dependencies require a trusted workspace containing their directory', async () => {
        workspaceRoots = ['/tmp'];
        for (const trusted of [false, true]) {
            trustedWorkspace = trusted;
            read.resolves('<html><head><base href="../shared%20assets/"></head><body>Output</body></html>');
            await showWebView(path.resolve('/tmp/output/index.html'), 'Shared dependencies', 'Two');
            const roots = panels[panels.length - 1].webview.options.localResourceRoots!;
            assert.strictEqual(roots.some(uri => uri.fsPath === vscode.Uri.file(path.resolve('/tmp/shared assets')).fsPath), trusted);
        }
        trustedWorkspace = true;
        workspaceRoots = ['/tmp/output'];
        await showWebView(path.resolve('/tmp/output/index.html'), 'Outside trusted workspace', 'Two');
        assert.strictEqual(panels[panels.length - 1].webview.options.localResourceRoots?.length, 2);
    });

    test('authored local bases use webview URIs while resource roots retain file URIs', async () => {
        trustedWorkspace = true;
        workspaceRoots = ['/tmp'];
        const source = owner('html-authored-base-uri');
        const file = path.resolve('/tmp/output/index.html');
        await show(file, source);
        sandbox.stub(panels[0].webview, 'asWebviewUri').callsFake(uri => uri.with({ scheme: 'https', authority: 'widget-local.test' }));
        read.resolves('<html><head><base href="../shared%20assets/" target="_self"></head><body>Output</body></html>');
        await show(file, source);
        const expected = vscode.Uri.file(path.resolve('/tmp/shared assets')).with({ scheme: 'https', authority: 'widget-local.test' }).toString() + '/';
        assert.ok(panels[0].webview.html.includes(`<base href="${expected}" target="_self">`));
        assert.ok(panels[0].webview.options.localResourceRoots?.some(uri => uri.scheme === 'file' && uri.fsPath === vscode.Uri.file(path.resolve('/tmp/shared assets')).fsPath));
    });

    test('retained authored resource roots are rechecked when workspace trust changes', async () => {
        const source = owner('html-authored-base-trust');
        trustedWorkspace = true;
        workspaceRoots = ['/tmp'];
        read.resolves('<html><head><base href="../shared assets/"></head><body>Output</body></html>');
        await show('/tmp/output/index.html', source);
        const shared = vscode.Uri.file(path.resolve('/tmp/shared assets')).fsPath;
        assert.ok(panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === shared));
        trustedWorkspace = false;
        read.resolves('<html><body>Next output</body></html>');
        await show('/tmp/next/index.html', source);
        assert.ok(!panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === shared));
        await navigate(panels[0], 'back');
        assert.ok(!panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === shared));
    });

    test('absolute web bases and their authored attributes are preserved', async () => {
        const original = "<base HREF='https://cdn.example.test/assets/?v=1&amp;mode=all' target='_self' data-authored='yes'>";
        read.resolves(`<html><head>${original}</head><body>Output</body></html>`);
        await showWebView('/tmp/output/index.html', 'Remote base', 'Two');
        assert.ok(panels[0].webview.html.includes(original));
        assert.strictEqual((panels[0].webview.html.match(/<base /g) ?? []).length, 1);
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.length, 2);
    });

    test('bases in templates, SVGs, comments, and script strings do not suppress the directory base', async () => {
        const content = `<!-- <base href="comment/"> --><template><base href="template/"></template>
            <svg><base href="svg/"></base></svg><script>const example = '<base href="script/">';</script>`;
        read.resolves(`<html><head><base target="_self"></head><body>${content}</body></html>`);
        await showWebView('/tmp/output/index.html', 'No effective base', 'Two');
        assert.ok(panels[0].webview.html.includes('<base href="file:///tmp/output/">'));
        assert.ok(panels[0].webview.html.includes(content));
        assert.ok(panels[0].webview.html.includes('<base target="_self">'));
    });

    test('native commands target the active HTML panel and clear enablement when focus leaves it', async () => {
        const first = owner('native-first');
        await show('/tmp/a.html', first, 'A');
        await show('/tmp/b.html', first, 'B');
        await show('/tmp/other.html', owner('native-other'), 'Other');
        assert.ok(disabled(panels[1], 'back'));
        await runHtmlViewerCommand('back');
        assert.strictEqual(outputTitle(panels[0]), 'B');
        assert.strictEqual(outputTitle(panels[1]), 'Other');
        activate(panels[0]);
        assert.strictEqual(contexts.get('r.htmlViewer.canGoBack'), true);
        await runHtmlViewerCommand('back');
        assert.strictEqual(outputTitle(panels[0]), 'A');
        assert.strictEqual(outputTitle(panels[1]), 'Other');
        assert.strictEqual(contexts.get('r.htmlViewer.canGoBack'), false);
        assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), true);
        activate();
        assert.ok([...contexts.values()].every(value => value === false));
        await runHtmlViewerCommand('remove');
        assert.strictEqual(position(panels[0]), '1 / 2');
    });

    test('native actions are disabled while rendering and repeated actions cannot skip outputs', async () => {
        const source = owner('native-loading');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        const slow = deferred<string>();
        autoLoad = false;
        const previousGeneration = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        read.onCall(2).returns(slow.promise);
        activate(panels[0]);
        const pending = runHtmlViewerCommand('back');
        assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)));
        assert.strictEqual(contexts.get('r.htmlViewer.canShowInfo'), true);
        await runHtmlViewerCommand('remove');
        await runHtmlViewerCommand('forward');
        slow.resolve('<div>/tmp/a.html</div>');
        await pending;
        assert.strictEqual(position(panels[0]), '1 / 2');
        assert.strictEqual(outputTitle(panels[0]), 'A');
        assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)),
            'Sending HTML does not mean the browser has loaded it');
        await receivers.get(panels[0])!({ message: 'widget/loaded', generation: previousGeneration });
        assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), false, 'Ignore readiness from the previous document');
        await runHtmlViewerCommand('forward');
        assert.strictEqual(position(panels[0]), '1 / 2', 'Ignore clicks until the replacement has loaded');
        const generation = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        await receivers.get(panels[0])!({ message: 'widget/loaded', generation });
        assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), true);
    });

    test('missing acknowledgements unlock navigation after five seconds and late readiness clears progress', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const source = owner('html-load-timeout');
        await show('/tmp/a.html', source, 'A');
        autoLoad = false;
        read.onCall(1).resolves('<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body>Blocked acknowledgement</body></html>');
        await show('/tmp/b.html', source, 'B');
        const panel = panels[0];
        const html = panel.webview.html;
        const task = progressTasks.at(-1)!;
        assert.deepStrictEqual(task.messages, ['HTML Viewer: Loading HTML output…']);
        clock.tick(4999);
        assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panel, button)));
        clock.tick(1);
        assert.strictEqual(disabled(panel, 'back'), false);
        assert.strictEqual(disabled(panel, 'remove'), false);
        assert.strictEqual(panel.webview.html, html, 'Timeout must preserve the rendered content');
        assert.strictEqual(task.messages.at(-1), 'HTML Viewer: Still loading. Navigation is available.');
        assert.strictEqual(task.done, false, 'Timeout releases navigation without claiming loading completed');
        const generation = Number(/data-generation="(\d+)"/.exec(html)?.[1]);
        await receivers.get(panel)!({ message: 'widget/loaded', generation });
        assert.strictEqual(task.done, true, 'Readiness after the timeout must still dismiss progress');
        assert.strictEqual(clock.countTimers(), 0);
        await navigate(panel, 'back');
        clock.tick(5000);
        assert.strictEqual(disabled(panel, 'forward'), false);
        autoLoad = true;
        await navigate(panel, 'forward');
        assert.strictEqual(position(panel), '2 / 2');
        await remove(panel);
        assert.strictEqual(position(panel), '1 / 1');
    });

    for (const preparationTime of [4500, 10000]) {
        test(`a ${preparationTime}ms HTML read keeps navigation disabled and leaves five seconds for browser loading`, async () => {
            const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const source = owner('html-read-timeout');
            await show('/tmp/a.html', source, 'A');
            const previous = panels[0].webview.html;
            const slow = deferred<string>();
            autoLoad = false;
            read.onCall(1).returns(slow.promise);
            const pending = show('/tmp/b.html', source, 'B');
            const task = progressTasks.at(-1)!;
            clock.tick(preparationTime);
            assert.strictEqual(panels[0].webview.html, previous);
            assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)));
            assert.deepStrictEqual(task.messages, ['HTML Viewer: Loading HTML output…']);
            assert.strictEqual(clock.countTimers(), 0, 'Preparation must not start the browser timeout');
            await navigate(panels[0], 'back');
            await remove(panels[0]);
            assert.strictEqual(position(panels[0]), '2 / 2');
            slow.resolve('<div>/tmp/b.html</div>');
            await pending;
            assert.strictEqual(outputTitle(panels[0]), 'B');
            clock.tick(4999);
            assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)));
            clock.tick(1);
            assert.strictEqual(disabled(panels[0], 'back'), false);
            assert.strictEqual(task.messages.at(-1), 'HTML Viewer: Still loading. Navigation is available.');
            autoLoad = true;
            await navigate(panels[0], 'back');
            assert.strictEqual(outputTitle(panels[0]), 'A');
            assert.ok(progressTasks.every(task => task.done));
            assert.strictEqual(clock.countTimers(), 0);
        });
    }

    test('superseded loads get their own deadline and stale readiness cannot dismiss current progress', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const source = owner('html-timeout-generation');
        autoLoad = false;
        await show('/tmp/a.html', source, 'A');
        const generation = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        clock.tick(4000);
        await show('/tmp/b.html', source, 'B');
        const task = progressTasks.at(-1)!;
        assert.strictEqual(progressTasks[0].done, true);
        clock.tick(1000);
        await receivers.get(panels[0])!({ message: 'widget/loaded', generation });
        assert.strictEqual(task.done, false);
        assert.strictEqual(disabled(panels[0], 'back'), true);
        clock.tick(4000);
        assert.strictEqual(disabled(panels[0], 'back'), false);
        panels[0].dispose();
        await Promise.resolve();
        assert.strictEqual(task.done, true);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('successful loads and definitive file failures stop progress and cancel the timeout', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const source = owner('html-load-progress');
        await show('/tmp/a.html', source, 'A');
        assert.strictEqual(progressTasks[0].done, true);
        autoLoad = false;
        read.onCall(1).rejects(new Error('missing file'));
        await show('/tmp/missing.html', source, 'Missing');
        assert.ok(widgetDocument(panels[0]).includes('This HTML widget could not be loaded'));
        assert.strictEqual(disabled(panels[0], 'back'), false);
        assert.ok(progressTasks.every(task => task.done));
        assert.strictEqual(clock.countTimers(), 0);
        read.onCall(2).rejects(new Error('unowned file failure'));
        await assert.rejects(showWebView('/tmp/unowned.html', 'Unowned', 'Two'), /unowned file failure/);
        assert.ok(progressTasks.every(task => task.done));
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('disposing a viewer or shutting down during loading cancels progress and its timer', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        autoLoad = false;
        await show('/tmp/a.html', owner('html-dispose-progress'), 'A');
        panels[0].dispose();
        await Promise.resolve();
        assert.strictEqual(progressTasks[0].done, true);
        assert.strictEqual(clock.countTimers(), 0);
        await show('/tmp/b.html', owner('html-shutdown-progress'), 'B');
        await shutdownHtmlWidgetViewers(true);
        assert.ok(progressTasks.every(task => task.done));
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('late load acknowledgements cannot enable navigation for a newer document', async () => {
        const source = owner('html-loading-generation');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        autoLoad = false;
        await navigate(panels[0], 'back');
        const previousGeneration = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        await show('/tmp/c.html', source, 'C');
        await receivers.get(panels[0])!({ message: 'widget/loaded', generation: previousGeneration });
        assert.ok((['back', 'forward', 'remove'] as const).every(button => disabled(panels[0], button)));
        await navigate(panels[0], 'back');
        assert.strictEqual(outputTitle(panels[0]), 'C');
        const generation = Number(/data-generation="(\d+)"/.exec(panels[0].webview.html)?.[1]);
        await receivers.get(panels[0])!({ message: 'widget/loaded', generation });
        assert.strictEqual(contexts.get('r.htmlViewer.canGoBack'), true);
        assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), false);
    });

    test('Info contains only the originating R version and PID without a popup or output reload', async () => {
        const source = owner('native-info-source');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/other.html', owner('native-info-other'), 'Other');
        const html = panels[0].webview.html;
        let details = await info(panels[0]);
        assert.strictEqual(details, `R 4.6.1: ${source.pid}`);
        source.processExited = true;
        details = await info(panels[0]);
        assert.strictEqual(details, 'R: (not attached)');
        sinon.assert.notCalled(information);
        assert.strictEqual(panels[0].webview.html, html);
    });

    test('Info toggles each tab independently and stays visible through navigation and new output', async () => {
        const source = owner('native-info-toggle');
        await show('/tmp/a.html', source, 'A');
        await show('/tmp/b.html', source, 'B');
        await show('/tmp/other.html', owner('native-info-toggle-other'), 'Other');
        const panel = panels[0];
        activate(panel);
        const html = panel.webview.html;
        const reads = read.callCount;
        await runHtmlViewerCommand('info');
        const title = `HTML Viewer · R 4.6.1: ${source.pid}`;
        assert.strictEqual(panel.title, title);
        assert.strictEqual(panels[1].title, 'HTML Viewer');
        assert.strictEqual(panel.webview.html, html);
        assert.strictEqual(read.callCount, reads);
        await runHtmlViewerCommand('back');
        assert.strictEqual(panel.title, title);
        await show('/tmp/c.html', source, 'C');
        assert.strictEqual(panel.title, title);
        await runHtmlViewerCommand('remove');
        assert.strictEqual(panel.title, title);
        await runHtmlViewerCommand('info');
        assert.strictEqual(panel.title, 'HTML Viewer');
        sinon.assert.notCalled(information);
    });

    test('unowned output disables history and Info actions without changing its title', async () => {
        await showWebView('/tmp/unowned.html', 'Unowned', 'Two');
        activate(panels[0]);
        assert.ok([...contexts.values()].every(value => value === false));
        assert.strictEqual(await info(panels[0]), '');
        sinon.assert.notCalled(information);
        const html = panels[0].webview.html;
        await runHtmlViewerCommand('remove');
        assert.strictEqual(panels[0].webview.html, html);
    });

    test('native toolbar contributes four HTML-specific commands with distinct icons and ordering', () => {
        const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
            contributes: {
                menus: { 'editor/title': Array<{ command?: string; when: string; group: string }> };
                commands: Array<{ command: string; title: string; icon: string }>;
            };
        };
        const entries = manifest.contributes.menus['editor/title'].filter(item => item.command?.startsWith('r.htmlViewer.'));
        assert.deepStrictEqual(entries.map(item => item.command),
            ['r.htmlViewer.back', 'r.htmlViewer.forward', 'r.htmlViewer.remove', 'r.htmlViewer.info']);
        assert.strictEqual(manifest.contributes.commands.find(command => command.command === 'r.htmlViewer.info')?.title, 'Toggle Session Information in Tab Title');
        for (const [index, item] of entries.entries()) {
            assert.strictEqual(item.when, "activeWebviewPanelId == 'r.htmlViewer'");
            assert.strictEqual(item.group, index < 2 ? `navigation@${index + 1}` : `htmlViewer@${index - 1}`);
            const command = manifest.contributes.commands.find(command => command.command === item.command)!;
            if (item.command !== 'r.htmlViewer.info') { assert.ok(command.title.includes('HTML')); }
            assert.ok(['$(arrow-circle-left)', '$(arrow-circle-right)', '$(trash)', '$(info)'].includes(command.icon));
        }
    });

    test('history is bounded to the latest 50 outputs', async () => {
        const source = owner('html-history-limit');
        for (let i = 0; i < 51; i++) { await show(`/tmp/widget-${i}/index.html`, source, `Widget ${i}`); }
        assert.strictEqual(position(panels[0]), '50 / 50');
        assert.ok(!panels[0].webview.options.localResourceRoots?.some(root => root.fsPath === vscode.Uri.file('/tmp/widget-0').fsPath));
        assert.strictEqual(panels[0].webview.options.localResourceRoots?.length, 51, 'Only 50 output directories and viewer assets remain');
        for (let i = 0; i < 49; i++) { await navigate(panels[0], 'back'); }
        assert.strictEqual(outputTitle(panels[0]), 'Widget 1');
        assert.ok(disabled(panels[0], 'back'));
    });
});
