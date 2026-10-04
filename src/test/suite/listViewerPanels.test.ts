import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { mockExtensionContext } from '../common/mockvscode';
import * as session from '../../session';
import { GlobalEnvItem } from '../../workspaceViewer';

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
            onDidDispose: disposed.event,
            dispose: () => { disposed.fire(); disposed.dispose(); },
        } as unknown as vscode.WebviewPanel;
        panels.push(panel);
        sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
        const generation = () => Number(/const generation = (\d+)/.exec(panel.webview.html)?.[1]);
        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-generation');

        for (const message of ['listview/navigate', 'listview/page']) {
            const request = { message, generation: generation(), requestId: 1, path: [], start: 1 };
            // sessionRequest settles asynchronously even without an attached R session.
            const pending = receive(request);
            await session.showDataView('list', 'json', 'x$updated', '', 'Two', 'test-list-generation');
            await pending;
            sinon.assert.notCalled(postMessage);
            await receive(request);
            sinon.assert.notCalled(postMessage);
            assert.strictEqual(panel.title, 'x$updated');
        }
        await receive({ message: 'listview/page', generation: generation(), requestId: 2, path: [], start: 1 });
        sinon.assert.calledOnce(postMessage);
        const response = postMessage.firstCall.args[0] as { generation: number };
        assert.strictEqual(response.generation, generation());
    });

    test('supported workspace children retain open actions alongside expansion', () => {
        for (const type of ['list', 'environment', 'pairlist', 'S4', 'double', 'closure']) {
            const structured = ['list', 'environment', 'pairlist', 'S4'].includes(type);
            const node = new GlobalEnvItem('', type, '$ item', type, 1, undefined, structured,
                'x', [{ kind: 'index', value: 1 }], true);
            assert.strictEqual(node.contextValue, 'viewableNode');
            assert.strictEqual(node.collapsibleState, structured
                ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        }
        const unavailable = new GlobalEnvItem('', 'active_binding', '', 'active_binding', 1,
            undefined, false, 'x', [], false);
        assert.notStrictEqual(unavailable.contextValue, 'viewableNode');
    });
});
