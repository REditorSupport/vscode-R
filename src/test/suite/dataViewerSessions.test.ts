import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

interface Request {
    id: number;
    method: string;
    params?: { view_id?: string; state_generation?: number };
}

interface Client {
    id: string;
    socket: net.Socket;
    requests: Request[];
}

interface Panel {
    panel: vscode.WebviewPanel;
    receive: (message: unknown) => Promise<void>;
    replies: Array<{ ok?: boolean; error?: string }>;
    activate: () => void;
    deactivate: () => void;
}

async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for viewer IPC');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

suite('Viewer session ownership', () => {
    let sandbox: sinon.SinonSandbox;
    let statusBar: vscode.StatusBarItem;
    const clients: Client[] = [];
    const panels: Panel[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        const root = path.join(__dirname, '..', '..', '..');
        mockExtensionContext(root, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        statusBar = {
            text: '', tooltip: '', show: sandbox.stub(),
        } as unknown as vscode.StatusBarItem;
        sandbox.stub(extension, 'sessionStatusBarItem').value(statusBar);
        sandbox.stub(util, 'config').returns({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        } as vscode.WorkspaceConfiguration);
        session.deploySessionWatcher(root);
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title) => {
            const disposed = new vscode.EventEmitter<void>();
            const viewState = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
            let closed = false;
            let active = false;
            const item: Panel = {
                panel: undefined as unknown as vscode.WebviewPanel,
                receive: () => Promise.resolve(), replies: [],
                activate: () => undefined, deactivate: () => undefined,
            };
            item.panel = {
                title, viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
                get active() { return active; },
                webview: {
                    html: '', asWebviewUri: (uri: vscode.Uri) => uri,
                    onDidReceiveMessage: (listener: Panel['receive']) => { item.receive = listener; },
                    postMessage: (reply: Panel['replies'][number]) => {
                        item.replies.push(reply);
                        return Promise.resolve(true);
                    },
                },
                onDidChangeViewState: viewState.event,
                onDidDispose: disposed.event,
                dispose: () => {
                    if (!closed) {
                        closed = true;
                        disposed.fire();
                        disposed.dispose();
                        viewState.dispose();
                    }
                },
            } as unknown as vscode.WebviewPanel;
            item.activate = () => {
                active = true;
                viewState.fire({ webviewPanel: item.panel });
            };
            item.deactivate = () => {
                active = false;
                viewState.fire({ webviewPanel: item.panel });
            };
            panels.push(item);
            return item.panel;
        });
    });

    teardown(async () => {
        panels.splice(0).forEach(item => { item.panel.dispose(); });
        for (const client of clients.splice(0)) {
            await session.cleanupSession(client.id);
            client.socket.destroy();
        }
        await session.shutdownSessionWatcher();
        sandbox.restore();
    });

    function notify(client: Client, method: string, params: Record<string, unknown>): void {
        client.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async function attach(
        id: string, host = 'viewer-test-host', pid: string | number = id,
    ): Promise<Client> {
        const previousSocket = session.activeSession?.socket;
        const socket = net.createConnection(await session.getGlobalPipePath());
        const client = { id, socket, requests: [] as Request[] };
        clients.push(client);
        let buffer = '';
        socket.on('data', (data: Buffer) => {
            buffer += data.toString();
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const request = JSON.parse(buffer.slice(0, newline)) as Request;
                buffer = buffer.slice(newline + 1);
                client.requests.push(request);
                let result: unknown = true;
                switch (request.method) {
                    case 'workspace': result = { globalenv: {}, search: [], loaded_namespaces: [] }; break;
                    case 'dataview_init': result = { columns: [], totalRows: 1 }; break;
                    case 'dataview_page': result = { rows: [{ owner: id }], totalRows: 1, totalUnfiltered: 1 }; break;
                    case 'workspace_children': result = { children: [], next_start: null }; break;
                    case 'listview_navigate':
                    case 'listview_view':
                        result = { title: 'x$child', path: [1], breadcrumbs: [{ label: 'x', path: [] }] };
                        break;
                }
                socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
            }
        });
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        notify(client, 'attach', {
            protocol_version: 2, session_id: id, host, pid,
            version: '4.6.0', tempdir: '/tmp', wd: '/tmp',
        });
        await waitFor(() => session.activeSession?.sessionId === id &&
            session.activeSession.socket !== previousSocket);
        // A round trip ensures the new connection has completed its handshake.
        await session.sessionRequest({ method: 'workspace' }, id);
        return client;
    }

    async function open(
        client: Client, source: 'list' | 'table', existing?: Panel, stateGeneration = 1,
    ): Promise<Panel> {
        const count = panels.length;
        const html = existing?.panel.webview.html;
        notify(client, 'dataview', {
            source, type: 'json', title: 'x', view_id: `same-${source}-id`, state_generation: stateGeneration,
            navigation: { title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }] },
        });
        await waitFor(() => existing ? existing.panel.webview.html !== html : panels.length > count);
        if (existing) {
            assert.strictEqual(panels.length, count);
        }
        return existing ?? panels[count];
    }

    async function send(panel: Panel, message: Record<string, unknown>): Promise<void> {
        const documentGeneration = Number(/const documentGeneration = (\d+)/.exec(panel.panel.webview.html)?.[1]);
        await panel.receive({ documentGeneration, requestId: 1, path: [], start: 1, ...message });
    }

    const viewerRequests = (client: Client) => client.requests.filter(request => request.method !== 'workspace');

    test('viewer focus updates the displayed PID without activating its session', async () => {
        const a = await attach('viewer-session-a');
        const b = await attach('viewer-session-b');
        const aList = await open(a, 'list');
        const bTable = await open(b, 'table');
        const active = session.activeSession;

        assert.strictEqual(active?.sessionId, b.id);
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-b');

        aList.activate();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');
        assert.strictEqual(session.activeSession, active);

        await session.updateWorkspace();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');
        assert.strictEqual(session.activeSession, active);

        aList.deactivate();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-b');
        assert.strictEqual(session.activeSession, active);

        aList.activate();
        bTable.activate();
        aList.deactivate();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-b');
        assert.strictEqual(session.activeSession, active);
    });

    test('terminal selection overrides a focused viewer PID without an editor transition', async () => {
        const terminalPid = 46250;
        const terminal = {
            processId: Promise.resolve(terminalPid),
        } as unknown as vscode.Terminal;
        sandbox.stub(vscode.window, 'terminals').value([terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal);

        const a = await attach('viewer-session-a');
        const b = await attach('viewer-session-b', os.hostname(), terminalPid);
        const aList = await open(a, 'list');
        const aTable = await open(a, 'table');
        assert.ok(aList.panel.webview.html.includes("window.addEventListener('blur'"));
        assert.ok(aTable.panel.webview.html.includes("window.addEventListener('blur'"));

        aList.activate();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');

        await session.updateWorkspace();
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');

        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(session.activeSession?.sessionId, b.id);
        assert.strictEqual(statusBar.text, 'R 4.6.0: 46250');

        await session.updateWorkspace();
        assert.strictEqual(statusBar.text, 'R 4.6.0: 46250');

        await send(aList, { message: 'dataview/focus' });
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');
        assert.strictEqual(session.activeSession?.sessionId, b.id);

        await send(aList, { message: 'dataview/blur' });
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');
        await waitFor(() => statusBar.text === 'R 4.6.0: 46250');
        assert.strictEqual(session.activeSession?.sessionId, b.id);

        assert.strictEqual(await session.activateSessionById(a.id), true);
        await send(aTable, { message: 'dataview/focus' });
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');

        await send(aTable, { message: 'dataview/blur' });
        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(statusBar.text, 'R 4.6.0: 46250');
        assert.strictEqual(session.activeSession?.sessionId, b.id);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.strictEqual(statusBar.text, 'R 4.6.0: 46250');

        await session.cleanupSession(b.id);
        assert.strictEqual(session.activeSession, undefined);
        assert.strictEqual(statusBar.text, 'R: (not attached)');
    });

    test('active session disconnect preserves a focused viewer PID', async () => {
        const a = await attach('viewer-session-a');
        const b = await attach('viewer-session-b');
        const aList = await open(a, 'list');

        aList.activate();
        assert.strictEqual(session.activeSession?.sessionId, b.id);
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');

        await session.cleanupSession(b.id);
        assert.strictEqual(session.activeSession, undefined);
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');
    });

    test('focused viewer disconnect falls back to the active session PID', async () => {
        const a = await attach('viewer-session-a');
        const b = await attach('viewer-session-b');
        const aList = await open(a, 'list');

        aList.activate();
        assert.strictEqual(session.activeSession?.sessionId, b.id);
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-a');

        await session.cleanupSession(a.id);
        assert.strictEqual(session.activeSession?.sessionId, b.id);
        assert.strictEqual(statusBar.text, 'R 4.6.0: viewer-session-b');
    });

    test('identical viewer ids stay separate and background views keep their originating session', async () => {
        const a = await attach('viewer-session-a');
        const b = await attach('viewer-session-b');
        const aList = await open(a, 'list');
        const aTable = await open(a, 'table');
        const bList = await open(b, 'list');
        const bTable = await open(b, 'table');
        assert.strictEqual(panels.length, 4);
        await open(a, 'list', aList, 2);
        await open(a, 'table', aTable, 2);
        assert.strictEqual(session.activeSession?.sessionId, b.id);

        const exercise = async (list: Panel, table: Panel) => {
            await send(table, { message: 'dataview/request', action: 'init' });
            await send(table, { message: 'dataview/request', action: 'page', startRow: 0, endRow: 1 });
            await send(list, { message: 'listview/page' });
            await send(list, { message: 'listview/navigate' });
            await send(list, { message: 'listview/view', index: 1 });
        };
        const expected = ['dataview_init', 'dataview_page', 'workspace_children', 'listview_navigate', 'listview_view'];
        await exercise(aList, aTable);
        assert.deepStrictEqual(viewerRequests(a).map(request => request.method), expected);
        assert.deepStrictEqual(viewerRequests(b), []);
        assert.strictEqual(await session.activateSessionById(a.id), true);
        await exercise(bList, bTable);
        assert.deepStrictEqual(viewerRequests(b).map(request => request.method), expected);

        await open(b, 'list', bList, 2);
        await open(b, 'table', bTable, 2);
        bList.panel.dispose();
        bTable.panel.dispose();
        await waitFor(() => viewerRequests(b).length === 7);
        assert.deepStrictEqual(viewerRequests(b).slice(-2).map(request => request.params?.view_id),
            ['same-list-id', 'same-table-id']);
        assert.deepStrictEqual(viewerRequests(b).slice(-2).map(request => request.params?.state_generation),
            [2, 2]);
        assert.strictEqual(viewerRequests(a).length, 5);
        await open(a, 'list', aList);
        await open(a, 'table', aTable);
    });

    test('Interactive viewers retain transcript tables and dispose standalone list state', async () => {
        const request = sandbox.stub().resolves({ columns: [], totalRows: 1 });
        const owner = session.registerSessionTransport('interactive-viewer', 'host', '/tmp', request);
        try {
            const other = await attach('other-viewer-session');
            await session.showDataView('table', 'json', 'table', '', 'Two', 'transcript-table', undefined, owner.sessionId);
            await send(panels[0], { message: 'dataview/request', action: 'init' });
            sinon.assert.calledWithExactly(request, { method: 'dataview_init', params: { view_id: 'transcript-table' } });
            request.resetHistory();
            panels[0].panel.dispose();
            sinon.assert.notCalled(request);
            await session.showDataView('list', 'json', 'list', '', 'Two', 'standalone-list', undefined, owner.sessionId, 3);
            panels[1].panel.dispose();
            sinon.assert.calledOnceWithExactly(request, {
                method: 'dataview_dispose', params: { view_id: 'standalone-list', state_generation: 3 },
            });
            assert.deepStrictEqual(viewerRequests(other), []);
        } finally {
            session.unregisterSessionTransport(owner);
        }
    });

    test('viewers follow the same session on reconnect and never fall back after disconnect', async () => {
        const a = await attach('viewer-reconnect-a');
        const list = await open(a, 'list');
        const table = await open(a, 'table');
        const b = await attach('viewer-reconnect-b');
        const replacement = await attach(a.id);
        assert.strictEqual(await session.activateSessionById(b.id), true);
        await open(replacement, 'list', list);
        await open(replacement, 'table', table);
        await send(list, { message: 'listview/page' });
        await send(table, { message: 'dataview/request', action: 'init' });
        assert.deepStrictEqual(viewerRequests(replacement).map(request => request.method),
            ['workspace_children', 'dataview_init']);
        assert.deepStrictEqual(viewerRequests(a), []);
        assert.deepStrictEqual(viewerRequests(b), []);

        await session.cleanupSession(a.id);
        await send(list, { message: 'listview/page' });
        await send(table, { message: 'dataview/request', action: 'page' });
        assert.ok(list.replies.at(-1)?.error);
        assert.strictEqual(table.replies.at(-1)?.ok, false);
        list.panel.dispose();
        table.panel.dispose();
        assert.deepStrictEqual(viewerRequests(b), []);
        assert.strictEqual(session.activeSession?.sessionId, b.id);
    });
});
