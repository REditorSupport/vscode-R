import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { JgdManager } from '../../plotViewer/jgdViewer';
import type { JgdMessage } from '../../plotViewer/jgdSocketServer';
import type { PlotFrame, PlotHistoryState } from '../../plotViewer/jgdPlotHistory';
import { HttpgdClient } from '../../plotViewer/httpgdClient';
import { HttpgdViewer } from '../../plotViewer/httpgdViewer';
import type { HttpgdPlot } from '../../plotViewer/httpgdTypes';
import { extensionContext } from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, waitForValue } from '../common/sessionConnections';
import { sessionProcessIdentity } from '../../sessionIdentity';
import type { ViewerSessionSource } from '../../viewerSession';

const createRealWebviewPanel = vscode.window.createWebviewPanel;
const executeRealCommand = vscode.commands.executeCommand;

async function prepareEditorLayout(): Promise<void> {
    // Sidebars and the panel can leave too little space on CI desktops: VS Code
    // clamps different requested group sizes to the same minimum dimensions.
    await executeRealCommand('workbench.action.closeSidebar');
    await executeRealCommand('workbench.action.closeAuxiliaryBar');
    await executeRealCommand('workbench.action.closePanel');
}

class RefreshViewer extends HttpgdViewer {
    seedPlots(plots: HttpgdPlot<string>[]): void {
        this.setPlots(plots);
    }

    receivePlots(ids: string[], changed?: ReadonlySet<string>, force = false): Promise<void> {
        return this.refreshPlots(
            ids.map((id) => ({ id })),
            false,
            force,
            undefined,
            changed,
        );
    }
}

class LayoutViewer extends HttpgdViewer {
    protected override makeHtml(): string {
        return super.makeHtml().replace(
            '<head>',
            `<head><script>
            const testApi = acquireVsCodeApi();
            window.acquireVsCodeApi = () => testApi;
            window.addEventListener('message', async ({ data }) => {
                if (data.message !== 'inspect-layout') return;
                if (data.dragHeight !== undefined) {
                    const handler = document.getElementById('handler');
                    const plot = document.getElementById('largePlot');
                    const bounds = handler.getBoundingClientRect();
                    const startY = bounds.top + bounds.height / 2;
                    handler.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: startY }));
                    document.dispatchEvent(new MouseEvent('mousemove', {
                        clientY: startY + data.dragHeight - plot.clientHeight,
                        bubbles: true
                    }));
                    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                }
                await new Promise(requestAnimationFrame);
                const plot = document.getElementById('largePlot');
                testApi.postMessage({ message: 'layout-inspection',
                    width: plot.clientWidth, height: plot.clientHeight,
                    windowWidth: innerWidth, windowHeight: innerHeight,
                    fullWindow: document.body.classList.contains('fullWindow') });
            });
        </script>`,
        );
    }
}

suite('Standalone plot restoration', () => {
    let sandbox: sinon.SinonSandbox;
    let state: Map<string, unknown>;
    let storageDirectory: string;
    let secrets: Map<string, string>;
    let managers: CommonPlotManager[];
    let connect: sinon.SinonStub;
    let callbacks: Map<string, (...args: unknown[]) => Promise<void>>;
    let panels: Array<{
        panel: vscode.WebviewPanel;
        receive: (message: unknown) => Promise<void>;
        post: sinon.SinonStub;
    }>;

    setup(async () => {
        sandbox = sinon.createSandbox();
        state = new Map();
        secrets = new Map();
        managers = [];
        callbacks = new Map();
        panels = [];
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'plot-cache-test-'));
        Object.defineProperty(extensionContext, 'storageUri', {
            value: vscode.Uri.file(storageDirectory),
        });
        (extensionContext.workspaceState.get as sinon.SinonStub).callsFake(
            (key: string, fallback?: unknown) => state.get(key) ?? fallback,
        );
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            (key: string, value: unknown) => {
                state.set(key, structuredClone(value));
                return Promise.resolve();
            },
        );
        (extensionContext.secrets.get as sinon.SinonStub).callsFake((key: string) =>
            Promise.resolve(secrets.get(key)),
        );
        (extensionContext.secrets.store as sinon.SinonStub).callsFake(
            (key: string, value: string) => {
                secrets.set(key, value);
                return Promise.resolve();
            },
        );
        (extensionContext.secrets.delete as sinon.SinonStub).callsFake((key: string) => {
            secrets.delete(key);
            return Promise.resolve();
        });
        sandbox.stub(vscode.commands, 'registerCommand').callsFake((command, callback) => {
            callbacks.set(command, callback as (...args: unknown[]) => Promise<void>);
            return new vscode.Disposable(() => {});
        });
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(JgdManager.prototype, 'start');
        connect = sandbox.stub(HttpgdClient.prototype, 'connect').resolves();
        sandbox.stub(util, 'config').returns({
            get: (_key: string, fallback: unknown) => fallback,
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((viewType, title) => {
            const panelId = panels.length;
            const disposed = new vscode.EventEmitter<void>();
            const listeners = new Set<(message: unknown) => unknown>();
            const post = sandbox.stub().resolves(true);
            const panel = {
                title,
                viewType,
                active: true,
                reveal: sandbox.stub(),
                webview: {
                    html: '',
                    postMessage: post,
                    asWebviewUri: (uri: vscode.Uri) =>
                        uri.with({
                            scheme: 'https',
                            authority: `panel${panelId}.vscode-resource.vscode-cdn.net`,
                        }),
                    onDidReceiveMessage: (callback: (message: unknown) => unknown) => {
                        listeners.add(callback);
                        return new vscode.Disposable(() => {
                            listeners.delete(callback);
                        });
                    },
                },
                onDidDispose: disposed.event,
                onDidChangeViewState: () => new vscode.Disposable(() => {}),
                dispose: () => disposed.fire(),
            } as unknown as vscode.WebviewPanel;
            panels.push({
                panel,
                post,
                receive: async (message) => {
                    await Promise.all([...listeners].map((listener) => listener(message)));
                },
            });
            return panel;
        });
    });

    teardown(async () => {
        for (const manager of managers) {
            await manager.dispose();
        }
        for (const { panel } of panels) {
            panel.dispose();
        }
        sandbox.restore();
        await fs.rm(storageDirectory, { recursive: true, force: true });
    });

    async function manager(): Promise<CommonPlotManager> {
        const value = new CommonPlotManager();
        await value.initialize();
        managers.push(value);
        return value;
    }

    async function checkpoint(value: CommonPlotManager): Promise<void> {
        await (value as unknown as { historyWrites?: Promise<void> }).historyWrites;
        await (value.httpgdManager as unknown as { connectionWrites: Promise<void> })
            .connectionWrites;
    }

    function owner(id: string, pid: string): session.Session {
        return {
            sessionId: id,
            host: 'external-host',
            pid,
            rVer: 'R version 4.6.0 (2026-04-24)',
            processExited: false,
        } as session.Session;
    }

    function focus(source: session.Session): void {
        sandbox.stub(session, 'activeSession').value(source);
    }

    function processExits() {
        const exited = new Set<string>();
        const listeners = new Map<string, Set<() => void>>();
        sandbox.stub(session, 'getViewerSessionContext').callsFake((_id, source) => {
            if (!source) {
                return undefined;
            }
            const key = sessionProcessIdentity(source);
            let callbacks = listeners.get(key);
            if (!callbacks) {
                callbacks = new Set();
                listeners.set(key, callbacks);
            }
            const observers = callbacks;
            return {
                source,
                sessionId: source.sessionId,
                get hasExited() {
                    return exited.has(key);
                },
                observeExit: (callback) => {
                    observers.add(callback);
                    return { dispose: () => observers.delete(callback) };
                },
                attach: () => {},
                getHtml: () => '',
            };
        });
        return {
            exit(source: ViewerSessionSource) {
                const key = sessionProcessIdentity(source);
                exited.add(key);
                for (const callback of listeners.get(key) ?? []) {
                    callback();
                }
            },
            listeners,
        };
    }

    for (const backend of ['jgd', 'httpgd', 'standard'] as const) {
        for (const closeFirst of [false, true]) {
            test(`${backend} deletes history and saved state without altering the rendered document on R exit with closeFirst=${closeFirst}`, async () => {
                const exits = processExits();
                const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                const value = await manager();
                const source = owner('lifecycle', '123');
                if (backend === 'jgd') {
                    value.jgdManager.history.addPlot('device', frame('device'));
                    value.jgdManager.history.setSessionSource('device', source);
                    value.jgdManager.showForSession(source);
                } else if (backend === 'httpgd') {
                    await value.showHttpgdPlot('http://localhost:1234?token=secret', source);
                    value.httpgdManager.viewers[0].show();
                } else {
                    await value.showStandardPlot(source);
                }
                const panel = panels[0].panel;
                assert.ok(panel.webview.html.length > 0);
                const rendered = panel.webview.html;
                const close = sandbox.spy(panel, 'dispose');
                if (closeFirst) {
                    panel.dispose();
                }
                await clock.tickAsync(250);
                await checkpoint(value);
                const captured: ViewerSessionSource = {
                    sessionId: source.sessionId,
                    host: source.host,
                    pid: source.pid,
                    rVer: source.rVer,
                    processExited: source.processExited,
                };
                // Detaching a Session clears transport metadata before its
                // original process can exit. Cleanup must retain that identity.
                source.pid = '';
                source.rVer = '';
                exits.exit(captured);
                assert.strictEqual(value.viewers.length, 0, 'exit releases viewers immediately');
                await clock.tickAsync(250);
                assert.strictEqual(
                    close.callCount,
                    closeFirst ? 1 : 0,
                    "R exit must not close the user's viewer tab",
                );
                if (!closeFirst) {
                    assert.strictEqual(
                        panel.webview.html,
                        rendered,
                        'the rendered document is unchanged',
                    );
                }
                if (backend === 'jgd') {
                    assert.deepStrictEqual(
                        (state.get('r.plot.jgdState') as PlotHistoryState).sessions,
                        [],
                    );
                } else if (backend === 'httpgd') {
                    await value.httpgdManager.saveConnections();
                    assert.strictEqual(secrets.size, 0);
                } else {
                    assert.deepStrictEqual(state.get('r.plot.standardSessions'), []);
                }
                assert.strictEqual(value.viewers.length, 0);
                assert.strictEqual(exits.listeners.get(sessionProcessIdentity(captured))!.size, 0);
                if (!closeFirst) {
                    panel.dispose();
                }
                await value.dispose();
                const restored = await manager();
                assert.strictEqual(restored.viewers.length, 0);
                assert.strictEqual(restored.jgdManager.history.sessionIds().length, 0);
            });
        }
    }

    test('all engines share one process-exit observer and release their backing data together', async () => {
        const exits = processExits();
        const value = await manager();
        const source = owner('shared-lifetime', '123');
        await value.showStandardPlot(source);
        await value.showHttpgdPlot('http://localhost:1234', source);
        const httpgd = value.httpgdManager.viewers[0];
        RefreshViewer.prototype.seedPlots.call(httpgd, [
            { id: '1', data: '<svg/>', width: 800, height: 600, zoom: 1 },
        ]);
        httpgd.activePlot = '1';
        value.jgdManager.history.addPlot('device', frame('device'));
        value.jgdManager.history.setSessionSource('device', source);
        const jgd = value.jgdManager.getViewer('device')!;
        const releaseHttpgd = sandbox.spy(httpgd, 'dispose');
        const releaseJgd = sandbox.spy(jgd, 'dispose');
        assert.strictEqual(exits.listeners.get(sessionProcessIdentity(source))!.size, 1);
        exits.exit(source);
        sinon.assert.calledOnce(releaseHttpgd);
        sinon.assert.calledOnce(releaseJgd);
        assert.deepStrictEqual(httpgd.plots, []);
        assert.strictEqual(httpgd.activePlot, undefined);
        assert.deepStrictEqual(value.jgdManager.history.sessionIds(), []);
        assert.deepStrictEqual(value.viewers, []);
        assert.strictEqual(exits.listeners.get(sessionProcessIdentity(source))!.size, 0);
    });

    for (const closeFirst of [false, true]) {
        test(`JGD clears exited session history with viewer ${closeFirst ? 'closed' : 'open'}`, async () => {
            const exits = processExits();
            const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const value = await manager();
            const disconnect = sandbox.spy(value.jgdManager.server, 'disconnect');
            const source = owner('dead', '123');
            const live = owner('live', '456');
            for (const [id, owner] of [
                ['a', source],
                ['b', source],
                ['c', live],
            ] as const) {
                value.jgdManager.history.addPlot(id, frame(id));
                value.jgdManager.history.setSessionSource(id, owner);
            }
            value.jgdManager.showForSession(source);
            const panel = panels[0].panel;
            if (closeFirst) {
                panel.dispose();
            }
            await clock.tickAsync(250);
            await checkpoint(value);
            exits.exit(source);
            assert.deepStrictEqual(
                disconnect.getCalls().map((call) => call.args[0]),
                ['a', 'b'],
            );
            assert.strictEqual(value.jgdManager.history.count('a'), 0);
            assert.strictEqual(value.jgdManager.history.count('b'), 0);
            assert.strictEqual(value.jgdManager.showForSession(source), false);
            await clock.tickAsync(250);
            await checkpoint(value);
            const saved = state.get('r.plot.jgdState') as PlotHistoryState;
            assert.deepStrictEqual(
                saved.sessions.map((entry) => entry.id),
                ['c'],
            );
            assert.deepStrictEqual(value.jgdManager.history.sessionIds(), ['c']);
            assert.strictEqual(exits.listeners.get(sessionProcessIdentity(source))!.size, 0);
            await value.dispose();
            assert.deepStrictEqual((await manager()).jgdManager.history.sessionIds(), ['c']);
        });
    }

    test('JGD watches restored closed viewers and preserves temporary disconnections', async () => {
        const exits = processExits();
        const source = owner('saved', '123');
        const first = await manager();
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        await first.dispose();
        const restored = await manager();
        assert.strictEqual(restored.jgdManager.history.count('device'), 1);
        assert.strictEqual(restored.jgdManager.getViewers().length, 0);
        assert.strictEqual(exits.listeners.get(sessionProcessIdentity(source))!.size, 1);
        // Disconnection is not an exit; only the authoritative exit observer clears history.
        assert.strictEqual(restored.jgdManager.server.isConnected('device'), false);
        exits.exit(source);
        assert.deepStrictEqual(restored.jgdManager.history.sessionIds(), []);
        await restored.dispose();
        assert.deepStrictEqual((state.get('r.plot.jgdState') as PlotHistoryState).sessions, []);
    });

    test('JGD corrects a saved checkpoint when exit was already confirmed before restoration', async () => {
        const exits = processExits();
        const source = owner('saved', '123');
        const first = await manager();
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        await first.dispose();
        exits.exit(source);
        const restored = await manager();
        assert.deepStrictEqual(restored.jgdManager.history.sessionIds(), []);
        await restored.dispose();
        assert.deepStrictEqual((state.get('r.plot.jgdState') as PlotHistoryState).sessions, []);
    });

    test('JGD exit during a checkpoint removes stale saved frames after the write completes', async () => {
        const exits = processExits();
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const gate = deferred<void>();
        const started = deferred<void>();
        let writes = 0;
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            async (key: string, data: unknown) => {
                if (key === 'r.plot.jgdState' && ++writes === 1) {
                    started.resolve();
                    await gate.promise;
                }
                state.set(key, structuredClone(data));
            },
        );
        const value = await manager();
        const source = owner('pending-exit', '123');
        value.jgdManager.history.addPlot('device', frame('device'));
        value.jgdManager.history.setSessionSource('device', source);
        await clock.tickAsync(250);
        await started.promise;
        assert.strictEqual(writes, 1);
        exits.exit(source);
        gate.resolve();
        await value.dispose();
        assert.deepStrictEqual((state.get('r.plot.jgdState') as PlotHistoryState).sessions, []);
    });

    test('JGD exit during httpgd initialization removes its saved checkpoint and payload', async () => {
        const exits = processExits();
        const source = owner('initializing-exit', '123');
        const first = await manager();
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        await first.dispose();
        const cacheDirectory = path.join(storageDirectory, 'plot-cache');
        assert.strictEqual((await fs.readdir(cacheDirectory)).length, 1);

        const restored = new CommonPlotManager();
        managers.push(restored);
        const started = deferred<void>();
        const gate = deferred<void>();
        const initialize = restored.httpgdManager.initialize.bind(restored.httpgdManager);
        sandbox.stub(restored.httpgdManager, 'initialize').callsFake(async () => {
            started.resolve();
            await gate.promise;
            await initialize();
        });
        const initializing = restored.initialize();
        try {
            await started.promise;
            assert.strictEqual(restored.jgdManager.history.count('device'), 1);
            exits.exit(source);
            assert.deepStrictEqual(restored.jgdManager.history.sessionIds(), []);
        } finally {
            gate.resolve();
            await initializing;
        }
        await restored.dispose();
        assert.deepStrictEqual((state.get('r.plot.jgdState') as PlotHistoryState).sessions, []);
        assert.deepStrictEqual(await fs.readdir(cacheDirectory), []);
    });

    test('httpgd process exit clears history, connections and saved credentials without affecting other owners', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const replacement = owner(source.sessionId, '14002');
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234?token=old-1', source);
        await value.showHttpgdPlot('http://localhost:1235?token=old-2', source);
        const old = [...value.httpgdManager.viewers];
        old[0].show();
        const panel = old[0].webviewPanel;
        const rendered = panel!.webview.html;
        const close = sandbox.spy(panel!, 'dispose');
        const disconnects = old.map((viewer) => sandbox.spy(viewer.api, 'disconnect'));
        await value.showHttpgdPlot('http://localhost:1236?token=replacement', replacement);
        await value.httpgdManager.showViewer('http://localhost:1237?token=unowned');
        exits.exit(source);
        await value.httpgdManager.saveConnections();
        for (const disconnect of disconnects) {
            sinon.assert.calledOnce(disconnect);
        }
        sinon.assert.notCalled(close);
        assert.strictEqual(panel!.webview.html, rendered);
        assert.strictEqual(old[0].webviewPanel, undefined);
        assert.deepStrictEqual(old[0].plots, []);
        assert.deepStrictEqual(old[0].api.getPlots(), []);
        assert.strictEqual(value.httpgdManager.viewers.length, 2);
        assert.ok(
            old.every((viewer) => !value.httpgdManager.recentlyActiveViewers.includes(viewer)),
        );
        const saved = JSON.parse([...secrets.values()][0]) as Array<{
            source?: ViewerSessionSource;
        }>;
        assert.strictEqual(saved.length, 2);
        assert.ok(saved.some((connection) => connection.source?.pid === replacement.pid));
        assert.ok(saved.some((connection) => !connection.source));
        await value.dispose();
        const restored = await manager();
        assert.strictEqual(await restored.httpgdManager.restoreConnection(source), undefined);
        assert.ok(await restored.httpgdManager.restoreConnection(replacement));
    });

    test('httpgd saved connections are cleaned on exit even without reopening a viewer', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await first.dispose();
        const restored = await manager();
        await restored.httpgdManager.saveConnections();
        assert.strictEqual(restored.httpgdManager.viewers.length, 0);
        assert.strictEqual(secrets.size, 1, 'reload preserves the live session');
        connect.resetHistory();
        exits.exit(source);
        await waitForValue(() =>
            secrets.size === 0 && !state.get('r.plot.httpgdConnectionsKey') ? true : undefined,
        );
        await restored.httpgdManager.saveConnections();
        assert.strictEqual(secrets.size, 0);
        assert.strictEqual(state.get('r.plot.httpgdConnectionsKey'), undefined);
        assert.strictEqual(exits.listeners.get(sessionProcessIdentity(source))?.size, 0);
        assert.strictEqual(await restored.httpgdManager.restoreConnection(source), undefined);
        sinon.assert.notCalled(connect);
    });

    test('httpgd exit during credential loading prevents a pending restore from reconnecting', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await first.dispose();
        const saved = [...secrets.values()][0];
        let load!: (value: string) => void;
        (extensionContext.secrets.get as sinon.SinonStub).returns(
            new Promise<string>((resolve) => {
                load = resolve;
            }),
        );
        const restored = await manager();
        const pending = restored.httpgdManager.restoreConnection(source);
        exits.exit(source);
        connect.resetHistory();
        load(saved);
        assert.strictEqual(await pending, undefined);
        await restored.httpgdManager.saveConnections();
        assert.strictEqual(secrets.size, 0);
        assert.strictEqual(state.get('r.plot.httpgdConnectionsKey'), undefined);
        sinon.assert.notCalled(connect);
    });

    test('httpgd exit during a credential write removes that write after it completes', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const value = await manager();
        let stored!: () => void;
        let started!: () => void;
        const writing = new Promise<void>((resolve) => {
            started = resolve;
        });
        (extensionContext.secrets.store as sinon.SinonStub).onFirstCall().callsFake(
            (key: string, data: string) =>
                new Promise<void>((resolve) => {
                    stored = () => {
                        secrets.set(key, data);
                        resolve();
                    };
                    started();
                }),
        );
        const opening = value.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await writing;
        exits.exit(source);
        stored();
        await opening;
        await value.httpgdManager.saveConnections();
        assert.strictEqual(secrets.size, 0);
        assert.strictEqual(state.get('r.plot.httpgdConnectionsKey'), undefined);
        assert.deepStrictEqual(value.httpgdManager.viewers, []);
    });

    for (const failure of ['read', 'json', 'shape'] as const) {
        test(`httpgd ${failure} failure is reported and cannot erase saved credentials`, async () => {
            const source = owner('httpgd-owner', '14001');
            const key = 'saved-connections';
            const saved = failure === 'json' ? '{"token":"must-not-be-reported"' : '{}';
            state.set('r.plot.httpgdConnectionsKey', key);
            secrets.set(key, saved);
            if (failure === 'read') {
                (extensionContext.secrets.get as sinon.SinonStub).rejects(new Error('read failed'));
            }
            const report = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
            sandbox.stub(console, 'warn');
            const value = await manager();
            await assert.rejects(value.httpgdManager.restoreConnection(source), {
                message: 'Could not load saved httpgd plot connections.',
            });
            sinon.assert.calledOnce(report);
            assert.deepStrictEqual(report.firstCall.args, [
                'Could not load saved httpgd plot connections.',
            ]);
            await value.httpgdManager.saveConnections();
            // A newly announced device still works, but must not overwrite
            // credentials for other sessions that could not be read.
            await value.showHttpgdPlot('http://localhost:1234?token=new-device', source);
            assert.ok(await value.httpgdManager.restoreConnection(source));
            await value.dispose();
            assert.strictEqual(state.get('r.plot.httpgdConnectionsKey'), key);
            assert.strictEqual(secrets.get(key), saved);
            assert.strictEqual((extensionContext.secrets.store as sinon.SinonStub).callCount, 0);
            assert.strictEqual((extensionContext.secrets.delete as sinon.SinonStub).callCount, 0);
        });
    }

    test('a missing httpgd secret is empty storage and accepts a new connection', async () => {
        const source = owner('httpgd-owner', '14001');
        state.set('r.plot.httpgdConnectionsKey', 'missing-secret');
        const report = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const value = await manager();
        assert.strictEqual(await value.httpgdManager.restoreConnection(source), undefined);
        await value.showHttpgdPlot('http://localhost:1234?token=new-device', source);
        assert.ok(secrets.get('missing-secret')?.includes('new-device'));
        sinon.assert.notCalled(report);
    });

    test('httpgd already exited owners cannot register a new connection', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        exits.exit(source);
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await value.httpgdManager.saveConnections();
        assert.deepStrictEqual(value.httpgdManager.viewers, []);
        assert.strictEqual(secrets.size, 0);
        sinon.assert.notCalled(connect);
    });

    test('all plot backends show the exact shared session indicator and retain it after reload', async () => {
        const a = owner('indicator-a', '12101');
        const b = owner('indicator-b', '12102');

        sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
        sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => (source.sessionId === a.sessionId ? a : b));
        const first = await manager();
        for (const [index, source] of [a, b].entries()) {
            await first.showStandardPlot(source);
            await first.showHttpgdPlot(
                `http://localhost:${1234 + index}/live?token=secret`,
                source,
            );
            first.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
            first.jgdManager.history.setSessionSource(source.sessionId, source);
        }
        async function checkIndicators(value: CommonPlotManager) {
            for (const source of [a, b]) {
                await value.showStandardPlot(source);
                (await value.httpgdManager.restoreConnection(source))!.show();
                value.jgdManager.showForSession(source);
            }
            assert.strictEqual(panels.length, 6);
            for (const source of [a, b]) {
                const label = `R 4.6.0: ${source.pid}`;
                const owned = panels.filter(({ panel }) =>
                    panel.webview.html.includes(`aria-label="${label}"`),
                );
                assert.strictEqual(owned.length, 3, 'each backend has its own session indicator');
                for (const item of owned) {
                    assert.strictEqual(
                        item.panel.title,
                        item.panel.viewType === 'jgd.plotPane' ? 'R Plot (JGD)' : 'R Plot',
                    );
                    assert.ok(item.panel.webview.html.includes('class="viewer-session-tooltip"'));
                    assert.ok(item.panel.webview.html.includes('codicon.css'));
                    item.post.resetHistory();
                    await item.receive({ message: 'viewer-session/ready' });
                    sinon.assert.calledWithExactly(item.post, {
                        message: 'viewer-session/update',
                        text: label,
                    });
                }
            }
        }
        await checkIndicators(first);
        for (const { panel } of panels) {
            panel.dispose();
        }
        await first.dispose();
        panels = [];
        await checkIndicators(await manager());
    });

    test('JGD binds live devices including late R attachments, but never guesses a restored owner', async () => {
        const events = new vscode.EventEmitter<import('../../api').RSessionConnectionChange>();
        sandbox.stub(session, 'onDidChangeSessionConnection').callsFake(events.event);
        const a = owner('jgd-owner-a', '12111');
        const b = owner('jgd-owner-b', '12112');
        const resolve = sandbox.stub(session, 'resolveJgdSessionSource');
        resolve.withArgs('r-12111-1').returns(a);
        const value = await manager();
        const live = sandbox
            .stub(value.jgdManager.server, 'isConnected')
            .callsFake((id) => id !== 'restored');
        const deliver = startJgd(value);
        for (const [id, label] of [
            ['a', 'r-12111-1'],
            ['b', 'r-12112-1'],
            ['restored', 'r-12113-1'],
        ]) {
            value.jgdManager.history.addPlot(id, frame(id));
            value.jgdManager.history.setSessionLabel(id, label);
            deliver(id, { type: 'frame' });
        }
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 12111'));
        assert.ok(!panels[1].panel.webview.html.includes('class="viewer-session"'));
        resolve.withArgs('r-12112-1').returns(b);
        events.fire({
            kind: 'connected',
            session: { sessionId: b.sessionId, connectionId: 'late' },
        });
        assert.ok(panels[1].panel.webview.html.includes('R 4.6.0: 12112'));
        sinon.assert.neverCalledWith(resolve, 'r-12113-1');
        assert.strictEqual(value.jgdManager.history.sessionSource('b')?.sessionId, b.sessionId);
        live.returns(false);
        value.jgdManager.getViewer('a')!.updateToolbar();
        await panels[0].receive({ message: 'viewer-session/ready' });
        sinon.assert.calledWith(panels[0].post, {
            message: 'viewer-session/update',
            text: 'R 4.6.0: 12111',
        });
        events.dispose();
    });

    test('owning process exit releases all engines without changing rendered documents or continuing process polling', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const kill = sandbox.stub(process, 'kill').returns(true);
        const source = owner('plot-exit', '12120');
        source.host = os.hostname();
        const value = await manager();
        await value.showStandardPlot(source);
        await value.showHttpgdPlot('http://localhost:1234', source);
        value.jgdManager.history.addPlot('device', frame('device'));
        value.jgdManager.history.setSessionSource('device', source);
        value.httpgdManager.viewers[0].show();
        value.jgdManager.showForSession(source);
        assert.strictEqual(panels.length, 3);
        const rendered = panels.map(({ panel }) => panel.webview.html);
        const closes = panels.map(({ panel }) => sandbox.spy(panel, 'dispose'));
        kill.callsFake(() => {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        });
        await clock.tickAsync(1000);
        closes.forEach((close) => sinon.assert.notCalled(close));
        for (const [index, { panel }] of panels.entries()) {
            assert.strictEqual(panel.webview.html, rendered[index]);
            panel.dispose();
        }
        assert.deepStrictEqual(value.viewers, []);
        kill.resetHistory();
        await clock.tickAsync(2000);
        sinon.assert.notCalled(kill);
    });

    test('httpgd gains the session indicator when an existing URL is attached to R', async () => {
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234');
        value.httpgdManager.viewers[0].show();
        assert.ok(!panels[0].panel.webview.html.includes('class="viewer-session"'));
        await value.showHttpgdPlot('http://localhost:1234', owner('late-httpgd', '12130'));
        assert.strictEqual(panels.length, 1);
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 12130'));
        await panels[0].receive({ message: 'viewer-session/ready' });
        sinon.assert.calledWith(panels[0].post, {
            message: 'viewer-session/update',
            text: 'R 4.6.0: 12130',
        });
    });

    test('JGD navigation checkpoints only cursors and restores them without rewriting frames', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = await manager();
        const history = first.jgdManager.history;
        history.addPlot('device', frame('device', 'first'));
        history.addPlot('device', frame('device', 'second'));
        await clock.tickAsync(250);
        await checkpoint(first);
        const snapshot = sandbox.spy(history, 'snapshot');
        const update = (extensionContext.workspaceState as unknown as { update: sinon.SinonStub })
            .update;
        update.resetHistory();
        history.navigateFirst('device');
        await clock.tickAsync(250);
        await checkpoint(first);
        sinon.assert.notCalled(snapshot);
        sinon.assert.neverCalledWith(update, 'r.plot.jgdState');
        sinon.assert.calledWith(update, 'r.plot.jgdSelection');
        assert.strictEqual(
            (await manager()).jgdManager.history.currentPlot('device')?.device.bg,
            'first',
        );
        await first.dispose();
        sinon.assert.notCalled(snapshot);
        sinon.assert.neverCalledWith(update, 'r.plot.jgdState');

        // A crash between the content and cursor writes leaves mismatched IDs.
        state.set('r.plot.jgdSelection', {
            checkpointId: 'obsolete',
            positions: [{ deviceId: 'device', currentIndex: 0 }],
        });
        assert.strictEqual(
            (await manager()).jgdManager.history.currentPlot('device')?.device.bg,
            'second',
        );
    });

    test('JGD coalesces pending checkpoints without mutating an in-flight snapshot', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const gate = deferred<void>();
        const started = deferred<void>();
        const writes: PlotHistoryState[] = [];
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            async (key: string, value: unknown) => {
                if (key === 'r.plot.jgdState') {
                    writes.push(value as PlotHistoryState);
                    if (writes.length === 1) {
                        started.resolve();
                        await gate.promise;
                    }
                }
                state.set(key, structuredClone(value));
            },
        );
        const first = await manager();
        const history = first.jgdManager.history;
        history.addPlot('device', frame('device', 'first'));
        await clock.tickAsync(250);
        await started.promise;
        for (let i = 0; i < 3; i++) {
            history.appendOps('device', {
                ...frame('device'),
                ops: [{ op: 'text', str: String(i) }],
            });
            await clock.tickAsync(250);
        }
        assert.strictEqual(writes.length, 1, 'do not queue full snapshots behind a slow write');
        const ref = writes[0].sessions[0].plots[0] as unknown as { cacheKey: string };
        const pending = JSON.parse(
            await fs.readFile(
                path.join(storageDirectory, 'plot-cache', `${ref.cacheKey}.json`),
                'utf8',
            ),
        ) as PlotFrame;
        assert.deepStrictEqual(
            pending.ops,
            [],
            'live drawing must not change the pending snapshot',
        );
        gate.resolve();
        await first.dispose();
        assert.strictEqual(writes.length, 2);
        assert.strictEqual(
            (await manager()).jgdManager.history.currentPlot('device')?.ops.length,
            3,
        );
    });

    test('JGD checkpoints a reduced history limit before saving new cursor positions', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = await manager();
        for (const bg of ['first', 'second', 'third']) {
            first.jgdManager.history.addPlot('device', frame('device', bg));
        }
        await first.dispose();
        (util.config as sinon.SinonStub).returns({
            get: (key: string, fallback: unknown) =>
                key === 'plot.jgd.historyLimit' ? 2 : fallback,
        });
        const restored = await manager();
        assert.strictEqual(restored.jgdManager.history.count('device'), 2);
        restored.jgdManager.history.navigateFirst('device');
        await clock.tickAsync(250);
        await checkpoint(restored);
        assert.strictEqual(
            (await manager()).jgdManager.history.currentPlot('device')?.device.bg,
            'second',
        );
    });

    test('all backends checkpoint restoration state before shutdown', async () => {
        const source = owner('checkpoint', '12150');
        sandbox.stub(session, 'sessionRequest').resolves({ data: 'live', format: 'svg' });
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        await first.showStandardPlot(source);
        await first.showHttpgdPlot('http://localhost:1234?token=checkpoint', source);
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        await waitForValue(() => (state.has('r.plot.jgdState') ? true : undefined));
        assert.ok(state.has('r.plot.standardSessions'));
        assert.ok(state.has('r.plot.httpgdConnectionsKey'));
        for (const { panel } of panels) {
            panel.dispose();
        }
        panels = [];
        const restored = await manager();
        // Deliberately do not call first.dispose(): the old extension host may
        // stop before its shutdown hook can write through VS Code's storage bridge.
        restored.jgdManager.showForSession(source);
        (await restored.httpgdManager.restoreConnection(source))!.show();
        await restored.showStandardPlot(source);
        assert.strictEqual(panels.length, 3);
        assert.strictEqual(restored.jgdManager.history.count('device'), 1);
        assert.strictEqual(restored.httpgdManager.viewers[0].token, 'checkpoint');
    });

    test('Show Viewers requests the standard plot from its original attached session after reload', async () => {
        const first = await manager();
        const owner = {
            sessionId: 'a',
            host: 'host',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        } as session.Session;
        const request = sandbox
            .stub(session, 'sessionRequest')
            .resolves({ data: 'original', format: 'svg' });
        focus(owner);
        const resolve = sandbox.stub(session, 'resolvePlotSession').returns(owner);
        await first.showStandardPlot(owner);
        await panels[0].receive({ type: 'ready' });
        await first.dispose();
        assert.ok(
            !JSON.stringify([...state.values()]).includes('original'),
            'standard images are not persisted',
        );
        panels = [];
        request.resetHistory();
        request.resolves({ data: 'fresh-from-R', format: 'svg' });
        resolve.resetHistory();
        await manager();
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(resolve);
        await panels[0].receive({ type: 'ready' });
        assert.strictEqual(request.lastCall.args[1], owner);
        sinon.assert.calledWith(panels[0].post, {
            type: 'update',
            data: 'fresh-from-R',
            format: 'svg',
        });
        request.resetHistory();
        resolve.resetHistory();
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.firstCall.args[1], owner);
        assert.strictEqual(panels.length, 1);
        request.resetHistory();
        const reattached = {
            sessionId: owner.sessionId,
            host: owner.host,
            pid: owner.pid,
            rVer: owner.rVer,
            processExited: false,
        } as session.Session;
        resolve.returns(reattached);
        panels[0].panel.dispose();
        await callbacks.get('r.plot.showViewers')!();
        await panels[1].receive({ type: 'ready' });
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.lastCall.args[1], reattached);
    });

    function startJgd(value: CommonPlotManager) {
        (JgdManager.prototype.start as sinon.SinonStub).callThrough();
        sandbox.stub(value.jgdManager.server, 'start');
        const onFrame = sandbox.stub(value.jgdManager.server, 'setOnFrame');
        value.jgdManager.start();
        return onFrame.firstCall.args[0] as (id: string, message: JgdMessage) => void;
    }

    function frame(sessionId: string, bg = 'white'): PlotFrame {
        return {
            version: 1,
            sessionId,
            device: { width: 400, height: 300, dpi: 96, bg },
            ops: [],
        };
    }

    for (const backend of ['jgd', 'httpgd'] as const) {
        async function commandViewers() {
            (util.config as sinon.SinonStub).returns({
                get: (key: string, fallback: unknown) =>
                    key === 'plot.backend' ? backend : fallback,
            });
            const value = await manager();
            const a = owner('a', '123');
            const b = owner('b', '456');
            for (const [index, source] of [a, b].entries()) {
                if (backend === 'jgd') {
                    value.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
                    value.jgdManager.history.setSessionSource(source.sessionId, source);
                    value.jgdManager.showForSession(source);
                } else {
                    await value.showHttpgdPlot(`http://localhost:${1234 + index}`, source);
                    value.httpgdManager.viewers[0].show();
                }
            }
            const viewers =
                backend === 'jgd'
                    ? value.jgdManager.getViewers()
                    : [...value.httpgdManager.viewers].reverse();
            for (const { panel } of panels) {
                Object.assign(panel, { active: false });
            }
            const [viewerA, viewerB] = viewers;
            const handleA = sandbox.stub(viewerA, 'handleCommand').resolves();
            const handleB = sandbox.stub(viewerB, 'handleCommand').resolves();
            return { value, a, b, viewerA, viewerB, handleA, handleB };
        }

        test(`${backend} untargeted commands use the active session instead of the latest viewer`, async () => {
            const { value, a, b, viewerA, viewerB, handleA, handleB } = await commandViewers();
            const active = sandbox.stub(session, 'activeSession').value(a);
            assert.strictEqual(value.activeViewer, viewerA);
            await callbacks.get('r.plot.prevPlot')!();
            await callbacks.get('r.plot.closePlot')!();
            await callbacks.get('r.plot.resetPlots')!();
            assert.deepStrictEqual(
                handleA.getCalls().map((call) => call.args[0]),
                ['prevPlot', 'closePlot', 'resetPlots'],
            );
            sinon.assert.notCalled(handleB);

            active.value(b);
            assert.strictEqual(value.activeViewer, viewerB);
            await callbacks.get('r.plot.nextPlot')!();
            sinon.assert.calledOnceWithExactly(handleB, 'nextPlot');
        });

        test(`${backend} untargeted commands reject absent, unrelated, reused and exited sessions`, async () => {
            const { value, a, handleA, handleB } = await commandViewers();
            const active = sandbox.stub(session, 'activeSession');
            const identity: ViewerSessionSource = {
                sessionId: a.sessionId,
                host: a.host,
                pid: a.pid,
                rVer: a.rVer,
                processExited: false,
            };
            for (const source of [
                undefined,
                owner('no-plots', '789'),
                { ...identity, sessionId: 'different-session' },
                { ...identity, host: 'different-host' },
                { ...identity, pid: '999' },
                { ...identity, processExited: true },
            ]) {
                active.value(source);
                assert.strictEqual(value.activeViewer, undefined);
                await callbacks.get('r.plot.closePlot')!();
                await callbacks.get('r.plot.resetPlots')!();
            }
            sinon.assert.notCalled(handleA);
            sinon.assert.notCalled(handleB);
            // Host identity is case-insensitive, as elsewhere in session routing.
            active.value({ ...identity, host: a.host.toUpperCase() });
            await callbacks.get('r.plot.prevPlot')!();
            sinon.assert.calledOnceWithExactly(handleA, 'prevPlot');
        });

        test(`${backend} focused and explicit commands retain their target when another session is active`, async () => {
            const { a, viewerB, handleA, handleB } = await commandViewers();
            sandbox.stub(session, 'activeSession').value(a);
            Object.assign(panels[1].panel, { active: true });
            await callbacks.get('r.plot.closePlot')!();
            sinon.assert.calledOnceWithExactly(handleB, 'closePlot');
            await callbacks.get('r.plot.prevPlot')!(vscode.Uri.parse('webview-panel:focused'));
            sinon.assert.calledWithExactly(handleB, 'prevPlot');
            for (const { panel } of panels) {
                Object.assign(panel, { active: false });
            }
            handleB.resetHistory();
            await callbacks.get('r.plot.closePlot')!(vscode.Uri.parse('webview-panel:ended'));
            sinon.assert.notCalled(handleB);
            if (backend === 'httpgd') {
                await callbacks.get('r.plot.hidePlot')!(viewerB.id, 'plot-id');
                sinon.assert.calledOnceWithExactly(handleB, 'hidePlot', 'plot-id');
            }
            sinon.assert.notCalled(handleA);
        });
    }

    test('auto falls back to the active session httpgd viewer when JGD belongs to another session', async () => {
        const value = await manager();
        const source = owner('active', '123');
        focus(source);
        value.jgdManager.history.addPlot('other-device', frame('other-device'));
        value.jgdManager.history.setSessionSource('other-device', owner('other', '456'));
        const jgd = value.jgdManager.getViewer('other-device')!;
        jgd.show();
        await value.showHttpgdPlot('http://localhost:1234', source);
        const httpgd = value.httpgdManager.viewers[0];
        httpgd.show();
        for (const { panel } of panels) {
            Object.assign(panel, { active: false });
        }
        const handleJgd = sandbox.stub(jgd, 'handleCommand').resolves();
        const handleHttpgd = sandbox.stub(httpgd, 'handleCommand').resolves();
        await callbacks.get('r.plot.closePlot')!();
        sinon.assert.calledOnceWithExactly(handleHttpgd, 'closePlot');
        sinon.assert.notCalled(handleJgd);
    });

    test('untargeted commands do not claim ownerless JGD or httpgd viewers', async () => {
        const value = await manager();
        focus(owner('active', '123'));
        value.jgdManager.history.addPlot('unknown-device', frame('unknown-device'));
        const jgd = value.jgdManager.getViewer('unknown-device')!;
        jgd.show();
        await value.showHttpgdPlot('http://localhost:1234');
        const httpgd = value.httpgdManager.viewers[0];
        httpgd.show();
        for (const { panel } of panels) {
            Object.assign(panel, { active: false });
        }
        const handleJgd = sandbox.stub(jgd, 'handleCommand').resolves();
        const handleHttpgd = sandbox.stub(httpgd, 'handleCommand').resolves();
        assert.strictEqual(value.activeViewer, undefined);
        await callbacks.get('r.plot.resetPlots')!();
        sinon.assert.notCalled(handleJgd);
        sinon.assert.notCalled(handleHttpgd);
    });

    test('JGD untargeted commands can navigate the active session history without reopening a closed panel', async () => {
        const value = await manager();
        const source = owner('active', '123');
        focus(source);
        const history = value.jgdManager.history;
        history.addPlot('owned-device', frame('owned-device', 'first'));
        history.addPlot('owned-device', frame('owned-device', 'second'));
        history.setSessionSource('owned-device', source);
        history.addPlot('other-device', frame('other-device'));
        history.setSessionSource('other-device', owner('other', '456'));
        await callbacks.get('r.plot.prevPlot')!();
        assert.strictEqual(history.currentPlot('owned-device')?.device.bg, 'first');
        assert.strictEqual(history.count('other-device'), 1);
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.resetPlots')!();
        assert.strictEqual(history.count('owned-device'), 0);
        assert.strictEqual(history.count('other-device'), 1);
        assert.strictEqual(panels.length, 0);
    });

    test('Show Viewer opens only the focused session and never ownerless or empty JGD viewers', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        const active = sandbox.stub(session, 'activeSession').value(a);
        const resolve = sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => source as session.Session);
        const value = await manager();
        const metrics = sandbox.spy(value.jgdManager.server, 'setMeasureText');
        const deliver = startJgd(value);
        await metrics.firstCall.args[0]({ type: 'metrics_request', id: 1 }, 96, 'temporary-socket');
        assert.strictEqual(value.jgdManager.getViewers().length, 0);
        for (const source of [a, b]) {
            value.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
            value.jgdManager.history.setSessionSource(source.sessionId, source);
            deliver(source.sessionId, { type: 'frame' });
        }
        value.jgdManager.history.addPlot('unknown', frame('unknown'));
        value.jgdManager.history.addPlot('empty', frame('empty'));
        value.jgdManager.history.clear('empty');
        value.jgdManager.history.setSessionSource('empty', a);
        for (const { panel } of panels) {
            panel.dispose();
        }
        panels = [];
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 123'));
        sinon.assert.calledOnceWithExactly(resolve, a);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        active.value(b);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 2);
        assert.ok(panels[1].panel.webview.html.includes('R 4.6.0: 456'));
        active.value(undefined);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 2);
    });

    test('a missing saved JGD device does not select another session during restore', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const first = await manager();
        for (const source of [a, b]) {
            first.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
            first.jgdManager.history.setSessionSource(source.sessionId, source);
        }
        await first.dispose();
        const saved = state.get('r.plot.jgdState') as PlotHistoryState;
        saved.activeSessionId = 'missing-device';
        const restored = await manager();
        assert.strictEqual(restored.jgdManager.history.getActiveSessionId(), '');
        assert.strictEqual(restored.jgdManager.getViewer(), null);
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 123'));
        assert.strictEqual(restored.jgdManager.history.count('b'), 1);
    });

    for (const backend of ['httpgd', 'jgd', 'standard'] as const) {
        test(`${backend} recovers the active session across reloads without focusing its terminal`, async () => {
            const source = owner('attached', '123');
            focus(source);
            sandbox.stub(session, 'resolvePlotSession').returns(source);
            sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
            const showTerminal = sandbox.stub();
            const unrelatedTerminal = { show: showTerminal } as unknown as vscode.Terminal;
            sandbox.stub(vscode.window, 'activeTerminal').value(unrelatedTerminal);
            let value = await manager();
            if (backend === 'httpgd') {
                await value.showHttpgdPlot('http://localhost:1234/live?token=secret', source);
            } else if (backend === 'jgd') {
                value.jgdManager.history.addPlot('device', frame('device'));
                value.jgdManager.history.setSessionSource('device', source);
            } else {
                await value.showStandardPlot(source);
            }
            for (let reload = 0; reload < 4; reload++) {
                await value.dispose();
                panels = [];
                value = await manager();
                await callbacks.get('r.plot.showViewers')!();
                assert.strictEqual(panels.length, 1, `viewer recovered after reload ${reload}`);
                assert.ok(panels[0].panel.webview.html.includes('R 4.6.0: 123'));
                assert.strictEqual(session.activeSession, source);
                sinon.assert.notCalled(showTerminal);
            }
        });
    }

    test('multiple JGD devices in one R session reuse one viewer', async () => {
        const source = owner('a', '123');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const value = await manager();
        const deliver = startJgd(value);
        for (const id of ['device-1', 'device-2', 'device-1']) {
            value.jgdManager.history.addPlot(id, frame(id));
            value.jgdManager.history.setSessionSource(id, source);
            deliver(id, { type: 'frame' });
        }
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(value.jgdManager.getViewers().length, 1);
        assert.strictEqual(value.jgdManager.getViewers()[0].sessionId, 'device-1');
        panels[0].panel.dispose();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 2, 'one replacement tab after closing');
    });

    test('an explicit device joins the session history and gets the existing panel dimensions', async () => {
        const value = await manager();
        const deliver = startJgd(value);
        const history = value.jgdManager.history;
        const source = owner('a', '123');
        const resize = sandbox.stub(value.jgdManager.server, 'handleResize');
        sandbox.stub(value.jgdManager.server, 'isConnected').returns(true);
        sandbox
            .stub(session, 'resolveJgdSessionSource')
            .callsFake((label) => (label === 'r-123-2' ? source : undefined));
        history.addPlot('managed', frame('managed', 'first'));
        history.setSessionSource('managed', source);
        deliver('managed', { type: 'frame' });
        await panels[0].receive({ type: 'resize', width: 900, height: 700 });
        resize.resetHistory();
        history.addPlot('explicit', frame('explicit', 'second'));
        history.setSessionLabel('explicit', 'r-123-2');
        deliver('explicit', { type: 'frame', newPage: true });
        assert.strictEqual(panels.length, 1);
        assert.strictEqual(history.count('managed'), 2);
        sinon.assert.calledOnceWithExactly(resize, 900, 700, 'explicit');
        sinon.assert.calledWith(panels[0].post, { type: 'toolbar', current: 2, total: 2 });
        const viewer = value.jgdManager.getViewers()[0];
        await viewer.handleCommand('prevPlot');
        assert.strictEqual(history.currentPlot('explicit')?.device.bg, 'first');
        history.replaceLatest('explicit', frame('explicit', 'second resized'));
        deliver('explicit', { type: 'frame', resizeReplay: true });
        assert.strictEqual(history.currentPlot('explicit')?.device.bg, 'first');
        await viewer.handleCommand('nextPlot');
        assert.strictEqual(history.currentPlot('managed')?.device.bg, 'second resized');
    });

    test('JGD measures an earlier device through its session viewer without switching plots', async () => {
        const value = await manager();
        const metrics = sandbox.spy(value.jgdManager.server, 'setMeasureText');
        const deliver = startJgd(value);
        const source = owner('a', '123');
        for (const id of ['device-1', 'device-2', 'other-session']) {
            value.jgdManager.history.addPlot(id, frame(id));
            value.jgdManager.history.setSessionSource(
                id,
                id === 'other-session' ? owner('b', '456') : source,
            );
            deliver(id, { type: 'frame' });
        }
        const viewer = value.jgdManager.getViewers()[0];
        const selectedPlot = value.jgdManager.history.currentPlot(viewer.sessionId);
        for (const item of panels) {
            item.post.resetHistory();
        }
        const measure = metrics.firstCall.args[0];
        const measured = measure(
            { type: 'metrics_request', id: 7, kind: 'strWidth', str: 'W' },
            96,
            'device-1',
        );
        sinon.assert.calledOnce(panels[0].post);
        sinon.assert.notCalled(panels[1].post);
        const request = panels[0].post.lastCall.args[0] as { type: string; id: number };
        assert.strictEqual(request.type, 'metrics_request');
        await panels[0].receive({
            type: 'metrics_response',
            id: request.id,
            originalId: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        assert.deepStrictEqual(await measured, {
            type: 'metrics_response',
            id: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        assert.strictEqual(viewer.sessionId, 'device-2');
        assert.strictEqual(value.jgdManager.history.currentPlot(viewer.sessionId), selectedPlot);
        assert.strictEqual(panels.length, 2);

        panels[0].panel.dispose();
        assert.deepStrictEqual(await measure({ type: 'metrics_request', id: 8 }, 96, 'device-1'), {
            type: 'metrics_response',
            id: 8,
            width: 0,
            ascent: 0,
            descent: 0,
        });
        assert.strictEqual(panels.length, 2, 'metrics must not reopen a closed viewer');
    });

    test('JGD reattachment after reload keeps closed viewers closed until Show Viewer or a new plot', async () => {
        const source = owner('a', '123');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        const deliver = startJgd(first);
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        deliver('device', { type: 'frame' });
        panels[0].panel.dispose();
        await first.dispose();
        (JgdManager.prototype.start as sinon.SinonStub).resetBehavior();
        panels = [];
        const restored = await manager();
        const replay = startJgd(restored);
        replay('device', { type: 'frame', ext: { vscodeR: { restoring: true } } });
        replay('device', { type: 'frame', resizeReplay: true });
        assert.strictEqual(panels.length, 0);
        assert.strictEqual(restored.jgdManager.history.count('device'), 1);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        panels[0].panel.dispose();
        replay('device', { type: 'frame', ext: { vscodeR: { restoring: true } } });
        assert.strictEqual(panels.length, 1);
        restored.jgdManager.history.addPlot('device', frame('device', 'new'));
        replay('device', { type: 'frame' });
        assert.strictEqual(panels.length, 2);
    });

    test('httpgd restoration connects only the focused session', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234?token=a', a);
        await first.showHttpgdPlot('http://localhost:1235?token=b', b);
        await first.dispose();
        connect.resetHistory();
        const restored = await manager();
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
        assert.strictEqual(restored.httpgdManager.viewers.length, 1);
        assert.strictEqual(restored.httpgdManager.viewers[0].connection.source?.sessionId, 'a');
        assert.strictEqual(panels.length, 1);
    });

    test('httpgd reattachment and existing plot updates keep closed panels closed', async () => {
        const source = owner('a', '123');
        const value = await manager();
        const viewer = new RefreshViewer('http://localhost:1234', {
            ...value.httpgdManager.viewerOptions,
            source,
            restoring: true,
        });
        value.httpgdManager.registerViewer(viewer);
        sandbox.stub(viewer.api, 'getPlotText').resolves('<svg/>');
        await viewer.receivePlots(['1']);
        assert.strictEqual(panels.length, 0);
        await viewer.receivePlots(['1']);
        assert.strictEqual(panels.length, 0);
        viewer.show();
        assert.strictEqual(panels.length, 1);
        panels[0].panel.dispose();
        await value.showHttpgdPlot('http://localhost:1234', source, true);
        await viewer.receivePlots(['1']);
        assert.strictEqual(panels.length, 1);
        await viewer.receivePlots(['1', '2']);
        assert.strictEqual(panels.length, 2, 'a new plot opens one replacement panel');
    });

    test('httpgd devices reuse one session viewer and preserve its panel and settings', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234', a);
        const first = value.httpgdManager.viewers[0];
        first.show();
        const panel = first.webviewPanel;
        first.zoom = 2;
        first.togglePreviewPlots('hidden');
        await value.showHttpgdPlot('http://localhost:1235', b);
        const other = value.httpgdManager.viewers[0];
        other.show();
        await value.showHttpgdPlot('http://localhost:1236', a);
        assert.strictEqual(value.httpgdManager.viewers.length, 2);
        assert.strictEqual(first.connections.length, 2);
        assert.strictEqual(first.webviewPanel, panel);
        assert.strictEqual(first.zoom, 2);
        assert.strictEqual(first.previewPlotLayout, 'hidden');
        assert.ok(other.webviewPanel);
        panel!.dispose();
        const count = panels.length;
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, count + 1);
        assert.ok(first.webviewPanel);
        assert.strictEqual(first.connections.length, 2);
    });

    test('httpgd late ownership joins an existing session viewer without replacing its panel', async () => {
        const source = owner('late-owner', '123');
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234', source);
        const shared = value.httpgdManager.viewers[0];
        shared.show();
        const panel = shared.webviewPanel;
        await value.showHttpgdPlot('http://localhost:1235');
        const unowned = value.httpgdManager.viewers[0];
        unowned.show();
        await value.showHttpgdPlot('http://localhost:1235', source);
        assert.deepStrictEqual(value.httpgdManager.viewers, [shared]);
        assert.strictEqual(shared.webviewPanel, panel);
        assert.strictEqual(shared.connections.length, 2);
        assert.strictEqual(unowned.isDisposed, true);
        assert.strictEqual(unowned.webviewPanel, undefined);
    });

    test('httpgd command routing survives port reuse by a different session', async () => {
        const value = await manager();
        const source = owner('original', '123');
        await value.showHttpgdPlot('http://localhost:1234', source);
        const first = value.httpgdManager.viewers[0];
        first.show();
        await value.showHttpgdPlot('http://localhost:1235', source);
        const panel = first.webviewPanel;
        await value.showHttpgdPlot('http://localhost:1234', owner('replacement', '456'));
        const replacement = value.httpgdManager.viewers[0];
        assert.notStrictEqual(replacement, first);
        assert.strictEqual(first.webviewPanel, panel);
        assert.strictEqual(first.connections.length, 1);
        const originalCommand = sandbox.stub(first, 'handleCommand');
        const replacementCommand = sandbox.stub(replacement, 'handleCommand');
        await callbacks.get('r.plot.hidePlot')!(first.id, 'plot');
        sinon.assert.calledOnceWithExactly(originalCommand, 'hidePlot', 'plot');
        sinon.assert.notCalled(replacementCommand);
        await callbacks.get('r.plot.hidePlot')!('localhost:1234', 'replacement-plot');
        sinon.assert.calledOnceWithExactly(replacementCommand, 'hidePlot', 'replacement-plot');
    });

    test('httpgd reuses inactive geometry and applies its latest size once reactivated', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        const active = sandbox.stub(viewer.api, 'isActive').returns(false);
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>original</svg>');
        await viewer.receivePlots(['a'], new Set(['a']));
        render.resolves('<svg>annotation</svg>');
        await viewer.receivePlots(['a'], new Set(['a']));
        assert.strictEqual(viewer.plots[0].data, '<svg>annotation</svg>');
        sinon.assert.calledTwice(render);

        viewer.viewWidth = 900;
        await viewer.receivePlots(['a']);
        assert.strictEqual(viewer.plots[0].width, 900);
        sinon.assert.calledTwice(render);

        viewer.viewWidth = 1000;
        viewer.viewHeight = 700;
        viewer.zoom = 1.2;
        await viewer.receivePlots(['a']);
        sinon.assert.calledTwice(render);

        // dev.set() changes activity without changing the drawing's update ID.
        active.returns(true);
        await viewer.receivePlots(['a'], new Set());
        sinon.assert.calledThrice(render);
        assert.deepStrictEqual(render.lastCall.args, [
            { id: 'a', width: 1000, height: 700, zoom: 1.2, renderer: 'svgp' },
        ]);
        await viewer.receivePlots(['a'], new Set());
        sinon.assert.calledThrice(render);
        active.returns(false);
        await viewer.receivePlots(['a']);
        active.returns(true);
        await viewer.receivePlots(['a'], new Set());
        sinon.assert.calledThrice(render);
    });

    test('httpgd defers background plot resizing until selected on its active device', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        const active = sandbox.stub(viewer.api, 'isActive').returns(false);
        sandbox.stub(viewer.api, 'getPlots').returns([{ id: 'a' }, { id: 'b' }]);
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>retained</svg>');
        await viewer.receivePlots(['a', 'b'], new Set(['a', 'b']));
        viewer.viewWidth = 1000;
        await viewer.focusPlot('a');
        await viewer.focusPlot('b');
        render.resetHistory();

        active.returns(true);
        await viewer.receivePlots(['a', 'b'], new Set());
        sinon.assert.calledOnce(render);
        assert.strictEqual(render.firstCall.args[0].id, 'b');
        // Both cache entries already have the current viewport dimensions.
        // Focusing the other plot must still replay its deferred geometry.
        await viewer.focusPlot('a');
        sinon.assert.calledTwice(render);
        assert.strictEqual(render.lastCall.args[0].id, 'a');
        await viewer.focusPlot('a');
        await viewer.receivePlots(['a', 'b'], new Set());
        sinon.assert.calledTwice(render);
    });

    test('httpgd commits healthy devices when a closed device has an uncached plot', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        sandbox.stub(viewer.api, 'isActive').callsFake((id) => id.startsWith('b'));
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg/>');
        const error = sandbox.stub(vscode.window, 'showErrorMessage');
        await viewer.receivePlots(['a1', 'b1'], new Set(['a1', 'b1']));
        const retained = viewer.plots[0];
        render.withArgs(sinon.match({ id: 'a2' })).rejects(new Error('device closed'));
        await viewer.receivePlots(['a1', 'b1', 'a2', 'b2'], new Set(['a2', 'b2']));
        assert.deepStrictEqual(
            viewer.plots.map((plot) => plot.id),
            ['a1', 'b1', 'b2'],
        );
        assert.strictEqual(viewer.plots[0], retained);
        assert.strictEqual(viewer.activePlot, 'b2');
        sinon.assert.calledOnce(error);

        // Another device's notifications must not keep retrying the closed one.
        await viewer.receivePlots(['a1', 'b1', 'a2', 'b2', 'b3'], new Set(['b3']));
        assert.strictEqual(viewer.activePlot, 'b3');
        sinon.assert.calledOnce(render.withArgs(sinon.match({ id: 'a2' })));
        sinon.assert.calledOnce(error);

        // An explicit refresh can recover a temporarily unavailable device.
        render.withArgs(sinon.match({ id: 'a2' })).resolves('<svg>recovered</svg>');
        await viewer.receivePlots(['a1', 'b1', 'a2', 'b2', 'b3'], new Set(), true);
        assert.ok(viewer.plots.some((plot) => plot.id === 'a2'));
    });

    test('httpgd keeps failed content invalidated until its device becomes active again', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        const active = sandbox.stub(viewer.api, 'isActive').returns(false);
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>original</svg>');
        sandbox.stub(vscode.window, 'showErrorMessage');
        await viewer.receivePlots(['a'], new Set(['a']));
        render.rejects(new Error('temporarily unavailable'));
        await viewer.receivePlots(['a'], new Set(['a']));
        assert.strictEqual(viewer.plots[0].data, '<svg>original</svg>');
        await viewer.receivePlots(['a'], new Set());
        sinon.assert.calledTwice(render);

        active.returns(true);
        render.resolves('<svg>annotation</svg>');
        await viewer.receivePlots(['a'], new Set());
        assert.strictEqual(viewer.plots[0].data, '<svg>annotation</svg>');
        sinon.assert.calledThrice(render);
        await viewer.receivePlots(['a'], new Set());
        sinon.assert.calledThrice(render);
    });

    test('httpgd coalesces notifications arriving during a slow render without losing plots', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        const gate = deferred<string>();
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg/>');
        render.onFirstCall().returns(gate.promise);
        const first = viewer.receivePlots(['1']);
        await Promise.resolve();
        const second = viewer.receivePlots(['1', '2']);
        const third = viewer.receivePlots(['1', '2', '3']);
        sinon.assert.calledOnce(render);
        gate.resolve('<svg/>');
        await Promise.all([first, second, third]);
        assert.deepStrictEqual(
            viewer.plots.map((plot) => plot.id),
            ['1', '2', '3'],
        );
        assert.strictEqual(viewer.activePlot, '3');
        assert.strictEqual(render.getCalls().filter((call) => call.args[0].id === '2').length, 1);
        assert.strictEqual(render.getCalls().filter((call) => call.args[0].id === '3').length, 1);
    });

    async function startHttpgdR(context: Mocha.Context) {
        try {
            const probe = await promisify(execFile)('Rscript', [
                '--vanilla',
                '-e',
                'cat(requireNamespace("httpgd", quietly=TRUE) && requireNamespace("jsonlite", quietly=TRUE))',
            ]);
            if (probe.stdout.trim() !== 'TRUE') {
                throw new Error('Live httpgd tests require httpgd and jsonlite');
            }
        } catch (error) {
            if (process.env.VSCR_REQUIRE_PLOT_TESTS === '1') {
                throw error;
            }
            context.skip();
        }
        const r = spawn('R', [
            '--vanilla',
            '--slave',
            process.platform === 'win32' ? '--ess' : '--interactive',
        ]);
        const exited = new Promise<void>((resolve) => r.once('exit', () => resolve()));
        let output = '';
        let errors = '';
        r.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        r.stderr.on('data', (data: Buffer) => {
            errors += data.toString();
        });
        let sequence = 0;
        const evaluate = async (code: string): Promise<string> => {
            const marker = `HTTPGD_RESULT_${++sequence}:`;
            r.stdin.write(
                `tryCatch({value <- {${code}}; cat(${JSON.stringify(marker)}, jsonlite::toJSON(value, auto_unbox=TRUE), "\\n", sep="")}, error=function(e) cat(${JSON.stringify(marker)}, jsonlite::toJSON(list(error=conditionMessage(e)), auto_unbox=TRUE), "\\n", sep=""))\n`,
            );
            const line = await waitForValue(() => {
                if (r.exitCode !== null) {
                    throw new Error(`R exited: ${errors}`);
                }
                const start = output.indexOf(marker);
                const end = output.indexOf('\n', start);
                return start >= 0 && end >= 0
                    ? output.slice(start + marker.length, end)
                    : undefined;
            });
            const result: unknown = JSON.parse(line);
            assert.strictEqual(typeof result, 'string', line);
            return result as string;
        };
        return {
            r,
            evaluate,
            exited,
            async dispose() {
                if (r.exitCode === null && r.signalCode === null) {
                    r.kill();
                }
                await exited;
            },
        };
    }

    test('live httpgd dev.new shares navigation, resize, export, reload and exit cleanup', async function () {
        this.timeout(30000);
        connect.callThrough();
        const process = await startHttpgdR(this);
        const { r, evaluate, exited } = process;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'httpgd-session-'));
        try {
            const source = owner('live-httpgd', String(r.pid));
            source.host = os.hostname();
            focus(source);
            sandbox.stub(session, 'resolvePlotSession').returns(source);
            const first = await manager();
            const firstUrl = await evaluate(
                'options(device=function(...) httpgd::hgd(silent=TRUE)); plot(1:10, main="FIRST DEVICE"); first_device <- dev.cur(); httpgd::hgd_url()',
            );
            await first.showHttpgdPlot(firstUrl, source);
            const viewer = first.httpgdManager.viewers[0];
            await waitForValue(() => (viewer.plots.length === 1 ? true : undefined));
            const panel = viewer.webviewPanel;
            await evaluate('plot(1:100, main="SECOND SAME DEVICE"); "OK"');
            await waitForValue(() => (viewer.plots.length === 2 ? true : undefined));
            const toolbarUri = vscode.Uri.parse(
                'webview-panel:webview-panel/webview-RPlot-live-httpgd',
            );
            await callbacks.get('r.plot.prevPlot')!(toolbarUri, { groupId: 0 });
            assert.strictEqual(viewer.activePlot, viewer.plots[0].id);
            assert.ok(viewer.plots[0].data.includes('FIRST DEVICE'));
            await callbacks.get('r.plot.nextPlot')!(toolbarUri, { groupId: 0 });
            assert.strictEqual(viewer.activePlot, viewer.plots[1].id);
            assert.ok(viewer.plots[1].data.includes('SECOND SAME DEVICE'));
            await viewer.closePlot(viewer.plots[1].id);
            await waitForValue(() => (viewer.plots.length === 1 ? true : undefined));
            const secondUrl = await evaluate(
                'dev.new(); plot(1:100, main="SECOND DEVICE"); httpgd::hgd_url()',
            );
            await first.showHttpgdPlot(secondUrl, source);
            await waitForValue(() => (viewer.plots.length === 2 ? true : undefined));
            assert.strictEqual(first.httpgdManager.viewers.length, 1);
            assert.strictEqual(viewer.webviewPanel, panel);
            assert.ok(viewer.plots[0].data.includes('FIRST DEVICE'));
            assert.ok(viewer.plots[1].data.includes('SECOND DEVICE'));
            await viewer.prevPlot();
            assert.strictEqual(viewer.activePlot, viewer.plots[0].id);
            viewer.viewWidth = 920;
            viewer.viewHeight = 680;
            await viewer.focusPlot();
            assert.strictEqual(viewer.plots[0].width, 920);
            assert.ok(viewer.plots[0].data.includes('FIRST DEVICE'));
            assert.ok(!viewer.plots[0].data.includes('width="920.00"'));
            // Reactivation alone must apply the deferred size, without another
            // resize event, new plot, or annotation to invalidate the drawing.
            await evaluate('dev.set(first_device); "OK"');
            await waitForValue(() =>
                viewer.plots[0].data.includes('width="920.00"') ? true : undefined,
            );
            assert.ok(viewer.plots[0].data.includes('height="680.00"'));
            assert.ok(viewer.plots[0].data.includes('FIRST DEVICE'));
            const file = path.join(directory, 'first.svg');
            await viewer.exportPlot(viewer.activePlot, 'svgp', file);
            assert.ok((await fs.readFile(file, 'utf8')).includes('FIRST DEVICE'));
            await evaluate('dev.set(first_device); plot(11:20, main="THIRD PLOT"); "OK"');
            await waitForValue(() => (viewer.plots.length === 3 ? true : undefined));
            assert.ok(viewer.plots[2].data.includes('THIRD PLOT'));
            viewer.viewWidth = 960;
            await viewer.focusPlot(viewer.plots[0].id);
            assert.ok(viewer.plots[0].data.includes('width="960.00"'));
            assert.ok(viewer.plots[0].data.includes('FIRST DEVICE'));
            panel!.dispose();
            const titles = (plots: HttpgdViewer['plots']) =>
                plots.map((plot) => plot.data.match(/FIRST DEVICE|SECOND DEVICE|THIRD PLOT/)?.[0]);
            const originalOrder = titles(viewer.plots);
            await waitForValue(() => {
                const key = state.get('r.plot.httpgdConnectionsKey') as string;
                const saved = JSON.parse(secrets.get(key) ?? '[]') as typeof viewer.connections;
                const order = saved.flatMap((connection) => connection.plotOrder ?? []);
                return JSON.stringify(order) === JSON.stringify(viewer.api.plotOrder)
                    ? true
                    : undefined;
            });
            await first.dispose();
            const restored = await manager();
            await callbacks.get('r.plot.showViewers')!();
            const live = restored.httpgdManager.viewers[0];
            await waitForValue(() => (live.plots.length === 3 ? true : undefined));
            assert.deepStrictEqual(titles(live.plots), originalOrder);
            assert.strictEqual(restored.httpgdManager.viewers.length, 1);
            assert.strictEqual(live.connections.length, 2);
            const second = live.plots.find((plot) => plot.data.includes('SECOND DEVICE'))!;
            await live.closePlot(second.id);
            await waitForValue(() => (live.api.getPlots().length === 2 ? true : undefined));
            assert.strictEqual(live.plots.length, 2);
            assert.ok(live.plots[0].data.includes('FIRST DEVICE'));
            await evaluate('dev.off(first_device); "OK"');
            live.viewWidth = 1010;
            await live.focusPlot(live.plots[0].id);
            assert.strictEqual(live.plots[0].width, 1010);
            assert.ok(live.plots[0].data.includes('FIRST DEVICE'));
            const retainedPanel = live.webviewPanel!;
            const rendered = retainedPanel.webview.html;
            const closed = sandbox.spy(retainedPanel, 'dispose');
            await live.nextPlot(true);
            r.kill();
            await exited;
            await waitForValue(() => (live.isDisposed ? true : undefined));
            await restored.httpgdManager.saveConnections();
            assert.strictEqual(secrets.size, 0);
            sinon.assert.notCalled(closed);
            assert.strictEqual(retainedPanel.webview.html, rendered);
            assert.strictEqual(live.webviewPanel, undefined);
            assert.strictEqual(live.plots.length, 0);
            await callbacks.get('r.plot.firstPlot')!(live.id);
            assert.strictEqual(live.activePlot, undefined, 'ended sessions have no navigation');
            assert.strictEqual(live.plots.length, 0);
            assert.strictEqual(live.api.getPlots().length, 0);
            retainedPanel.dispose();
        } finally {
            await process.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('live httpgd retains selection and navigation after every device closes', async function () {
        this.timeout(30000);
        connect.callThrough();
        (vscode.window.createWebviewPanel as sinon.SinonStub).callsFake(
            (...args: Parameters<typeof createRealWebviewPanel>) => createRealWebviewPanel(...args),
        );
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        const process = await startHttpgdR(this);
        await prepareEditorLayout();
        const originalLayout = await executeRealCommand('vscode.getEditorLayout');
        let viewer: HttpgdViewer | undefined;
        const document = await vscode.workspace.openTextDocument({ language: 'plaintext' });
        try {
            await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
            const layout = (width: number) =>
                executeRealCommand('vscode.setEditorLayout', {
                    orientation: 0,
                    groups: [{ size: 1 - width }, { size: width }],
                });
            await layout(0.6);
            const source = owner('live-httpgd-close', String(process.r.pid));
            source.host = os.hostname();
            const value = await manager();
            const first = await process.evaluate(
                'options(device=function(...) httpgd::hgd(silent=TRUE)); plot(1:5, main="FIRST DEVICE"); first_device <- dev.cur(); httpgd::hgd_url()',
            );
            await value.showHttpgdPlot(first, source);
            viewer = value.httpgdManager.viewers[0];
            await waitForValue(() => (viewer!.plots.length === 1 ? true : undefined));
            viewer.show(false);
            await waitForValue(() => (viewer!.plots[0].width !== 800 ? true : undefined));
            const firstId = viewer.plots[0].id;
            const second = await process.evaluate(
                'dev.new(); plot(5:1, main="SECOND DEVICE"); httpgd::hgd_url()',
            );
            await value.showHttpgdPlot(second, source);
            await waitForValue(() => (viewer!.plots.length === 2 ? true : undefined));
            assert.notStrictEqual(viewer.activePlot, firstId);
            const secondId = viewer.activePlot;
            const third = await process.evaluate(
                'dev.new(); plot(1:10, main="THIRD DEVICE"); httpgd::hgd_url()',
            );
            await value.showHttpgdPlot(third, source);
            await waitForValue(() => (viewer!.plots.length === 3 ? true : undefined));
            const thirdId = viewer.activePlot;
            await process.evaluate('dev.off(first_device); "OK"');
            assert.strictEqual(viewer.activePlot, thirdId);
            await process.evaluate('dev.off(); "OK"');
            assert.strictEqual(
                viewer.activePlot,
                thirdId,
                'closing a device preserves its rendered plot',
            );
            await process.evaluate('dev.off(); "OK"');
            const render = sandbox.spy(viewer.api, 'getPlotText');
            for (const width of [0.3, 0.5]) {
                const before = viewer.viewWidth;
                await layout(width);
                await waitForValue(() => (viewer!.viewWidth !== before ? true : undefined));
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            assert.ok(
                render.callCount <= 1,
                'Only the first resize may discover the closed server',
            );
            sinon.assert.notCalled(errors);
            assert.strictEqual(viewer.activePlot, thirdId);
            await viewer.focusPlot(firstId);
            assert.ok(
                viewer.plots.find((plot) => plot.id === firstId)!.data.includes('FIRST DEVICE'),
            );
            await viewer.focusPlot(secondId);
            assert.ok(
                viewer.plots.find((plot) => plot.id === secondId)!.data.includes('SECOND DEVICE'),
            );
            assert.strictEqual(viewer.plots.length, 3);
        } finally {
            viewer?.webviewPanel?.dispose();
            await process.dispose();
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (
                        tab.input instanceof vscode.TabInputText &&
                        tab.input.uri.toString() === document.uri.toString()
                    ) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
            await executeRealCommand('vscode.setEditorLayout', originalLayout);
        }
    });

    test('standard reconnect refreshes only its existing panel without revealing or reopening it', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        const reattached = owner('a', '123');
        focus(b);
        sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => (source.sessionId === a.sessionId ? reattached : b));
        const request = sandbox
            .stub(session, 'sessionRequest')
            .resolves({ data: 'old', format: 'svg' });
        const value = await manager();
        await value.showStandardPlot(a);
        await value.showStandardPlot(b);
        await panels[0].receive({ type: 'ready' });
        request.resetHistory();
        panels[0].post.resetHistory();
        request.resolves({ data: 'drawn-while-disconnected', format: 'svg' });

        await value.showStandardPlot(reattached, true);
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.firstCall.args[1], reattached);
        sinon.assert.calledWith(panels[0].post, {
            type: 'update',
            data: 'drawn-while-disconnected',
            format: 'svg',
        });
        sinon.assert.notCalled((panels[0].panel as unknown as { reveal: sinon.SinonStub }).reveal);
        sinon.assert.notCalled(panels[1].post);

        panels[0].panel.dispose();
        request.resetHistory();
        await value.showStandardPlot(reattached, true);
        await value.showStandardPlot(owner('never-opened', '789'), true);
        sinon.assert.notCalled(request);
        assert.strictEqual(panels.length, 2);
        assert.strictEqual(value.viewers.length, 2);
    });

    test('standard restoration requests only the focused session', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const request = sandbox
            .stub(session, 'sessionRequest')
            .resolves({ data: 'svg', format: 'svg' });
        const first = await manager();
        await first.showStandardPlot(a);
        await first.showStandardPlot(b);
        for (const { panel } of panels) {
            panel.dispose();
        }
        await first.dispose();
        panels = [];
        await manager();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        await panels[0].receive({ type: 'ready' });
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.firstCall.args[1], a);
    });

    test('JGD frames update only their own viewer without redundant toolbar messages', async () => {
        const value = await manager();
        const deliver = startJgd(value);
        const history = value.jgdManager.history;
        history.addPlot('a', frame('a'));
        history.setSessionLabel('a', 'r-123-1');
        deliver('a', { type: 'frame' });
        await panels[0].receive({ type: 'ready' });
        const post = panels[0].post;
        post.resetHistory();
        for (let index = 0; index < 100; index++) {
            history.addPlot('b', frame('b'));
            deliver('b', { type: 'frame' });
        }
        sinon.assert.notCalled(post);
        assert.strictEqual(panels.length, 2);
        history.setSessionLabel('b', 'r-456-1');
        await panels[1].receive({ type: 'ready' });
        assert.strictEqual(panels[0].panel.title, 'R Plot (JGD)');
        assert.strictEqual(panels[1].panel.title, 'R Plot (JGD)');
        assert.ok(!panels[0].panel.webview.html.includes('session-select'));
        panels[1].post.resetHistory();

        for (let index = 0; index < 100; index++) {
            history.appendOps('a', { ...frame('a'), ops: [{ op: 'line', index }] });
            deliver('a', { type: 'frame' });
        }
        assert.strictEqual(post.withArgs(sinon.match({ type: 'render' })).callCount, 100);
        sinon.assert.notCalled(post.withArgs(sinon.match({ type: 'toolbar' })));
        sinon.assert.notCalled(panels[1].post);
        assert.strictEqual(history.currentPlot('a')?.ops.length, 100);
        await panels[0].receive({ type: 'ready' });
        sinon.assert.calledOnce(post.withArgs(sinon.match({ type: 'toolbar' })));
    });

    test('JGD tabs independently navigate, resize, measure text, remove plots and reopen', async () => {
        const value = await manager();
        const metrics = sandbox.spy(value.jgdManager.server, 'setMeasureText');
        const dimensions = sandbox.spy(value.jgdManager.server, 'setGetDimensions');
        const deliver = startJgd(value);
        const resize = sandbox.stub(value.jgdManager.server, 'handleResize');
        const history = value.jgdManager.history;
        const aOwner = owner('a', '123');
        focus(aOwner);
        sandbox.stub(session, 'resolvePlotSession').returns(aOwner);
        for (const id of ['a', 'b']) {
            history.addPlot(id, frame(id, `${id}1`));
            history.addPlot(id, frame(id, `${id}2`));
            history.setSessionSource(id, id === 'a' ? aOwner : owner('b', '456'));
            deliver(id, { type: 'frame' });
            await panels.at(-1)!.receive({ type: 'ready' });
        }
        const a = value.jgdManager.getViewer('a')!;
        const b = value.jgdManager.getViewer('b')!;
        assert.notStrictEqual(a.id, b.id);
        Object.assign(panels[0].panel, { active: false });
        assert.strictEqual(value.activeViewer, b);
        Object.assign(panels[0].panel, { active: true });
        Object.assign(panels[1].panel, { active: false });
        await callbacks.get('r.plot.prevPlot')!(
            vscode.Uri.parse('webview-panel:webview-panel/webview-jgd.plotPane-a'),
        );
        assert.strictEqual(history.currentIndex('a'), 1);
        assert.strictEqual(history.currentIndex('b'), 2);
        sinon.assert.calledWithExactly(resize, 800, 600, 'a');
        await panels[0].receive({ type: 'resize', width: 700, height: 500 });
        await panels[1].receive({ type: 'resize', width: 900, height: 650 });
        sinon.assert.calledWithExactly(resize, 700, 500, 'a');
        sinon.assert.calledWithExactly(resize, 900, 650, 'b');
        const getDimensions = dimensions.firstCall.args[0];
        assert.deepStrictEqual(getDimensions('a'), { width: 700, height: 500 });
        assert.deepStrictEqual(getDimensions('b'), { width: 900, height: 650 });
        const measure = metrics.firstCall.args[0];
        panels[0].post.resetHistory();
        panels[1].post.resetHistory();
        const measured = measure(
            { type: 'metrics_request', id: 7, kind: 'strWidth', str: 'x' },
            96,
            'a',
        );
        const request = panels[0].post.lastCall.args[0] as { id: number };
        sinon.assert.notCalled(panels[1].post);
        await panels[0].receive({
            type: 'metrics_response',
            id: request.id,
            originalId: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        assert.deepStrictEqual(await measured, {
            type: 'metrics_response',
            id: 7,
            width: 42,
            ascent: 10,
            descent: 3,
        });
        await panels[0].receive({ type: 'deleteCurrent' });
        assert.strictEqual(history.count('a'), 1);
        assert.strictEqual(history.count('b'), 2);
        await b.handleCommand('resetPlots');
        assert.strictEqual(history.count('a'), 1);
        assert.strictEqual(history.count('b'), 0);
        panels[0].panel.dispose();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 3, 'only the closed tab is recreated');
        await panels[2].receive({ type: 'ready' });
        sinon.assert.calledWith(
            panels[2].post,
            sinon.match({ type: 'render', plot: sinon.match({ sessionId: 'a' }) }),
        );
    });

    test('JGD restores separate tabs with each session history position after reload', async () => {
        const first = await manager();
        const history = first.jgdManager.history;
        history.addPlot('a', frame('a', 'a1'));
        history.addPlot('a', frame('a', 'a2'));
        history.addPlot('b', frame('b', 'b1'));
        history.addPlot('b', frame('b', 'b2'));
        history.navigatePrevious('a');
        const a = owner('a', '123');
        const b = owner('b', '456');
        history.setSessionSource('a', a);
        history.setSessionSource('b', b);
        const active = sandbox.stub(session, 'activeSession').value(a);
        sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => source as session.Session);
        await first.dispose();
        const restored = await manager();
        assert.strictEqual(panels.length, 0);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        active.value(b);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 2);
        for (const [index, id, bg] of [
            [0, 'a', 'a1'],
            [1, 'b', 'b2'],
        ] as const) {
            await panels[index].receive({ type: 'ready' });
            sinon.assert.calledWith(
                panels[index].post,
                sinon.match({
                    type: 'render',
                    plot: sinon.match({ sessionId: id, device: sinon.match({ bg }) }),
                }),
            );
            assert.strictEqual(panels[index].panel.title, 'R Plot (JGD)');
        }
        await restored.jgdManager.getViewer('b')!.handleCommand('firstPlot');
        assert.strictEqual(restored.jgdManager.history.currentIndex('a'), 1);
        assert.strictEqual(restored.jgdManager.history.currentIndex('b'), 1);
    });

    test('standard restoration waits for the owning session instead of showing an archived image', async () => {
        const first = await manager();
        const owner = {
            sessionId: 'a',
            host: 'host',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        } as session.Session;
        sandbox.stub(session, 'sessionRequest').resolves({ data: 'plot', format: 'svg' });
        focus(owner);
        const resolve = sandbox.stub(session, 'resolvePlotSession').returns(undefined);
        const information = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
        await first.showStandardPlot(owner);
        await panels[0].receive({ type: 'ready' });
        await first.dispose();
        panels = [];
        await manager();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 0);
        sinon.assert.calledOnce(information);
        resolve.returns(owner);
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
    });

    test('httpgd reconnects with its token and retains live rendering and removal after reload', async () => {
        const source = owner('httpgd-owner', '14001');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=secret', source);
        RefreshViewer.prototype.seedPlots.call(first.httpgdManager.viewers[0], [
            { id: '1', data: '<svg>not persisted</svg>', width: 400, height: 300, zoom: 1 },
        ]);
        await first.dispose();
        assert.ok(!JSON.stringify([...state.values()]).includes('secret'));
        assert.ok(!JSON.stringify([...secrets.values()]).includes('<svg>'));
        panels = [];
        connect.resetHistory();
        const restored = await manager();
        sinon.assert.notCalled(connect);
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
        const viewer = restored.httpgdManager.viewers[0];
        assert.strictEqual(viewer.token, 'secret');
        assert.deepStrictEqual(viewer.plots, []);
        RefreshViewer.prototype.seedPlots.call(viewer, [
            { id: 'live', data: '<svg/>', width: 1, height: 1, zoom: 1 },
        ]);
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>fresh</svg>');
        sandbox.stub(viewer.api, 'getPlots').returns([{ id: 'live' }]);
        await viewer.focusPlot('live');
        sinon.assert.called(render);
        const remove = sandbox.stub(viewer.api, 'removePlot').resolves();
        await viewer.closePlot('live');
        sinon.assert.calledWithExactly(remove, { id: 'live' });
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
    });

    for (const fullWindow of [false, true]) {
        test(`httpgd ${fullWindow ? 'full-window' : 'divider'} layout follows a resized group after closing and reopening`, async () => {
            interface Layout {
                width: number;
                height: number;
                windowWidth: number;
                windowHeight: number;
                fullWindow: boolean;
            }
            let inspection: Layout | undefined;
            (vscode.window.createWebviewPanel as sinon.SinonStub).callsFake(
                (...args: Parameters<typeof createRealWebviewPanel>) => {
                    const panel = createRealWebviewPanel(...args);
                    panel.webview.onDidReceiveMessage((message: Layout & { message: string }) => {
                        if (message.message === 'layout-inspection') {
                            inspection = message;
                        }
                    });
                    return panel;
                },
            );
            const layout = (width: number, height: number) =>
                executeRealCommand('vscode.setEditorLayout', {
                    orientation: 0,
                    groups: [
                        { size: 1 - width },
                        { size: width, groups: [{ size: height }, { size: 1 - height }] },
                    ],
                });
            const value = await manager();
            const viewer = new LayoutViewer('http://localhost:1234', {
                ...value.httpgdManager.viewerOptions,
                fullWindow,
                resizeTimeoutLength: 0,
                source: owner('layout', '14002'),
            });
            value.httpgdManager.registerViewer(viewer);
            const svg = (width: number, height: number) =>
                `<svg xmlns="http://www.w3.org/2000/svg" class="httpgd" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="blue"/></svg>`;
            RefreshViewer.prototype.seedPlots.call(viewer, [
                { id: '1', data: svg(800, 400), width: 800, height: 400, zoom: 1 },
            ]);
            viewer.activePlot = '1';
            const render = sandbox
                .stub(viewer.api, 'getPlotText')
                .callsFake((request) => Promise.resolve(svg(request.width!, request.height!)));
            const inspect = async (dragHeight?: number): Promise<Layout> => {
                inspection = undefined;
                await viewer.webviewPanel!.webview.postMessage({
                    message: 'inspect-layout',
                    dragHeight,
                });
                return waitForValue(() => inspection);
            };
            await prepareEditorLayout();
            const originalLayout = await executeRealCommand('vscode.getEditorLayout');
            const documents: vscode.TextDocument[] = [];
            try {
                for (const viewColumn of [
                    vscode.ViewColumn.One,
                    vscode.ViewColumn.Two,
                    vscode.ViewColumn.Three,
                ]) {
                    const document = await vscode.workspace.openTextDocument({
                        language: 'plaintext',
                    });
                    documents.push(document);
                    await vscode.window.showTextDocument(document, { viewColumn, preview: false });
                }
                await layout(0.7, 0.75);
                viewer.show();
                await waitForValue(() => (render.called ? true : undefined));
                const enlarged = await inspect(fullWindow ? undefined : 240);
                assert.strictEqual(enlarged.fullWindow, fullWindow);
                if (!fullWindow) {
                    assert.strictEqual(enlarged.height, 240);
                }
                viewer.webviewPanel!.dispose();
                assert.strictEqual(viewer.webviewPanel, undefined);
                await layout(0.4, 0.5);
                render.resetHistory();
                viewer.show();
                await waitForValue(() => (render.called ? true : undefined));
                const reopened = await inspect();
                assert.ok(
                    reopened.windowWidth < enlarged.windowWidth,
                    `width should shrink: ${enlarged.windowWidth} -> ${reopened.windowWidth}`,
                );
                assert.ok(
                    reopened.windowHeight < enlarged.windowHeight,
                    `height should shrink: ${enlarged.windowHeight} -> ${reopened.windowHeight}`,
                );
                assert.strictEqual(reopened.fullWindow, fullWindow);
                assert.strictEqual(
                    viewer.viewWidth,
                    fullWindow ? reopened.windowWidth : reopened.width,
                );
                assert.strictEqual(viewer.viewHeight, reopened.height);
                if (fullWindow) {
                    assert.strictEqual(reopened.height, reopened.windowHeight - 28);
                } else {
                    assert.strictEqual(
                        reopened.height,
                        enlarged.height,
                        'preserve the divider height when reopening',
                    );
                }
            } finally {
                viewer.webviewPanel?.dispose();
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        if (
                            tab.input instanceof vscode.TabInputText &&
                            documents.some(
                                (document) =>
                                    document.uri.toString() ===
                                    (tab.input as vscode.TabInputText).uri.toString(),
                            )
                        ) {
                            await vscode.window.tabGroups.close(tab);
                        }
                    }
                }
                await executeRealCommand('vscode.setEditorLayout', originalLayout);
            }
        });
    }

    test('httpgd reload fetches fresh plots from an authenticated server', async () => {
        const source = owner('httpgd-owner', '14001');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        connect.callThrough();
        let revision = 1;
        let removed = false;
        const requests: string[] = [];
        const server = http.createServer((request, response) => {
            if (request.headers['x-httpgd-token'] !== 'device-token') {
                response.writeHead(401).end();
                return;
            }
            const route = new URL(request.url!, 'http://localhost').pathname;
            requests.push(route);
            const state = { upid: revision, hsize: removed ? 0 : 1, active: true };
            switch (route) {
                case '/renderers':
                    response.end(
                        JSON.stringify({
                            renderers: [{ id: 'svgp', name: 'SVG', ext: 'svg', descr: 'SVG' }],
                        }),
                    );
                    break;
                case '/plots':
                    response.end(JSON.stringify({ state, plots: removed ? [] : [{ id: '1' }] }));
                    break;
                case '/plot':
                    response.end(`<svg><text>revision ${revision}</text></svg>`);
                    break;
                case '/remove':
                    removed = true;
                    response.end(JSON.stringify({ ...state, hsize: 0 }));
                    break;
                default:
                    response.end(JSON.stringify(state));
            }
        });
        server.on('upgrade', (_request, socket) => socket.destroy());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        let restored: CommonPlotManager | undefined;
        try {
            const first = await manager();
            const address = server.address() as AddressInfo;
            await first.showHttpgdPlot(
                `http://127.0.0.1:${address.port}/live?token=device-token`,
                source,
            );
            await waitForValue(() =>
                first.httpgdManager.viewers[0].plots.length ? true : undefined,
            );
            await first.dispose();
            revision = 2;
            requests.length = 0;
            restored = await manager();
            await callbacks.get('r.plot.showViewers')!();
            const viewer = restored.httpgdManager.viewers[0];
            await waitForValue(() =>
                viewer.plots[0]?.data.includes('revision 2') ? true : undefined,
            );
            assert.ok(requests.includes('/renderers'));
            assert.ok(requests.includes('/plots'));
            assert.ok(requests.includes('/plot'));
            assert.ok(
                (await viewer.api.getPlotBytes({ id: '1', renderer: 'svgp' }))
                    .toString()
                    .includes('revision 2'),
            );
            await viewer.closePlot('1');
            assert.strictEqual(removed, true);
        } finally {
            await restored?.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('httpgd restoration does not replace a device that already attached with a new token', async () => {
        const source = owner('httpgd-owner', '14001');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old', source);
        await first.dispose();
        const restored = await manager();
        await restored.showHttpgdPlot('http://localhost:1234/live?token=new', source);
        const live = restored.httpgdManager.viewers[0];
        await callbacks.get('r.plot.showViewers')!();
        assert.deepStrictEqual(restored.httpgdManager.viewers, [live]);
        assert.strictEqual(live.token, 'new');
    });

    test('httpgd restoration keeps credentials from an attachment arriving at its async boundary', async () => {
        const source = owner('httpgd-owner', '14001');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old', source);
        await first.dispose();
        const restored = await manager();
        const show = restored.httpgdManager.showViewer.bind(restored.httpgdManager);
        sandbox
            .stub(restored.httpgdManager, 'showViewer')
            .callsFake((url, source, onlyIfMissing) => {
                if (new URL(url).searchParams.get('token') === 'old') {
                    void show('http://localhost:1234/live?token=new', source);
                }
                return show(url, source, onlyIfMissing);
            });
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(restored.httpgdManager.viewers.length, 1);
        assert.strictEqual(restored.httpgdManager.viewers[0].token, 'new');
    });

    test('a real JGD webview receives and exports restored frames after its ready handshake', async () => {
        const first = await manager();
        first.jgdManager.history.addPlot('old-device', {
            version: 1,
            sessionId: 'old-device',
            device: { width: 400, height: 300, dpi: 96, bg: 'magenta' },
            ops: [],
        });
        const source = owner('jgd-real-indicator', '12140');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        first.jgdManager.history.setSessionSource('old-device', source);
        await first.dispose();
        let panel: vscode.WebviewPanel | undefined;
        let resolveIndicator!: (message: { label: string; fontLoaded: boolean }) => void;
        const indicator = new Promise<{ label: string; fontLoaded: boolean }>((resolve) => {
            resolveIndicator = resolve;
        });
        let resolveReady!: () => void;
        let resolveExport!: (data: string) => void;
        const ready = new Promise<void>((resolve) => {
            resolveReady = resolve;
        });
        const exported = new Promise<string>((resolve) => {
            resolveExport = resolve;
        });
        (vscode.window.createWebviewPanel as sinon.SinonStub).callsFake(
            (...args: Parameters<typeof createRealWebviewPanel>) => {
                panel = createRealWebviewPanel(...args);
                panel.webview.onDidReceiveMessage(
                    (message: {
                        type: string;
                        data?: string;
                        label: string;
                        fontLoaded: boolean;
                    }) => {
                        if (message.type === 'indicator-check') {
                            resolveIndicator(message);
                        }
                        if (message.type === 'ready') {
                            resolveReady();
                        }
                        if (message.type === 'export_data' && message.data) {
                            resolveExport(message.data);
                        }
                    },
                );
                return panel;
            },
        );
        sandbox.stub(vscode.window, 'showSaveDialog').resolves(undefined);
        await manager();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('Restored webview did not render/export')),
                15000,
            );
        });
        try {
            await callbacks.get('r.plot.showViewers')!();
            panel!.webview.html = panel!.webview.html.replace(
                '</body>',
                `<script>
                window.addEventListener('load', async () => {
                    await document.fonts.ready;
                    vscode.postMessage({ type: 'indicator-check', label: document.querySelector('.viewer-session').getAttribute('aria-label'), fontLoaded: document.fonts.check('16px codicon') });
                });
            </script></body>`,
            );
            await Promise.race([ready, timeout]);
            const details = await Promise.race([indicator, timeout]);
            assert.strictEqual(details.label, 'R 4.6.0: 12140');
            assert.strictEqual(
                details.fontLoaded,
                true,
                'the shared information icon font loads under the JGD CSP',
            );
            await panel!.webview.postMessage({
                type: 'export',
                format: 'svg',
                width: 400,
                height: 300,
            });
            const svg = Buffer.from(await Promise.race([exported, timeout]), 'base64').toString(
                'utf8',
            );
            assert.ok(svg.includes('<svg'));
            assert.ok(svg.includes('magenta'), 'export must contain the restored plot');
        } finally {
            clearTimeout(timer);
            panel?.dispose();
        }
    });

    test('a retained JGD tab redraws plots made while hidden without resizing R', async () => {
        interface Inspection {
            hidden: boolean;
            background: string;
            container: number[];
            canvas: number[];
            pixel: number[];
        }
        let panel: vscode.WebviewPanel | undefined;
        let inspection: Inspection | undefined;
        (vscode.window.createWebviewPanel as sinon.SinonStub).callsFake(
            (...args: Parameters<typeof createRealWebviewPanel>) => {
                panel = createRealWebviewPanel(...args);
                panel.webview.onDidReceiveMessage((message: { type: string } & Inspection) => {
                    if (message.type === 'canvas-inspection') {
                        inspection = message;
                    }
                });
                return panel;
            },
        );
        const value = await manager();
        const history = value.jgdManager.history;
        history.addPlot('device', frame('device', 'blue'));
        const viewer = value.jgdManager.getViewer('device')!;
        const resize = sandbox.spy(value.jgdManager.server, 'handleResize');
        viewer.show();
        panel!.webview.html = panel!.webview.html.replace(
            '</body>',
            `<script>
            window.addEventListener('message', async (event) => {
                if (event.data.type !== 'inspect-canvas') return;
                if (event.data.visible) await new Promise(requestAnimationFrame);
                await replayChain;
                vscode.postMessage({
                    type: 'canvas-inspection', hidden: document.hidden,
                    background: currentPlot?.device.bg,
                    container: [container.clientWidth, container.clientHeight],
                    canvas: [canvas.clientWidth, canvas.clientHeight],
                    pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data)
                });
            });
        </script></body>`,
        );
        const inspect = async () => {
            inspection = undefined;
            await panel!.webview.postMessage({ type: 'inspect-canvas', visible: panel!.visible });
            return waitForValue(() => inspection);
        };
        let coveringEditor: vscode.TextEditor | undefined;
        try {
            const size = await waitForValue(() => resize.lastCall?.args);
            // Model an R frame already rendered at this viewport's dimensions.
            // Showing the same-sized tab again should only redraw the canvas.
            const plot = {
                ...frame('device', 'blue'),
                device: { ...frame('device').device, width: size[0], height: size[1], bg: 'blue' },
            };
            history.replaceLatest('device', plot);
            viewer.showPlot(history.currentPlot('device')!);
            const visible = await inspect();
            assert.deepStrictEqual(visible.canvas, visible.container);
            assert.deepStrictEqual(visible.pixel, [0, 0, 255, 255]);
            resize.resetHistory();

            const document = await vscode.workspace.openTextDocument({
                content: 'Cover the plot tab',
                language: 'plaintext',
            });
            coveringEditor = await vscode.window.showTextDocument(document, {
                viewColumn: panel!.viewColumn,
            });
            await waitForValue(() => (!panel!.visible ? true : undefined));
            const next = {
                ...plot,
                device: { ...plot.device, bg: 'magenta' },
                ops: Array.from({ length: 10000 }, () => ({
                    op: 'circle',
                    x: 50,
                    y: 50,
                    r: 1,
                    gc: { col: 'black' },
                })),
            };
            history.addPlot('device', next);
            viewer.showPlot(next);
            const hidden = await inspect();
            assert.strictEqual(
                hidden.background,
                'magenta',
                'the newest plot reached the hidden webview',
            );

            panel!.reveal();
            await waitForValue(() => (panel!.visible ? true : undefined));
            const shown = await inspect();
            assert.deepStrictEqual(
                shown.container,
                visible.container,
                'the viewport did not change',
            );
            assert.deepStrictEqual(
                shown.canvas,
                shown.container,
                'visibility alone restores the full canvas',
            );
            assert.deepStrictEqual(
                shown.pixel,
                [255, 0, 255, 255],
                'the canvas contains the newly selected plot',
            );
            assert.strictEqual(history.count('device'), 2);
            sinon.assert.notCalled(resize);
        } finally {
            panel?.dispose();
            if (coveringEditor) {
                await vscode.window.showTextDocument(coveringEditor.document);
                await executeRealCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('shutdown during credential loading does not reopen a connection or panel', async () => {
        const source = owner('httpgd-owner', '14001');
        focus(source);
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = await manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=secret', source);
        await first.dispose();
        const value = [...secrets.values()][0];
        let finishRead!: (value: string) => void;
        (extensionContext.secrets.get as sinon.SinonStub).returns(
            new Promise<string>((resolve) => {
                finishRead = resolve;
            }),
        );
        connect.resetHistory();
        panels = [];
        const restored = await manager();
        const showing = callbacks.get('r.plot.showViewers')!();
        const stopping = restored.dispose();
        finishRead(value);
        await Promise.all([showing, stopping]);
        sinon.assert.notCalled(connect);
        assert.strictEqual(panels.length, 0);
    });
    for (const backend of ['jgd', 'httpgd'] as const) {
        test(`${backend} updates a closed viewer's retained plot without reopening until a new plot`, async () => {
            const source = owner('retained', '321');
            const value = await manager();
            if (backend === 'jgd') {
                const deliver = startJgd(value);
                const history = value.jgdManager.history;
                history.addPlot('device', frame('device'));
                history.setSessionSource('device', source);
                deliver('device', { type: 'frame', newPage: true });
                panels[0].panel.dispose();
                history.appendOps('device', {
                    ...frame('device'),
                    ops: [{ op: 'text', str: 'annotation' }],
                });
                deliver('device', { type: 'frame', incremental: true });
                assert.strictEqual(panels.length, 1);
                assert.ok(JSON.stringify(history.latestPlot('device')?.ops).includes('annotation'));
                history.addPlot('device', frame('device', 'new'));
                deliver('device', { type: 'frame', newPage: true });
            } else {
                const viewer = new RefreshViewer('http://localhost:1234', {
                    ...value.httpgdManager.viewerOptions,
                    source,
                });
                value.httpgdManager.registerViewer(viewer);
                const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>first</svg>');
                await viewer.receivePlots(['a'], new Set(['a']));
                panels[0].panel.dispose();
                render.resolves('<svg>annotation</svg>');
                await viewer.receivePlots(['a'], new Set(['a']));
                assert.strictEqual(panels.length, 1);
                assert.ok(viewer.plots[0].data.includes('annotation'));
                await viewer.receivePlots(['a', 'b'], new Set(['a', 'b']));
            }
            assert.strictEqual(panels.length, 2, 'a new plot opens exactly one panel');
        });
    }

    test('live httpgd retains closed-device content, selection and hidden plots across reload', async function () {
        this.timeout(30000);
        connect.callThrough();
        const process = await startHttpgdR(this);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-httpgd-'));
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        try {
            const source = owner('retained-httpgd', String(process.r.pid));
            source.host = os.hostname();
            focus(source);
            sandbox.stub(session, 'resolvePlotSession').returns(source);
            const first = await manager();
            const url = await process.evaluate(
                'httpgd::hgd(silent=TRUE); plot(1:3, main="FIRST"); httpgd::hgd_url()',
            );
            await first.showHttpgdPlot(url, source);
            const viewer = first.httpgdManager.viewers[0];
            await waitForValue(() => (viewer.plots.length === 1 ? true : undefined));
            await process.evaluate(
                'text(2, 2, "FINAL ANNOTATION"); plot(4:6, main="SECOND"); "OK"',
            );
            await waitForValue(() => (viewer.plots.length === 2 ? true : undefined));
            assert.ok(viewer.plots[0].data.includes('FINAL ANNOTATION'));
            const other = await process.evaluate(
                'httpgd::hgd(silent=TRUE); plot(7:9, main="OTHER DEVICE"); httpgd::hgd_url()',
            );
            await first.showHttpgdPlot(other, source);
            await waitForValue(() => (viewer.plots.length === 3 ? true : undefined));
            const [firstId, secondId, otherId] = viewer.plots.map((plot) => plot.id);
            await viewer.focusPlot(firstId);
            viewer.hidePlot(secondId);
            await process.evaluate('graphics.off(); "OK"');
            assert.strictEqual(viewer.activePlot, firstId);
            await first.dispose();
            assert.ok(!JSON.stringify([...secrets.values()]).includes('<svg'));
            assert.ok(
                !JSON.stringify(state.get('r.plot.httpgdHistory')).includes('FINAL ANNOTATION'),
            );
            const restored = await manager();
            await callbacks.get('r.plot.showViewers')!();
            const live = restored.httpgdManager.viewers[0];
            assert.strictEqual(live.activePlot, firstId);
            assert.deepStrictEqual(live.hiddenPlots, [secondId]);
            assert.deepStrictEqual(
                live.plots.map((plot) => plot.id),
                [firstId, otherId],
            );
            const fetch = sandbox.spy(live.api, 'getPlotText');
            live.viewWidth = 900;
            await live.focusPlot(otherId);
            await live.focusPlot(firstId);
            const output = path.join(directory, 'retained.svg');
            await live.exportPlot(firstId, 'svgp', output);
            assert.ok((await fs.readFile(output, 'utf8')).includes('FINAL ANNOTATION'));
            live.resetPlots();
            await waitForValue(() => (live.plots.length === 3 ? true : undefined));
            assert.deepStrictEqual(
                live.plots.map((plot) => plot.id),
                [firstId, secondId, otherId],
            );
            sinon.assert.notCalled(fetch);
            sinon.assert.notCalled(errors);
            // Confirmed R exit still removes all persisted content and credentials.
            await process.dispose();
            await waitForValue(() => (live.isDisposed ? true : undefined));
            await restored.httpgdManager.saveConnections();
            assert.deepStrictEqual(state.get('r.plot.httpgdHistory'), {});
            assert.deepStrictEqual(state.get('r.plot.httpgdSelection'), {});
            assert.strictEqual(secrets.size, 0);
        } finally {
            await process.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('httpgd navigation checkpoints cursors without rewriting retained SVGs', async () => {
        const clock = sandbox.useFakeTimers();
        const source = owner('retained', '321');
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234', source);
        const viewer = value.httpgdManager.viewers[0];
        viewer.api.restorePlots(
            ['a', 'b'].map((id) => ({ id, reference: { origin: viewer.origin, id } })),
        );
        sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>retained</svg>');
        await RefreshViewer.prototype.receivePlots.call(viewer, ['a', 'b'], new Set(['a', 'b']));
        await value.httpgdManager.saveConnections();
        const update = (
            extensionContext.workspaceState as unknown as {
                update: sinon.SinonStub<[string, unknown], Promise<void>>;
            }
        ).update;
        update.resetHistory();
        await viewer.prevPlot();
        await clock.tickAsync(250);
        await checkpoint(value);
        const keys = update.getCalls().map((call) => call.args[0]);
        assert.ok(keys.includes('r.plot.httpgdSelection'));
        assert.ok(!keys.includes('r.plot.httpgdHistory'));
    });

    test('httpgd exit during a retained-content write removes its images and selection', async () => {
        const exits = processExits();
        const source = owner('writing-history', '321');
        const value = await manager();
        await value.showHttpgdPlot('http://localhost:1234', source);
        const viewer = value.httpgdManager.viewers[0];
        viewer.api.restorePlots([{ id: 'a', reference: { origin: viewer.origin, id: 'a' } }]);
        sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>retained</svg>');
        await RefreshViewer.prototype.receivePlots.call(viewer, ['a'], new Set(['a']));
        const started = deferred<void>();
        const finish = deferred<void>();
        let writes = 0;
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            async (key: string, data: unknown) => {
                if (key === 'r.plot.httpgdHistory' && ++writes === 1) {
                    started.resolve();
                    await finish.promise;
                }
                state.set(key, structuredClone(data));
            },
        );
        const saving = value.httpgdManager.saveConnections();
        await started.promise;
        exits.exit(source);
        finish.resolve();
        await saving;
        await value.httpgdManager.saveConnections();
        assert.deepStrictEqual(state.get('r.plot.httpgdHistory'), {});
        assert.deepStrictEqual(state.get('r.plot.httpgdSelection'), {});
        assert.strictEqual(secrets.size, 0);
    });

    test('httpgd redraws thumbnails in timeline order when restored devices arrive out of order', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        sandbox
            .stub(viewer.api, 'getPlotText')
            .callsFake(({ id }) => Promise.resolve(`<svg>${id}</svg>`));
        await viewer.receivePlots(['a', 'c']);
        await viewer.receivePlots(['a', 'b', 'c']);
        assert.deepStrictEqual(
            viewer.plots.map(({ id }) => id),
            ['a', 'b', 'c'],
        );
        const html = viewer.webviewPanel!.webview.html;
        assert.ok(html.indexOf('<svg>a</svg>') < html.indexOf('<svg>b</svg>'));
        assert.ok(html.indexOf('<svg>b</svg>') < html.lastIndexOf('<svg>c</svg>'));
    });

    test('httpgd retains annotations received while a plot is hidden before its device closes', async () => {
        const value = await manager();
        const viewer = new RefreshViewer(
            'http://localhost:1234',
            value.httpgdManager.viewerOptions,
        );
        value.httpgdManager.registerViewer(viewer);
        viewer.api.restorePlots([{ id: 'a', reference: { origin: viewer.origin, id: 'a' } }]);
        const render = sandbox.stub(viewer.api, 'getPlotText').resolves('<svg>first</svg>');
        await viewer.receivePlots(['a'], new Set(['a']));
        viewer.hidePlot('a');
        render.resolves('<svg>annotation</svg>');
        await viewer.receivePlots(['a'], new Set(['a']));
        assert.strictEqual(viewer.plots.length, 0);
        assert.strictEqual(viewer.snapshotHistory().plots[0].data, '<svg>annotation</svg>');
        sandbox.stub(viewer.api, 'isAvailable').returns(false);
        render.resetHistory();
        viewer.resetPlots();
        await waitForValue(() => (viewer.plots.length === 1 ? true : undefined));
        assert.strictEqual(viewer.plots[0].data, '<svg>annotation</svg>');
        sinon.assert.notCalled(render);
    });
});
