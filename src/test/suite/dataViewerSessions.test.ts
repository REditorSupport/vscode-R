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
    replies: Array<{ ok?: boolean; error?: string; message?: string; text?: string }>;
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
    const clients: Client[] = [];
    const panels: Panel[] = [];

    setup(() => {
        sandbox = sinon.createSandbox();
        const root = path.join(__dirname, '..', '..', '..');
        mockExtensionContext(root, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        sandbox.stub(util, 'config').returns({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        } as vscode.WorkspaceConfiguration);
        session.deploySessionWatcher(root);
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((_type, title) => {
            const disposed = new vscode.EventEmitter<void>();
            const listeners: Array<(message: unknown) => unknown> = [];
            let closed = false;
            const item: Panel = {
                panel: undefined as unknown as vscode.WebviewPanel,
                receive: async message => { await Promise.all(listeners.map(listener => listener(message))); }, replies: [],
            };
            item.panel = {
                title, viewColumn: vscode.ViewColumn.Two, reveal: sandbox.stub(),
                webview: {
                    html: '', asWebviewUri: (uri: vscode.Uri) => uri,
                    onDidReceiveMessage: (listener: Panel['receive']) => {
                        listeners.push(listener);
                        return { dispose: () => { listeners.splice(listeners.indexOf(listener), 1); } };
                    },
                    postMessage: (reply: Panel['replies'][number]) => {
                        item.replies.push(reply);
                        return Promise.resolve(true);
                    },
                },
                onDidDispose: disposed.event,
                dispose: () => {
                    if (!closed) {
                        closed = true;
                        disposed.fire();
                        disposed.dispose();
                    }
                },
            } as unknown as vscode.WebviewPanel;
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

    async function attach(id: string, pid = id, version = '4.6.0', host = 'viewer-test-host'): Promise<Client> {
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
            version, tempdir: '/tmp', wd: '/tmp',
        });
        await waitFor(() => session.activeSession?.sessionId === id &&
            session.activeSession.socket !== previousSocket);
        // A round trip ensures the new connection has completed its handshake.
        await session.sessionRequest({ method: 'workspace' }, id);
        return client;
    }

    test('HTML widget notifications use their source session while another session is active', async () => {
        sandbox.stub(util, 'readContent').callsFake(file => Promise.resolve(`<div>${String(file)}</div>`));
        const first = await attach('html-source', '12101', '4.6.1');
        const second = await attach('html-active', '12102', '4.6.2');
        assert.strictEqual(session.activeSession?.sessionId, second.id);

        notify(first, 'webview', { url: '/tmp/first-widget.html' });
        await waitFor(() => panels.length === 1 && panels[0].panel.webview.html.includes('first-widget.html'));
        const original = panels[0].panel;
        assert.ok(original.webview.html.includes('R 4.6.1: 12101'));
        notify(first, 'webview', { url: '/tmp/updated-widget.html' });
        await waitFor(() => original.webview.html.includes('updated-widget.html'));
        assert.strictEqual(panels.length, 1);

        notify(second, 'webview', { url: '/tmp/second-widget.html' });
        await waitFor(() => panels.length === 2 && panels[1].panel.webview.html.includes('second-widget.html'));
        assert.ok(panels[1].panel.webview.html.includes('R 4.6.2: 12102'));
        assert.ok(original.webview.html.includes('updated-widget.html'));
        assert.strictEqual(session.activeSession?.sessionId, second.id);
    });

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

    test('viewer info icons keep their source version and PID while another session is active', async () => {
        const statusBar = { text: '', show: sandbox.stub() } as unknown as vscode.StatusBarItem;
        sandbox.stub(extension, 'sessionStatusBarItem').value(statusBar);
        const a = await attach('header-source-a', '12101', 'R version 4.6.1 (2026-06-01)');
        const b = await attach('header-source-b', '12102');
        const active = session.activeSession;
        const expected = 'class="viewer-session-tooltip" role="tooltip">R 4.6.1: 12101</span>';
        const list = await open(a, 'list');
        const table = await open(a, 'table');
        for (const viewer of [list, table]) {
            assert.ok(viewer.panel.webview.html.includes(expected));
            assert.ok(viewer.panel.webview.html.includes('class="codicon codicon-info" aria-hidden="true"'));
            assert.ok(viewer.panel.webview.html.includes('aria-label="R 4.6.1: 12101"'));
            assert.ok(viewer.panel.webview.html.includes('aria-describedby="viewer-session-tooltip"'));
            assert.ok(!viewer.panel.webview.html.includes('Source R session:'));
        }
        await open(a, 'list', list, 2);
        await open(a, 'table', table, 2);

        sandbox.stub(util, 'readContent').resolves('{"columns":[],"data":[]}');
        await session.showDataView('table', 'json', 'file table', '/tmp/viewer-header.json', 'Two', undefined, undefined, a.id);
        assert.ok(panels.at(-1)?.panel.webview.html.includes(expected));
        await session.showDataView('list', 'json', 'unbound', '', 'Two', undefined, undefined, null);
        assert.ok(!panels.at(-1)?.panel.webview.html.includes('<span class="viewer-session"'));

        await session.cleanupSession(a.id);
        for (const viewer of [list, table]) {
            assert.ok(viewer.panel.webview.html.includes(expected));
        }
        assert.strictEqual(active?.sessionId, b.id);
        assert.strictEqual(session.activeSession, active);
        assert.strictEqual(statusBar.text, 'R 4.6.0: 12102');
    });

    test('viewer info survives persistence detach and updates only when its source process exits', async () => {
        const sourcePid = 2147483646;
        let processState: 'running' | 'denied' | 'exited' = 'running';
        const kill = process.kill.bind(process);
        sandbox.stub(process, 'kill').callsFake((pid, signal) => {
            if (pid !== sourcePid || signal !== 0) { return kill(pid, signal); }
            if (processState !== 'running') {
                throw Object.assign(new Error(processState), { code: processState === 'exited' ? 'ESRCH' : 'EPERM' });
            }
            return true;
        });
        const sourceHost = os.hostname().toUpperCase();
        const owner = session.registerSessionTransport('persistent-viewer', sourceHost, '/tmp', sandbox.stub().resolves({}));
        owner.pid = String(sourcePid); owner.rVer = 'R version 4.6.1 (2026-06-01)';
        const statusBar = { text: '', show: sandbox.stub() } as unknown as vscode.StatusBarItem;
        sandbox.stub(extension, 'sessionStatusBarItem').value(statusBar);
        const native = await attach('native-viewer', String(sourcePid), '4.6.1', sourceHost);
        const other = await attach('lifecycle-other', '12102');
        try {
            await session.showDataView('list', 'json', 'list', '', 'Two', 'persistent-list', undefined, owner.sessionId);
            await session.showDataView('table', 'json', 'table', '', 'Two', 'persistent-table', undefined, owner.sessionId);
            sandbox.stub(util, 'readContent').resolves('{"columns":[],"data":[]}');
            await session.showDataView('table', 'json', 'file table', '/tmp/viewer.json', 'Two', undefined, undefined, owner.sessionId);
            await session.showDataView('list', 'json', 'static list', '', 'Two', undefined, undefined, owner.sessionId);
            await open(native, 'table');
            await open(native, 'list');
            const viewers = panels.slice();
            const originalHtml = viewers.map(viewer => viewer.panel.webview.html);
            await session.cleanupSession(native.id);
            session.unregisterSessionTransport(owner);
            for (const viewer of viewers) {
                await viewer.receive({ message: 'viewer-session/ready' });
                assert.deepStrictEqual(viewer.replies.at(-1), {
                    message: 'viewer-session/update', text: `R 4.6.1: ${sourcePid}`,
                });
            }
            processState = 'denied';
            await viewers[0].receive({ message: 'viewer-session/ready' });
            assert.strictEqual(viewers[0].replies.at(-1)?.text, `R 4.6.1: ${sourcePid}`);
            const disposed = viewers.pop()!;
            disposed.panel.dispose();
            const disposedReplyCount = disposed.replies.length;
            processState = 'exited';
            await waitFor(() => viewers.every(viewer => viewer.replies.at(-1)?.text === 'R: (not attached)'));
            for (const [index, viewer] of viewers.entries()) {
                assert.strictEqual(viewer.panel.webview.html, originalHtml[index]);
            }
            assert.strictEqual(disposed.replies.length, disposedReplyCount);
            assert.strictEqual(session.activeSession?.sessionId, other.id);
            assert.strictEqual(statusBar.text, 'R 4.6.0: 12102');
        } finally { session.unregisterSessionTransport(owner); }
    });

    test('viewers share polling and release it when the last viewer closes', async () => {
        const clock = sandbox.useFakeTimers();
        const kill = sandbox.stub(process, 'kill').returns(true);
        const request = sandbox.stub().resolves({});
        const first = session.registerSessionTransport('shared-polling-first', os.hostname(), '/tmp', request);
        const second = session.registerSessionTransport('shared-polling-second', os.hostname(), '/tmp', request);
        first.pid = '2147483645'; first.rVer = '4.6.1';
        second.pid = '2147483646'; second.rVer = '4.6.2';
        try {
            await session.showDataView('list', 'json', 'list', '', 'Two', undefined, undefined, first.sessionId);
            await session.showDataView('table', 'json', 'table', '', 'Two', undefined, undefined, first.sessionId);
            await session.showDataView('list', 'json', 'other', '', 'Two', undefined, undefined, second.sessionId);
            assert.strictEqual(clock.countTimers(), 1);
            clock.tick(1000);
            sinon.assert.calledTwice(kill);
            sinon.assert.calledWithExactly(kill, Number(first.pid), 0);
            sinon.assert.calledWithExactly(kill, Number(second.pid), 0);

            session.unregisterSessionTransport(first);
            kill.resetHistory();
            clock.tick(1000);
            assert.strictEqual(kill.callCount, 2, 'transport detachment must keep monitoring the source');
            panels[0].panel.dispose();
            panels[1].panel.dispose();
            kill.resetHistory();
            clock.tick(1000);
            sinon.assert.calledOnceWithExactly(kill, Number(second.pid), 0);
            panels[2].panel.dispose();
            assert.strictEqual(clock.countTimers(), 0);
        } finally {
            session.unregisterSessionTransport(first);
            session.unregisterSessionTransport(second);
        }
    });

    test('viewer info uses confirmed Interactive exit even when the source host cannot be probed', async () => {
        const owner = session.registerSessionTransport('exited-viewer', 'foreign-host', '/tmp', sandbox.stub().resolves({}));
        owner.pid = '12103'; owner.rVer = '4.6.2';
        try {
            await session.showDataView('list', 'json', 'list', '', 'Two', 'exited-list', undefined, owner.sessionId);
            await session.showDataView('table', 'json', 'table', '', 'Two', 'exited-table', undefined, owner.sessionId);
            const disposed = panels[0];
            disposed.panel.dispose();
            const disposedReplyCount = disposed.replies.length;
            owner.processExited = true;
            assert.deepStrictEqual(panels[1].replies.at(-1), {
                message: 'viewer-session/update', text: 'R: (not attached)',
            }, 'confirmed exit should update viewers immediately, without polling or a ready message');
            assert.strictEqual(disposed.replies.length, disposedReplyCount);
            // Exited state events can clear the process metadata.
            owner.pid = ''; owner.rVer = '';
            await panels[1].receive({ message: 'viewer-session/ready' });
            assert.strictEqual(panels[1].replies.at(-1)?.text, 'R: (not attached)');
        } finally { session.unregisterSessionTransport(owner); }
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
        owner.pid = '12103'; owner.rVer = '4.6.2';
        try {
            const other = await attach('other-viewer-session');
            await session.showDataView('table', 'json', 'table', '', 'Two', 'transcript-table', undefined, owner.sessionId);
            assert.ok(panels[0].panel.webview.html.includes('role="tooltip">R 4.6.2: 12103</span>'));
            await send(panels[0], { message: 'dataview/request', action: 'init' });
            sinon.assert.calledWithExactly(request, { method: 'dataview_init', params: { view_id: 'transcript-table' } });
            request.resetHistory();
            panels[0].panel.dispose();
            sinon.assert.notCalled(request);
            await session.showDataView('list', 'json', 'list', '', 'Two', 'standalone-list', undefined, owner.sessionId, 3);
            assert.ok(panels[1].panel.webview.html.includes('role="tooltip">R 4.6.2: 12103</span>'));
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
