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
        await session.showDataView('vector', 'json', 'x$id', '', 'Two', 'test-vector-x');
        assert.strictEqual(create.callCount, 4);
        const first = panels.shift();
        assert.ok(first);
        first.dispose();
        await session.showDataView('list', 'json', 'x', '', 'Two', 'test-list-x');
        assert.strictEqual(create.callCount, 5);
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
