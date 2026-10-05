import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { mockExtensionContext } from '../common/mockvscode';
import * as extension from '../../extension';
import * as session from '../../session';
import { GlobalEnvItem } from '../../workspaceViewer';

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for viewer state');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

suite('List viewer panels', () => {
    let sandbox: sinon.SinonSandbox;
    const panels: vscode.WebviewPanel[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        const root = path.join(__dirname, '..', '..', '..');
        mockExtensionContext(root, sandbox);
        session.deploySessionWatcher(root);
    });

    teardown(() => {
        panels.splice(0).forEach(panel => { panel.dispose(); });
        sandbox.restore();
    });

    for (const source of ['list', 'table']) {
        test(`reopens a disposed ${source} viewer using real VS Code panels`, async () => {
            const create = sandbox.spy(vscode.window, 'createWebviewPanel');
            const viewId = `test-real-${source}`;
            const open = async () => {
                try {
                    await session.showDataView(source, 'json', 'x', '', 'Two', viewId);
                } finally {
                    for (const panel of create.returnValues) {
                        if (!panels.includes(panel)) {
                            panels.push(panel);
                        }
                    }
                }
            };

            await open();
            await open();
            sinon.assert.calledOnce(create);
            create.firstCall.returnValue.dispose();
            await open();
            sinon.assert.calledTwice(create);
            assert.notStrictEqual(create.firstCall.returnValue, create.secondCall.returnValue);
            create.secondCall.returnValue.dispose();
            await open();
            sinon.assert.calledThrice(create);
        });

        test(`handles pending ${source} requests when a real VS Code panel closes`, async () => {
            const panel = vscode.window.createWebviewPanel('dataview', 'x', vscode.ViewColumn.Two, {});
            panels.push(panel);
            const receive = sandbox.spy(panel.webview, 'onDidReceiveMessage');
            sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
            await session.showDataView(source, 'json', 'x', '', 'Two', `test-pending-${source}`);
            const documentGeneration = Number(/const documentGeneration = (\d+)/.exec(panel.webview.html)?.[1]);
            const listener = receive.firstCall.args[0] as (message: unknown) => Promise<void>;
            // With no R session, requests settle asynchronously with an unavailable response.
            const pending = source === 'table'
                ? [listener({
                    message: 'dataview/request', action: 'page', documentGeneration, requestId: 1,
                })]
                : ['listview/page', 'listview/navigate'].map(message => listener({
                    message, documentGeneration, requestId: 1, path: [], start: 1,
                }));
            panel.dispose();
            await Promise.all(pending);
        });
    }

    test('restores the active session PID when leaving a real viewer for an R editor', async () => {
        const statusBar = {
            text: '', tooltip: '', show: sandbox.stub(),
        } as unknown as vscode.StatusBarItem;
        sandbox.stub(extension, 'sessionStatusBarItem').value(statusBar);
        const request = sandbox.stub().resolves({
            globalenv: {}, search: [], loaded_namespaces: [],
        });
        const viewerSession = session.registerSessionTransport('viewer-editor-a', 'host', '/tmp', request);
        const active = session.registerSessionTransport('viewer-editor-b', 'host', '/tmp', request);
        viewerSession.pid = '111';
        viewerSession.rVer = 'R version 4.6.0';
        viewerSession.info = { version: viewerSession.rVer, command: 'R', start_time: '' };
        active.pid = '222';
        active.rVer = 'R version 4.6.0';
        active.info = { version: active.rVer, command: 'R', start_time: '' };

        try {
            await session.activateSession(active);
            const create = sandbox.spy(vscode.window, 'createWebviewPanel');
            await session.showDataView(
                'list', 'json', 'x', '', 'Two', 'viewer-editor', undefined, viewerSession.sessionId, 1
            );
            const panel = create.lastCall.returnValue;
            panels.push(panel);
            panel.reveal(vscode.ViewColumn.Two, false);
            await waitFor(() => panel.active);
            await waitFor(() => statusBar.text === 'R 4.6.0: 111');

            const document = await vscode.workspace.openTextDocument({
                language: 'r', content: 'x <- 1',
            });
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Two, preserveFocus: false, preview: true,
            });
            await waitFor(() => !panel.active);
            await waitFor(() => statusBar.text === 'R 4.6.0: 222');
            assert.strictEqual(session.activeSession, active);
        } finally {
            await session.cleanupSession(viewerSession.sessionId);
            await session.cleanupSession(active.sessionId);
        }
    });

    test('reuses separate list and table panels, updates titles, and reopens closed viewers', async () => {
        const reveals: sinon.SinonStub[] = [];
        const create = sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title) => {
            const disposed = new vscode.EventEmitter<void>();
            const reveal = sandbox.stub();
            reveals.push(reveal);
            const panel = {
                title, viewColumn: vscode.ViewColumn.Three,
                reveal,
                webview: {
                    html: '', asWebviewUri: (uri: vscode.Uri) => uri,
                    onDidReceiveMessage: sandbox.stub(),
                },
                onDidChangeViewState: sandbox.stub(),
                onDidDispose: disposed.event,
                dispose: () => { disposed.fire(); disposed.dispose(); },
            } as unknown as vscode.WebviewPanel;
            panels.push(panel);
            return panel;
        });

        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-x');
        await session.showDataView('list', 'json', 'x$a', '', 'Two', 'test-list-x');
        await session.showDataView('list', 'json', 'x$a$b', '', 'Two', 'test-list-x');
        sinon.assert.calledOnce(create);
        assert.strictEqual(panels[0].title, 'x$a$b');
        const listIcon = panels[0].iconPath as { dark: vscode.Uri; light: vscode.Uri };
        assert.strictEqual(path.basename(listIcon.dark.fsPath), 'preview.svg');
        assert.strictEqual(path.basename(listIcon.light.fsPath), 'preview.svg');
        sinon.assert.alwaysCalledWithExactly(reveals[0], vscode.ViewColumn.Three, true);

        await session.showDataView('table', 'json', 'x$df', '', 'Two', 'test-table-x');
        await session.showDataView('table', 'json', 'x$a$df', '', 'Two', 'test-table-x');
        assert.strictEqual(create.callCount, 2);
        assert.strictEqual(panels[1].title, 'x$a$df');
        const tableIcon = panels[1].iconPath as { dark: vscode.Uri; light: vscode.Uri };
        assert.strictEqual(path.basename(tableIcon.dark.fsPath), 'open-preview.svg');
        assert.strictEqual(path.basename(tableIcon.light.fsPath), 'open-preview.svg');
        assert.strictEqual(panels[0].title, 'x$a$b');
        await session.showDataView('list', 'json', 'y', '', 'Two', 'test-list-y');
        assert.strictEqual(create.callCount, 3);
        await session.showDataView('list', 'json', 'x$id', '', 'Two', 'test-list-x', {
            title: 'x$id', path: [1], vector: true,
            breadcrumbs: [{ label: 'x', path: [] }, { label: 'id', path: [1] }],
        });
        assert.strictEqual(create.callCount, 3);
        assert.strictEqual(panels[0].title, 'x$id');
        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-x');
        assert.strictEqual(create.callCount, 3);
        assert.strictEqual(panels[0].title, 'x');
        const first = panels.shift();
        assert.ok(first);
        first.dispose();
        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-x');
        assert.strictEqual(create.callCount, 4);
    });

    test('ignores requests and replies from a previous list page after panel reuse', async () => {
        let receive: (message: unknown) => Promise<void> = () => Promise.resolve();
        const postMessage = sandbox.stub().resolves(true);
        const disposed = new vscode.EventEmitter<void>();
        const panel = {
            title: '', viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
            webview: {
                html: '', asWebviewUri: (uri: vscode.Uri) => uri, postMessage,
                onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
            },
            onDidChangeViewState: sandbox.stub(),
            onDidDispose: disposed.event,
            dispose: () => { disposed.fire(); disposed.dispose(); },
        } as unknown as vscode.WebviewPanel;
        panels.push(panel);
        sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
        const documentGeneration = () => Number(/const documentGeneration = (\d+)/.exec(panel.webview.html)?.[1]);
        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-document-generation');

        for (const message of ['listview/navigate', 'listview/page']) {
            const request = { message, documentGeneration: documentGeneration(), requestId: 1, path: [], start: 1 };
            // sessionRequest settles asynchronously even without an attached R session.
            const pending = receive(request);
            await session.showDataView('list', 'json', 'x$updated', '', 'Two', 'test-list-document-generation');
            await pending;
            sinon.assert.notCalled(postMessage);
            await receive(request);
            sinon.assert.notCalled(postMessage);
            assert.strictEqual(panel.title, 'x$updated');
        }
        await receive({ message: 'listview/page', documentGeneration: documentGeneration(), requestId: 2, path: [], start: 1 });
        sinon.assert.calledOnce(postMessage);
        const response = postMessage.firstCall.args[0] as { documentGeneration: number };
        assert.strictEqual(response.documentGeneration, documentGeneration());
    });

    test('ignores requests and replies from a previous data viewer document after panel reuse', async () => {
        let receive: (message: unknown) => Promise<void> = () => Promise.resolve();
        const postMessage = sandbox.stub().resolves(true);
        const disposed = new vscode.EventEmitter<void>();
        const panel = {
            title: '', viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
            webview: {
                html: '', asWebviewUri: (uri: vscode.Uri) => uri, postMessage,
                onDidReceiveMessage: (listener: typeof receive) => { receive = listener; },
            },
            onDidChangeViewState: sandbox.stub(),
            onDidDispose: disposed.event,
            dispose: () => { disposed.fire(); disposed.dispose(); },
        } as unknown as vscode.WebviewPanel;
        panels.push(panel);
        sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
        const documentGeneration = () =>
            Number(/const documentGeneration = (\d+)/.exec(panel.webview.html)?.[1]);
        await session.showDataView('table', 'json', 'x', '', 'Two', 'test-dataview-document-generation');

        const request = {
            message: 'dataview/request', action: 'page',
            documentGeneration: documentGeneration(), requestId: 1,
        };
        const pending = receive(request);
        await session.showDataView(
            'table', 'json', 'x$updated', '', 'Two', 'test-dataview-document-generation'
        );
        await pending;
        sinon.assert.notCalled(postMessage);
        await receive(request);
        sinon.assert.notCalled(postMessage);

        await receive({
            ...request, documentGeneration: documentGeneration(), requestId: 2,
        });
        sinon.assert.calledOnce(postMessage);
        const response = postMessage.firstCall.args[0] as { documentGeneration: number };
        assert.strictEqual(response.documentGeneration, documentGeneration());
    });

    test('supported workspace children retain open actions alongside expansion', () => {
        for (const type of ['list', 'environment', 'pairlist', 'S4', 'double', 'closure']) {
            const structured = ['list', 'environment', 'pairlist', 'S4'].includes(type);
            const node = new GlobalEnvItem('', type, '$ item', type, 1, undefined, structured,
                'x', [{ kind: 'index', value: 1 }], undefined, true);
            assert.strictEqual(node.contextValue, 'viewableNode');
            assert.strictEqual(node.collapsibleState, structured
                ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        }
        const unavailable = new GlobalEnvItem('', 'active_binding', '', 'active_binding', 1,
            undefined, false, 'x', [], undefined, false);
        assert.notStrictEqual(unavailable.contextValue, 'viewableNode');
    });
});
