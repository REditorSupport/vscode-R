import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import fs from 'fs-extra';
import * as net from 'net';
import { EventEmitter } from 'events';

import { mockExtensionContext } from '../common/mockvscode';
import * as rTerminal from '../../rTerminal';
import * as util from '../../util';
import * as session from '../../session';
import * as extension from '../../extension';
import * as plotViewer from '../../plotViewer';
import type { RSessionApi } from '../../api';

const extension_root: string = path.join(__dirname, '..', '..', '..');

async function waitFor<T>(condition: () => T | Promise<T>, timeout = 10000, interval = 100): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = await condition();
        if (result) {
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout after ${timeout}ms waiting for condition`);
}

suite('Session Communication', () => {
    let sandbox: sinon.SinonSandbox;
    let commandMarkerPath: string | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(vscode.commands, 'registerCommand'); // prevent "command already exists" error
        mockExtensionContext(extension_root, sandbox);
        session.deploySessionWatcher(extension_root);
        sandbox.stub(extension, 'globalPlotManager').value(plotViewer.initializePlotManager());
    });

    teardown(async () => {
        const attachedSessionId = session.activeSession?.sessionId;
        if (rTerminal.rTerm) {
            rTerminal.rTerm.dispose();
            
            // Explicitly invoke the extension's terminal cleanup logic
            // since the mocked VS Code environment won't fire onDidCloseTerminal
            rTerminal.deleteTerminal(rTerminal.rTerm);
        }
        if (attachedSessionId) {
            await session.cleanupSession(attachedSessionId);
        }
        if (commandMarkerPath) {
            await fs.remove(commandMarkerPath);
            commandMarkerPath = undefined;
        }
        sandbox.restore();
    });

    async function showHelpWith(viewColumn: Record<string, string> | undefined, params: Record<string, unknown> = { requestPath: 'base/html/mean.html' }) {
        const showHelpForPath = sandbox.stub().resolves();
        sandbox.stub(extension, 'globalRHelp').value({ showHelpForPath } as unknown as NonNullable<typeof extension.globalRHelp>);
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'session.viewers.viewColumn' ? viewColumn : undefined
        } as unknown as vscode.WorkspaceConfiguration);

        await session.showHelpNotification(params);
        return showHelpForPath;
    }

    test('help notification uses configured Active view column', async () => {
        const showHelpForPath = await showHelpWith({ helpPanel: 'Active' });

        sinon.assert.calledOnceWithExactly(showHelpForPath, 'base/html/mean.html', 'Active');
    });

    test('help notification does not open when help panel is disabled', async () => {
        const showHelpForPath = await showHelpWith({ helpPanel: 'Disable' });

        sinon.assert.notCalled(showHelpForPath);
    });

    test('help notification defaults to the second view column', async () => {
        const showHelpForPath = await showHelpWith(undefined);

        sinon.assert.calledOnceWithExactly(showHelpForPath, 'base/html/mean.html', 'Two');
    });

    test('help notification ignores stale viewer parameter from sess', async () => {
        const showHelpForPath = await showHelpWith({ helpPanel: 'Active' }, {
            requestPath: 'base/html/mean.html',
            viewer: 'Two'
        });

        sinon.assert.calledOnceWithExactly(showHelpForPath, 'base/html/mean.html', 'Active');
    });

    test('concurrent server initialization and public API calls share one endpoint', async () => {
        await session.shutdownSessionWatcher();
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        const listen = sandbox.spy(net.Server.prototype, 'listen');
        const api: RSessionApi = {
            getConnectionInfo: session.getConnectionInfo,
            activate: session.activateSessionById,
        };

        try {
            const [first, second, info] = await Promise.all([
                session.getGlobalPipePath(),
                session.getGlobalPipePath(),
                api.getConnectionInfo(),
            ]);
            assert.strictEqual(listen.callCount, 1);
            assert.strictEqual(first, second);
            assert.strictEqual(first, info?.endpoint);

            const client = net.createConnection(first);
            try {
                await new Promise<void>((resolve, reject) => {
                    client.once('connect', resolve);
                    client.once('error', reject);
                });
                const socket = await waitFor(() => [...session.activeConnections][0]);
                assert.strictEqual(socket._pipePath, first);
            } finally {
                client.destroy();
            }
        } finally {
            await session.shutdownSessionWatcher();
        }
    });

    test('server initialization can retry after a shared startup failure', async () => {
        await session.shutdownSessionWatcher();
        const failure = new Error('Simulated listen failure');
        const listen = sandbox.stub(net.Server.prototype, 'listen').throws(failure);
        const first = session.getGlobalPipePath();
        const second = session.getGlobalPipePath();
        await Promise.all([
            assert.rejects(first, error => error === failure),
            assert.rejects(second, error => error === failure),
        ]);
        assert.strictEqual(listen.callCount, 1);
        assert.strictEqual(session.globalPipePath, undefined);
        listen.restore();

        try {
            assert.ok(await session.getGlobalPipePath());
        } finally {
            await session.shutdownSessionWatcher();
        }
    });

    test('post-listen initialization failure closes the unpublished server before retry', async () => {
        await session.shutdownSessionWatcher();
        const failure = new Error('Simulated post-listen failure');
        const listen = sandbox.spy(net.Server.prototype, 'listen');
        const close = sandbox.spy(net.Server.prototype, 'close');
        // Unix fails at chmod; Windows has no permission setup, so inject an
        // error immediately after listening, before initialization is published.
        const fail = process.platform !== 'win32'
            ? sandbox.stub(fs, 'chmod').rejects(failure)
            : sandbox.stub(net.Server.prototype, 'emit').callsFake(function (this: net.Server, event: string, ...args: unknown[]) {
                const result = EventEmitter.prototype.emit.call(this, event, ...args);
                if (event === 'listening') {
                    EventEmitter.prototype.emit.call(this, 'error', failure);
                }
                return result;
            });
        await assert.rejects(session.getGlobalPipePath(), error => error === failure);
        const endpoint = listen.firstCall.args[0] as unknown as string;
        const server = listen.firstCall.thisValue as net.Server;
        assert.strictEqual(server.listening, false);
        assert.strictEqual(session.globalPipePath, undefined);
        if (process.platform !== 'win32') {
            assert.strictEqual(await fs.pathExists(endpoint), false);
        }
        const client = net.createConnection(endpoint);
        try {
            await assert.rejects(new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            }));
        } finally {
            client.destroy();
        }
        close.resetHistory();
        await session.shutdownSessionWatcher();
        assert.strictEqual(close.callCount, 0, 'failed server must not be published for shutdown');
        fail.restore();
        try {
            assert.ok(await session.getGlobalPipePath());
        } finally {
            await session.shutdownSessionWatcher();
        }
    });

    test('shutdown waits for an in-progress server startup and permits a fresh start', async () => {
        await session.shutdownSessionWatcher();
        const startup = session.getGlobalPipePath();
        const shutdown = session.shutdownSessionWatcher();
        const endpoint = await startup;
        await shutdown;
        assert.strictEqual(session.globalPipePath, undefined);
        if (process.platform !== 'win32') {
            assert.strictEqual(await fs.pathExists(endpoint), false);
        }
        const client = net.createConnection(endpoint);
        try {
            await assert.rejects(new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            }));
        } finally {
            client.destroy();
        }

        try {
            assert.notStrictEqual(await session.getGlobalPipePath(), endpoint);
        } finally {
            await session.shutdownSessionWatcher();
        }
    });

    test('public session API returns connection info only when the watcher is enabled', async () => {
        const watcher = sandbox.stub(extension, 'enableSessionWatcher').value(false);
        const api: RSessionApi = {
            getConnectionInfo: session.getConnectionInfo,
            activate: session.activateSessionById,
        };
        assert.strictEqual(await api.getConnectionInfo(), undefined);

        watcher.value(true);
        const configStub = {
            get: (key: string) => key === 'plot.backend' ? 'standard' : undefined,
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        await waitFor(() => session.globalPipePath);

        const connection = await api.getConnectionInfo();
        assert.ok(connection);
        assert.strictEqual(connection.protocolVersion, 1);
        assert.strictEqual(connection.endpoint, session.globalPipePath);
        assert.strictEqual(connection.plotBackend, 'standard');
        assert.ok(!('socket' in connection), 'connection info should contain plain contract data only');
    });

    test('public session API activates a connected session by id and rejects missing or disconnected sessions', async () => {
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        const api: RSessionApi = {
            getConnectionInfo: session.getConnectionInfo,
            activate: session.activateSessionById,
        };
        const endpoint = await waitFor(() => session.globalPipePath);
        if (!endpoint) {
            throw new Error('Session watcher endpoint was not initialized');
        }

        const attached: Array<{ id: string; client: net.Socket; server: net.Socket }> = [];
        const attach = async (id: string): Promise<void> => {
            const existingSockets = new Set(session.activeConnections);
            const client = net.createConnection(endpoint);
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            });
            const server = await waitFor(() =>
                [...session.activeConnections].find(socket => !existingSockets.has(socket))
            );
            assert.ok(server);
            attached.push({ id, client, server });
            client.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'attach',
                params: {
                    protocol_version: 1,
                    session_id: id,
                    host: 'test-remote-host',
                    version: '4.4.0',
                    pid: id,
                    tempdir: '/tmp',
                    wd: '/tmp',
                    info: { version: 'R version 4.4.0', command: 'R', start_time: '' },
                },
            })}\n`);
            await waitFor(() => session.activeSession?.sessionId === id);
        };

        try {
            assert.strictEqual(await api.activate('missing-session'), false);
            await attach('session-api-first');
            await attach('session-api-second');

            assert.strictEqual(session.activeSession?.sessionId, 'session-api-second');
            assert.strictEqual(await api.activate('session-api-first'), true);
            assert.strictEqual(session.activeSession?.sessionId, 'session-api-first');

            const disconnected = attached.find(item => item.id === 'session-api-second');
            assert.ok(disconnected);
            disconnected.server.destroy();
            assert.strictEqual(await api.activate('session-api-second'), false);
        } finally {
            for (const item of attached) {
                item.client.destroy();
                item.server.destroy();
                await session.cleanupSession(item.id);
            }
        }
    });

    test('communication: hello <- 1 updates workspace and provides completion', async () => {
        const configStub = {
            get: (key: string) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                if (key === 'rterm.option') {
                    return ['--no-save'];
                }
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        
        const rPath = await util.getRterm();
        assert.ok(rPath, 'R path should be found');
        sandbox.stub(util, 'getRterm').resolves(rPath);
        
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const result = await rTerminal.createRTerm(true);
        assert.ok(result, 'createRTerm should return true');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');
        
        await waitFor(() => session.activeSession, 15000, 200);
        assert.ok(session.activeSession, 'activeSession should be established');
        
        const term = rTerminal.rTerm;
        
        await new Promise(resolve => setTimeout(resolve, 2000));

        const markerPath = path.join(
            os.tmpdir(),
            `vscode-r-command-marker-${process.pid}-${Date.now()}`
        );
        commandMarkerPath = markerPath;
        await fs.remove(markerPath);
        term.sendText(
            `my_list <- list(hello_vscode = 12345); ` +
            `writeLines("evaluated", ${JSON.stringify(markerPath)})\n`
        );

        // This filesystem marker is independent of the IPC path and confirms
        // that R received and evaluated the command before probing the RPC.
        await waitFor(() => fs.pathExists(markerPath), 10000, 200);

        // Verify the workspace request path after command execution, independently
        // from the pushed workspace refresh notification.
        let rpcWorkspace: { globalenv?: Record<string, unknown> } | undefined;
        await waitFor(async () => {
            rpcWorkspace = await session.sessionRequest({
                method: 'workspace',
                params: {}
            }) as { globalenv?: Record<string, unknown> } | undefined;
            return rpcWorkspace?.globalenv?.['my_list'];
        }, 10000, 200);
        assert.ok(rpcWorkspace?.globalenv?.['my_list'], 'workspace RPC should include my_list');
        
        await waitFor(() => {
            const ge = session.workspaceData?.globalenv;
            return ge && ge['my_list'];
        }, 15000, 200);
        
        const listData = session.workspaceData.globalenv['my_list'];
        assert.ok(listData, 'my_list should be in workspaceData.globalenv');
        const className = Array.isArray(listData.class) ? listData.class[0] : listData.class;
        assert.strictEqual(className, 'list', 'my_list should be a list');
        assert.strictEqual(listData.has_children, true, 'my_list should be expandable');

        const childrenResult = await session.sessionRequest({
            method: 'workspace_children',
            params: { name: 'my_list', path: [], start: 1 }
        }) as { children: Record<string, unknown>[], next_start?: number };

        assert.ok(Array.isArray(childrenResult.children), 'workspace children should be an array');
        assert.strictEqual(childrenResult.children.length, 1, 'my_list should have one workspace child');
        assert.match(String(childrenResult.children[0].str), /hello_vscode/);
        
        const completionRequestParams = {
            expr: 'my_list',
            trigger: '$'
        };
        const completionResult = await session.sessionRequest({
            method: 'completion',
            params: completionRequestParams
        }) as Record<string, unknown>[];
        
        assert.ok(Array.isArray(completionResult), 'completion result should be an array');
        const hasHello = completionResult.some((item) => item.name === 'hello_vscode');
        assert.ok(hasHello, 'completion result should contain hello_vscode');
    }).timeout(30000);

    test('communication: plot() with various devices and View() events', async () => {
        const configStub = {
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'sessionWatcher') { return true; }
                if (key === 'rterm.option') { return ['--no-save']; }
                if (key === 'plot.useHttpgd') { return false; }
                // Pin the standard plot backend so this test is deterministic.
                // Otherwise it resolves to 'auto', which prefers jgd when jgd is
                // installed (now the case in CI since the build installs Suggests),
                // and the r.standardPlot webview is never created.
                if (key === 'plot.backend') { return 'standard'; }
                if (key === 'session.data.pageSize') { return 500; }
                if (key === 'session.viewers.viewColumn') { return {
                    plot: 'Two',
                    browser: 'Active',
                    viewer: 'Two',
                    pageViewer: 'Active',
                    view: 'Two',
                    helpPanel: 'Two'
                }; }
                if (key === 'session.viewers.viewColumn.plot') { return 'Two'; }
                return defaultValue;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        
        const rPath = await util.getRterm();
        assert.ok(rPath, 'R path should be found');
        sandbox.stub(util, 'getRterm').resolves(rPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        // svglite is a Suggests (optional) dependency of the sess package, so it may or
        // may not be present. Detect it before stubbing so the format assertions below
        // can verify the correct code path (SVG when installed, png fallback otherwise).
        const svgliteInstalled = (await util.getRPackageVersion('svglite')) !== undefined;

        const result = await rTerminal.createRTerm(true);
        assert.ok(result);
        await waitFor(() => session.activeSession, 15000, 200);
        const activeSession = session.activeSession;
        if (!activeSession) {
            throw new Error('activeSession is undefined');
        }
        
        const term = rTerminal.rTerm;
        assert.ok(term, 'rTerminal.rTerm should be defined');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Spy on WebviewPanel creation to catch plot / dataview / webview rendering attempts
        // Note: we set up the spy after activeSession to not intercept early setups if any.
        const createWebviewPanelSpy = sandbox.spy(vscode.window, 'createWebviewPanel');

        // 1. Test svglite
        const plotMarkerPath = path.join(
            os.tmpdir(),
            `vscode-r-plot-marker-${process.pid}-${Date.now()}`
        );
        commandMarkerPath = plotMarkerPath;
        await fs.remove(plotMarkerPath);
        term.sendText(
            `plot(0, main="svglite"); ` +
            `writeLines("evaluated", ${JSON.stringify(plotMarkerPath)})\n`
        );
        await waitFor(() => fs.pathExists(plotMarkerPath), 10000, 200);

        await waitFor(() => createWebviewPanelSpy.calledWith('r.standardPlot'), 10000, 200);
        assert.ok(createWebviewPanelSpy.calledWith('r.standardPlot'), 'r.standardPlot should be triggered for svglite');

        assert.ok(session.activeSession, 'activeSession should be defined');
        
        let svgliteResp: { data?: string, format?: string, error?: unknown } | undefined;
        await waitFor(async () => {
            try {
                svgliteResp = await session.sessionRequest({
                    method: 'plot_latest',
                    params: { width: 800, height: 600, format: 'svglite' }
                }) as { data?: string, format?: string, error?: unknown };
                return svgliteResp && svgliteResp.data;
            } catch (e) {
                return false;
            }
        }, 15000, 500);
        
        assert.ok(svgliteResp && svgliteResp.data, 'svglite data should be returned');
        // svglite is an optional (Suggests) dependency of the sess package. When it is
        // installed the handler renders SVG; otherwise it falls back to png. Assert the
        // path that actually applies to this environment so both branches are tested.
        if (svgliteInstalled) {
            assert.strictEqual(svgliteResp.format, 'svglite', 'format should be svglite when svglite is installed');
        } else {
            assert.strictEqual(svgliteResp.format, 'png', 'format should fall back to png when svglite is not installed');
        }

        // Reset history to ensure we track the next plot if we were to recreate the panel
        // Wait, since panel is reused, we shouldn't reset history if we just want it to pass,
        // but if we want it to actually wait for the *update*, standardViewer doesn't call createWebviewPanel.
        // I will not reset history for now, just apply the spy check.

        // 2. Test png
        term.sendText('plot(1, main="png")\n');
        
        // Wait for R to finish plotting
        await new Promise(resolve => setTimeout(resolve, 2000));

        // The panel is reused, but we use the spy just in case it were recreated or as requested.
        await waitFor(() => createWebviewPanelSpy.calledWith('r.standardPlot'), 10000, 200);
        assert.ok(createWebviewPanelSpy.calledWith('r.standardPlot'), 'r.standardPlot should be active for png');

        let pngResp: { data?: string, format?: string } | undefined;
        await waitFor(async () => {
            try {
                pngResp = await session.sessionRequest({
                    method: 'plot_latest',
                    params: { width: 800, height: 600, format: 'png' }
                }) as { data?: string, format?: string };
                return pngResp && pngResp.data;
            } catch (e) {
                return false;
            }
        }, 15000, 500);

        assert.ok(pngResp && pngResp.data, 'png data should be returned');
        assert.strictEqual(pngResp.format, 'png', 'format should be png');

        // 3. Test View() -> dataview
        term.sendText('View(mtcars)\n');
        await waitFor(() => createWebviewPanelSpy.calledWith('dataview'), 10000, 200);
        
        assert.ok(createWebviewPanelSpy.calledWith('dataview'), 'dataview should be triggered');

        // 4. Test webview
        term.sendText('tf <- tempfile(fileext=".html"); writeLines("test", tf); getOption("viewer")(tf)\n');
        await waitFor(() => createWebviewPanelSpy.calledWith('webview'), 10000, 200);

        assert.ok(createWebviewPanelSpy.calledWith('webview'), 'webview should be triggered for html file');

    }).timeout(45000);

    test('attach session artifacts are owner-only', async () => {
        const command = await session.getAttachSessionCommand();
        const commandMatch = command.match(/^source\((.*)\)$/);
        if (!commandMatch) {
            throw new Error('attach command should be a source(...) call');
        }

        const scriptPath = JSON.parse(commandMatch[1]) as string;
        const scriptContent = await fs.readFile(scriptPath, 'utf8');
        assert.match(scriptContent, /sess::connect\(endpoint = endpoint/);
        assert.strictEqual(path.dirname(scriptPath), path.join(extension.extensionContext.globalStorageUri.fsPath, 'tmp', 'attach'));
        const scriptStat = await fs.stat(scriptPath);
        if (process.platform !== 'win32') {
            assert.strictEqual(scriptStat.mode & 0o777, 0o600, 'attach script should be owner-only');
        }

        const pipePath = session.globalPipePath;
        assert.ok(pipePath, 'global pipe path should be set');

        if (pipePath && process.platform !== 'win32') {
            const pipeStat = await fs.stat(pipePath);
            assert.strictEqual(pipeStat.mode & 0o777, 0o600, 'socket file should be owner-only');
        }

        const sessionFilePath = await session.createSessionDiscoveryFile(pipePath ?? '');
        assert.strictEqual(path.dirname(sessionFilePath), path.join(extension.extensionContext.globalStorageUri.fsPath, 'sessions'));
        assert.match(path.basename(sessionFilePath), /^[a-f0-9]{32}\.json$/);
        assert.deepStrictEqual(await fs.readJson(sessionFilePath), {
            version: 1, endpoint: pipePath ?? '',
            jgdSocket: plotViewer.jgdEnabled()
                ? (extension.globalPlotManager as plotViewer.CommonPlotManager).getJgdEnvVars()['JGD_SOCKET'] : '',
        });
        const sessionFileStat = await fs.stat(sessionFilePath);
        if (process.platform !== 'win32') {
            assert.strictEqual(sessionFileStat.mode & 0o777, 0o600, 'session handoff file should be owner-only');
        }
        await fs.remove(sessionFilePath);

        await session.shutdownSessionWatcher();
    }).timeout(15000);

    test('reconnecting terminals preserve the selected terminal in either attach order', async () => {
        const endpoint = await session.getGlobalPipePath();
        const selected = { processId: Promise.resolve(46240) };
        const background = { processId: Promise.resolve(46241) };
        sandbox.stub(vscode.window, 'terminals').value([selected, background]);
        sandbox.stub(vscode.window, 'activeTerminal').value(selected);

        for (const order of [[46240, 46241], [46241, 46240]]) {
            const clients: net.Socket[] = [];
            const sockets: net.Socket[] = [];
            try {
                for (const terminalPid of order) {
                    const existing = new Set(session.activeConnections);
                    const client = net.createConnection(endpoint);
                    clients.push(client);
                    await new Promise<void>((resolve, reject) => {
                        client.once('connect', resolve);
                        client.once('error', reject);
                    });
                    const socket = await waitFor(() => [...session.activeConnections].find(s => !existing.has(s)));
                    assert.ok(socket);
                    sockets.push(socket);
                    const id = `reconnected-${terminalPid}`;
                    client.write(`${JSON.stringify({
                        jsonrpc: '2.0', method: 'attach', params: {
                            protocol_version: 1, session_id: id, host: os.hostname(),
                            pid: terminalPid, version: '4.4.0', tempdir: '/tmp', wd: '/tmp',
                        },
                    })}\n`);
                    await waitFor(() => socket._sessionId === id);
                    if (terminalPid === 46241 && order[0] === 46240) {
                        assert.strictEqual(session.activeSession?.sessionId, 'reconnected-46240');
                    }
                }
                assert.strictEqual(session.activeSession?.sessionId, 'reconnected-46240');
            } finally {
                clients.forEach(client => client.destroy());
                sockets.forEach(socket => socket.destroy());
                for (const terminalPid of order) {
                    await session.cleanupSession(`reconnected-${terminalPid}`);
                }
            }
        }
    });

    test('manual recovery targets the selected managed terminal while another session is active', async () => {
        const endpoint = await session.getGlobalPipePath();
        const first = {
            name: 'R Interactive', processId: Promise.resolve(45240),
            creationOptions: { name: 'R Interactive' }, show: sandbox.spy(), sendText: sandbox.spy(),
        };
        const second = {
            name: 'Renamed R', processId: Promise.resolve(45241),
            creationOptions: { name: 'R Interactive' }, show: sandbox.spy(), sendText: sandbox.spy(),
        };
        sandbox.stub(vscode.window, 'terminals').value([first, second]);
        const activeTerminal = sandbox.stub(vscode.window, 'activeTerminal').value(second);
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'sessionWatcher' ? true : undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        const discoveryFile = await session.createSessionDiscoveryFile(endpoint);
        await session.updateSessionDiscoveryFile(discoveryFile, endpoint, 45241);
        const client = net.createConnection(endpoint);
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            });
            client.write(`${JSON.stringify({
                jsonrpc: '2.0', method: 'attach', params: {
                    protocol_version: 1, session_id: 'manual-recovery-first',
                    host: os.hostname(), pid: 45240, version: '4.5.0',
                    tempdir: os.tmpdir(), wd: os.tmpdir(),
                    info: { version: 'R 4.5.0', command: 'R', start_time: '' },
                },
            })}\n`);
            await waitFor(() => session.activeSession?.sessionId === 'manual-recovery-first');
            await session.activateRSession();
            sinon.assert.calledOnce(second.sendText);
            sinon.assert.calledOnce(second.show);
            sinon.assert.notCalled(first.sendText);
            sinon.assert.notCalled(first.show);

            // An attached terminal still activates its own session without sending R code.
            activeTerminal.value(first);
            await session.activateRSession();
            sinon.assert.calledOnce(first.show);
            sinon.assert.notCalled(first.sendText);

            // The R Interactive name alone must not grant ownership of another terminal.
            first.show.resetHistory();
            activeTerminal.value({ ...second, name: 'R Interactive', processId: Promise.resolve(45242) });
            await session.activateRSession();
            sinon.assert.calledOnce(first.show);
            sinon.assert.calledOnce(second.sendText);
        } finally {
            client.destroy();
            await session.cleanupSession('manual-recovery-first');
            await fs.remove(discoveryFile);
        }
    });

    test('reload rewrites the same extension-owned discovery file using terminal PID metadata', async () => {
        const oldEndpoint = await session.getGlobalPipePath();
        const discoveryFile = await session.createSessionDiscoveryFile(oldEndpoint);
        const terminalPid = 45231; // Deliberately distinct from any R process PID.
        await session.updateSessionDiscoveryFile(discoveryFile, oldEndpoint, terminalPid);
        const newEndpoint = `${oldEndpoint}.reload`;
        const { jgdSocket } = await fs.readJson(discoveryFile) as { jgdSocket: string };
        const terminal = {
            name: 'R Interactive',
            processId: Promise.resolve(terminalPid),
            creationOptions: { name: 'R Interactive', env: { SESS_DISCOVERY_FILE: discoveryFile } },
        } as unknown as vscode.Terminal;
        let wrapperDiscoveryFile: string | undefined;
        try {
            await session.refreshTerminalDiscoveryFiles(newEndpoint, [terminal]);

            assert.deepStrictEqual(await fs.readJson(discoveryFile), {
                version: 1,
                endpoint: newEndpoint,
                terminalPid,
                jgdSocket,
            });

            // Restored VS Code terminals may not expose creationOptions.env. The
            // extension-owned terminal PID metadata must still locate the same file.
            wrapperDiscoveryFile = await session.createSessionDiscoveryFile(oldEndpoint);
            const wrapperTerminalPid = 45233;
            await session.updateSessionDiscoveryFile(wrapperDiscoveryFile, oldEndpoint, wrapperTerminalPid);
            const wrapperTerminal = {
                name: 'R Interactive',
                processId: Promise.resolve(wrapperTerminalPid),
                creationOptions: { name: 'R Interactive' },
            } as unknown as vscode.Terminal;
            await session.refreshTerminalDiscoveryFiles(newEndpoint, [wrapperTerminal]);
            assert.deepStrictEqual(await fs.readJson(wrapperDiscoveryFile), {
                version: 1,
                endpoint: newEndpoint,
                terminalPid: wrapperTerminalPid,
                jgdSocket,
            });
        } finally {
            await fs.remove(discoveryFile);
            if (wrapperDiscoveryFile) {
                await fs.remove(wrapperDiscoveryFile);
            }
        }
    });

    test('reload publishes the current JGD socket and explicitly clears a disabled renderer', async () => {
        let backend = 'jgd';
        let jgdSocket = 'old-jgd-socket';
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'plot.backend' ? backend : undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(extension.globalPlotManager as plotViewer.CommonPlotManager, 'getJgdEnvVars')
            .callsFake(() => ({ JGD_SOCKET: jgdSocket }));
        const file = await session.createSessionDiscoveryFile('old-sess');
        const terminal = {
            name: 'Renamed R', processId: Promise.resolve(45244),
            creationOptions: { name: 'R Interactive' },
        } as unknown as vscode.Terminal;
        try {
            await session.updateSessionDiscoveryFile(file, 'old-sess', 45244);
            jgdSocket = 'new-jgd-socket';
            await session.refreshTerminalDiscoveryFiles('new-sess', [terminal]);
            assert.deepStrictEqual(await fs.readJson(file), {
                version: 1, endpoint: 'new-sess', terminalPid: 45244, jgdSocket,
            });
            backend = 'standard';
            await session.refreshTerminalDiscoveryFiles('next-sess', [terminal]);
            assert.deepStrictEqual(await fs.readJson(file), {
                version: 1, endpoint: 'next-sess', terminalPid: 45244, jgdSocket: '',
            });
        } finally {
            await fs.remove(file);
        }
    });

    test('reload chooses the newest discovery file when terminal PID metadata is duplicated', async () => {
        const oldEndpoint = await session.getGlobalPipePath();
        const newEndpoint = `${oldEndpoint}.reload`;
        const terminalPid = 45235;
        const olderFile = await session.createSessionDiscoveryFile(oldEndpoint);
        const newerFile = await session.createSessionDiscoveryFile(oldEndpoint);
        const olderTime = new Date(Date.now() - 10_000);
        const newerTime = new Date(Date.now() - 5_000);
        try {
            await session.updateSessionDiscoveryFile(olderFile, oldEndpoint, terminalPid);
            await session.updateSessionDiscoveryFile(newerFile, oldEndpoint, terminalPid);
            await fs.utimes(olderFile, olderTime, olderTime);
            await fs.utimes(newerFile, newerTime, newerTime);

            const terminal = {
                name: 'R Interactive',
                processId: Promise.resolve(terminalPid),
                creationOptions: { name: 'R Interactive' },
            } as unknown as vscode.Terminal;
            await session.refreshTerminalDiscoveryFiles(newEndpoint, [terminal]);

            const olderDiscovery: unknown = await fs.readJson(olderFile);
            const newerDiscovery: unknown = await fs.readJson(newerFile);
            assert.ok(typeof olderDiscovery === 'object' && olderDiscovery !== null && 'endpoint' in olderDiscovery);
            assert.ok(typeof newerDiscovery === 'object' && newerDiscovery !== null && 'endpoint' in newerDiscovery);
            assert.strictEqual(olderDiscovery.endpoint, oldEndpoint);
            assert.strictEqual(newerDiscovery.endpoint, newEndpoint);
        } finally {
            await fs.remove(olderFile);
            await fs.remove(newerFile);
        }
    });

    test('IPC protocol keys sessions by session_id and ignores close from a replaced socket', async () => {
        const endpoint = await session.getGlobalPipePath();
        const first = net.createConnection(endpoint);
        let second: net.Socket | undefined;
        let third: net.Socket | undefined;
        const sendAttach = async (socket: net.Socket, pid: number) => {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('error', reject);
            });
            socket.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'attach',
                params: {
                    protocol_version: 1,
                    session_id: 'stable-session-id',
                    host: 'remote-compute-node',
                    sess_version: '3.0.0',
                    pid,
                    version: 'R 4.4.0',
                    info: { version: '4.4.0', command: 'R', start_time: 'now' },
                    tempdir: '/tmp/session',
                    wd: '/workspace'
                }
            })}\n`);
        };

        try {
            await sendAttach(first, 1234);
            await waitFor(() => session.activeSession?.sessionId === 'stable-session-id');
            assert.strictEqual(session.activeSession?.pid, '1234');
            assert.strictEqual(session.activeSession?.host, 'remote-compute-node');
            const originalSession = session.activeSession;
            if (!originalSession) {
                throw new Error('original session should have attached');
            }

            const reconnect = net.createConnection(endpoint);
            second = reconnect;
            await sendAttach(reconnect, 9876);
            await waitFor(() => session.activeSession?.pid === '9876');
            assert.strictEqual(session.activeSession?.sessionId, 'stable-session-id');
            assert.strictEqual(session.activeSession?.pid, '9876');
            const replacementSession = session.activeSession;

            await session.cleanupSession('stable-session-id', originalSession.socket);
            assert.strictEqual(session.activeSession, replacementSession, 'cleanup from the old socket must not remove the replacement session');

            first.destroy();
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.strictEqual(session.activeSession, replacementSession, 'old socket close must not clear the replacement session');

            const otherSession = net.createConnection(endpoint);
            third = otherSession;
            await new Promise<void>((resolve, reject) => {
                otherSession.once('connect', resolve);
                otherSession.once('error', reject);
            });
            otherSession.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'attach',
                params: {
                    protocol_version: 1,
                    session_id: 'other-session-id',
                    host: 'other-compute-node',
                    sess_version: '3.0.0',
                    pid: 9876,
                    version: 'R 4.4.0',
                    info: { version: '4.4.0', command: 'R', start_time: 'now' },
                    tempdir: '/tmp/other-session',
                    wd: '/workspace'
                }
            })}\n`);
            await waitFor(() => session.activeSession?.sessionId === 'other-session-id');
            assert.strictEqual(session.activeSession?.pid, '9876', 'distinct session ids can share an R PID');

            second.destroy();
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.strictEqual(session.activeSession?.sessionId, 'other-session-id', 'closing a different session must not affect the active session');

            third.destroy();
            await waitFor(() => !session.activeSession);
        } finally {
            first.destroy();
            second?.destroy();
            third?.destroy();
        }
    }).timeout(15000);

    test('rejects a different session attaching on an already-bound IPC socket', async () => {
        const showError = sandbox.stub(vscode.window, 'showErrorMessage');
        const endpoint = await session.getGlobalPipePath();
        const client = net.createConnection(endpoint);
        const sendAttach = (sessionId: string) => client.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'attach',
            params: {
                protocol_version: 1,
                session_id: sessionId,
                host: 'remote-compute-node',
                sess_version: '3.0.0',
                pid: 1234,
                version: 'R 4.4.0',
                info: { version: '4.4.0', command: 'R', start_time: 'now' },
                tempdir: '/tmp/session',
                wd: '/workspace'
            }
        })}\n`);

        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            });
            sendAttach('session-a');
            await waitFor(() => session.activeSession?.sessionId === 'session-a');
            const attachedSession = session.activeSession;
            if (!attachedSession) {
                throw new Error('session A should have attached');
            }
            const boundSocket = attachedSession.socket;

            sendAttach('session-b');
            await waitFor(() => showError.called);
            assert.match(String(showError.firstCall.args[0]), /already bound to session session-a/);
            await waitFor(() => !session.activeSession);
            await waitFor(() => !session.activeConnections.has(boundSocket));
            assert.notStrictEqual(session.activeSession?.sessionId, 'session-b');
        } finally {
            client.destroy();
        }
    }).timeout(10000);

    test('rejects an incompatible attach protocol version', async () => {
        const showError = sandbox.stub(vscode.window, 'showErrorMessage');
        const endpoint = await session.getGlobalPipePath();
        const client = net.createConnection(endpoint);
        try {
            await new Promise<void>((resolve, reject) => {
                client.once('connect', resolve);
                client.once('error', reject);
            });
            client.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'attach',
                params: { protocol_version: 2, session_id: 'future-session' }
            })}\n`);
            await waitFor(() => showError.called);
            assert.match(String(showError.firstCall.args[0]), /unsupported sess protocol version 2/);
            assert.notStrictEqual(session.activeSession?.sessionId, 'future-session');
        } finally {
            client.destroy();
        }
    }).timeout(10000);
});
