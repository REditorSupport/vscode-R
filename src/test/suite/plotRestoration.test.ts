import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { JgdManager } from '../../plotViewer/jgdViewer';
import type { JgdMessage } from '../../plotViewer/jgdSocketServer';
import type { PlotFrame, PlotHistoryState } from '../../plotViewer/jgdPlotHistory';
import { HttpgdClient } from '../../plotViewer/httpgdClient';
import { HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { extensionContext } from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, waitForValue } from '../common/sessionConnections';
import { sessionProcessIdentity } from '../../sessionIdentity';
import type { ViewerSessionSource } from '../../viewerSession';

const createRealWebviewPanel = vscode.window.createWebviewPanel;
const executeRealCommand = vscode.commands.executeCommand;

class RefreshViewer extends HttpgdViewer {
    receivePlots(ids: string[]): Promise<void> {
        return this.refreshPlots(ids.map((id) => ({ id })));
    }
}

suite('Standalone plot restoration', () => {
    let sandbox: sinon.SinonSandbox;
    let state: Map<string, unknown>;
    let secrets: Map<string, string>;
    let managers: CommonPlotManager[];
    let connect: sinon.SinonStub;
    let callbacks: Map<string, (...args: unknown[]) => Promise<void>>;
    let panels: Array<{
        panel: vscode.WebviewPanel;
        receive: (message: unknown) => Promise<void>;
        post: sinon.SinonStub;
    }>;

    setup(() => {
        sandbox = sinon.createSandbox();
        state = new Map();
        secrets = new Map();
        managers = [];
        callbacks = new Map();
        panels = [];
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
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
    });

    function manager(): CommonPlotManager {
        const value = new CommonPlotManager();
        value.initialize();
        managers.push(value);
        return value;
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

    test('httpgd process exit removes only its connections and saved credentials, keeping panels', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const replacement = owner(source.sessionId, '14002');
        const value = manager();
        await value.showHttpgdPlot('http://localhost:1234?token=old-1', source);
        await value.showHttpgdPlot('http://localhost:1235?token=old-2', source);
        const old = [...value.httpgdManager.viewers];
        old[0].show();
        const panel = old[0].webviewPanel;
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
        assert.strictEqual(old[0].webviewPanel, panel);
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
        const restored = manager();
        assert.strictEqual(await restored.httpgdManager.restoreConnection(source), undefined);
        assert.ok(await restored.httpgdManager.restoreConnection(replacement));
    });

    test('httpgd saved connections are cleaned on exit even without reopening a viewer', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await first.dispose();
        const restored = manager();
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
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234?token=secret', source);
        await first.dispose();
        const saved = [...secrets.values()][0];
        let load!: (value: string) => void;
        (extensionContext.secrets.get as sinon.SinonStub).returns(
            new Promise<string>((resolve) => {
                load = resolve;
            }),
        );
        const restored = manager();
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
        const value = manager();
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
            const value = manager();
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
        const value = manager();
        assert.strictEqual(await value.httpgdManager.restoreConnection(source), undefined);
        await value.showHttpgdPlot('http://localhost:1234?token=new-device', source);
        assert.ok(secrets.get('missing-secret')?.includes('new-device'));
        sinon.assert.notCalled(report);
    });

    test('httpgd already exited owners cannot register a new connection', async () => {
        const exits = processExits();
        const source = owner('httpgd-owner', '14001');
        exits.exit(source);
        const value = manager();
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
        const first = manager();
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
        await checkIndicators(manager());
    });

    test('JGD binds live devices including late R attachments, but never guesses a restored owner', async () => {
        const events = new vscode.EventEmitter<import('../../api').RSessionConnectionChange>();
        sandbox.stub(session, 'onDidChangeSessionConnection').callsFake(events.event);
        const a = owner('jgd-owner-a', '12111');
        const b = owner('jgd-owner-b', '12112');
        const resolve = sandbox.stub(session, 'resolveJgdSessionSource');
        resolve.withArgs('r-12111-1').returns(a);
        const value = manager();
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

    test('plot indicators update on owning process exit and release observations on tab close', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const kill = sandbox.stub(process, 'kill').returns(true);
        const source = owner('plot-exit', '12120');
        source.host = os.hostname();
        const value = manager();
        await value.showStandardPlot(source);
        await value.showHttpgdPlot('http://localhost:1234', source);
        value.jgdManager.history.addPlot('device', frame('device'));
        value.jgdManager.history.setSessionSource('device', source);
        value.httpgdManager.viewers[0].show();
        value.jgdManager.showForSession(source);
        assert.strictEqual(panels.length, 3);
        kill.callsFake(() => {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        });
        await clock.tickAsync(1000);
        for (const { panel, post } of panels) {
            sinon.assert.calledWith(post, {
                message: 'viewer-session/update',
                text: 'R: (not attached)',
            });
            panel.dispose();
        }
        kill.resetHistory();
        await clock.tickAsync(2000);
        sinon.assert.notCalled(kill);
    });

    test('httpgd gains the session indicator when an existing URL is attached to R', async () => {
        const value = manager();
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
        const first = manager();
        const history = first.jgdManager.history;
        history.addPlot('device', frame('device', 'first'));
        history.addPlot('device', frame('device', 'second'));
        await clock.tickAsync(250);
        const snapshot = sandbox.spy(history, 'snapshot');
        const update = (extensionContext.workspaceState as unknown as { update: sinon.SinonStub })
            .update;
        update.resetHistory();
        history.navigateFirst('device');
        await clock.tickAsync(250);
        sinon.assert.notCalled(snapshot);
        sinon.assert.neverCalledWith(update, 'r.plot.jgdState');
        sinon.assert.calledWith(update, 'r.plot.jgdSelection');
        assert.strictEqual(manager().jgdManager.history.currentPlot('device')?.device.bg, 'first');
        await first.dispose();
        sinon.assert.notCalled(snapshot);
        sinon.assert.neverCalledWith(update, 'r.plot.jgdState');

        // A crash between the content and cursor writes leaves mismatched IDs.
        state.set('r.plot.jgdSelection', {
            checkpointId: 'obsolete',
            positions: [{ deviceId: 'device', currentIndex: 0 }],
        });
        assert.strictEqual(manager().jgdManager.history.currentPlot('device')?.device.bg, 'second');
    });

    test('JGD coalesces pending checkpoints without mutating an in-flight snapshot', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const gate = deferred<void>();
        const writes: PlotHistoryState[] = [];
        (extensionContext.workspaceState.update as sinon.SinonStub).callsFake(
            async (key: string, value: unknown) => {
                if (key === 'r.plot.jgdState') {
                    writes.push(value as PlotHistoryState);
                    if (writes.length === 1) {
                        await gate.promise;
                    }
                }
                state.set(key, structuredClone(value));
            },
        );
        const first = manager();
        const history = first.jgdManager.history;
        history.addPlot('device', frame('device', 'first'));
        await clock.tickAsync(250);
        for (let i = 0; i < 3; i++) {
            history.appendOps('device', {
                ...frame('device'),
                ops: [{ op: 'text', str: String(i) }],
            });
            await clock.tickAsync(250);
        }
        assert.strictEqual(writes.length, 1, 'do not queue full snapshots behind a slow write');
        assert.deepStrictEqual(
            writes[0].sessions[0].plots[0].ops,
            [],
            'live drawing must not change the pending snapshot',
        );
        gate.resolve();
        await first.dispose();
        assert.strictEqual(writes.length, 2);
        assert.strictEqual(manager().jgdManager.history.currentPlot('device')?.ops.length, 3);
    });

    test('JGD checkpoints a reduced history limit before saving new cursor positions', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const first = manager();
        for (const bg of ['first', 'second', 'third']) {
            first.jgdManager.history.addPlot('device', frame('device', bg));
        }
        await first.dispose();
        (util.config as sinon.SinonStub).returns({
            get: (key: string, fallback: unknown) =>
                key === 'plot.jgd.historyLimit' ? 2 : fallback,
        });
        const restored = manager();
        assert.strictEqual(restored.jgdManager.history.count('device'), 2);
        restored.jgdManager.history.navigateFirst('device');
        await clock.tickAsync(250);
        assert.strictEqual(manager().jgdManager.history.currentPlot('device')?.device.bg, 'second');
    });

    test('all backends checkpoint restoration state before shutdown', async () => {
        const source = owner('checkpoint', '12150');
        sandbox.stub(session, 'sessionRequest').resolves({ data: 'live', format: 'svg' });
        sandbox.stub(session, 'resolvePlotSession').returns(source);
        const first = manager();
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
        const restored = manager();
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
        const first = manager();
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
        manager();
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
        sinon.assert.notCalled(request);
        sinon.assert.calledOnce(resolve);
        assert.strictEqual(panels.length, 1);
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

    test('Show Viewer opens only the focused session and never ownerless or empty JGD viewers', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        const active = sandbox.stub(session, 'activeSession').value(a);
        const resolve = sandbox
            .stub(session, 'resolvePlotSession')
            .callsFake((source) => source as session.Session);
        const value = manager();
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
        const first = manager();
        for (const source of [a, b]) {
            first.jgdManager.history.addPlot(source.sessionId, frame(source.sessionId));
            first.jgdManager.history.setSessionSource(source.sessionId, source);
        }
        await first.dispose();
        const saved = state.get('r.plot.jgdState') as PlotHistoryState;
        saved.activeSessionId = 'missing-device';
        const restored = manager();
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
            let value = manager();
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
                value = manager();
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
        const value = manager();
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
        const value = manager();
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
        const value = manager();
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
        const first = manager();
        const deliver = startJgd(first);
        first.jgdManager.history.addPlot('device', frame('device'));
        first.jgdManager.history.setSessionSource('device', source);
        deliver('device', { type: 'frame' });
        panels[0].panel.dispose();
        await first.dispose();
        (JgdManager.prototype.start as sinon.SinonStub).resetBehavior();
        panels = [];
        const restored = manager();
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
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234?token=a', a);
        await first.showHttpgdPlot('http://localhost:1235?token=b', b);
        await first.dispose();
        connect.resetHistory();
        const restored = manager();
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
        assert.strictEqual(restored.httpgdManager.viewers.length, 1);
        assert.strictEqual(restored.httpgdManager.viewers[0].connection.source?.sessionId, 'a');
        assert.strictEqual(panels.length, 1);
    });

    test('httpgd reattachment and existing plot updates keep closed panels closed', async () => {
        const source = owner('a', '123');
        const value = manager();
        const viewer = new RefreshViewer('http://localhost:1234', {
            ...value.httpgdManager.viewerOptions,
            source,
            restoring: true,
        });
        value.httpgdManager.viewers.push(viewer);
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

    test('httpgd devices share one visible viewer per session while other sessions remain independent', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const value = manager();
        await value.showHttpgdPlot('http://localhost:1234', a);
        const first = value.httpgdManager.viewers[0];
        first.show();
        await value.showHttpgdPlot('http://localhost:1235', b);
        const other = value.httpgdManager.viewers[0];
        other.show();
        await value.showHttpgdPlot('http://localhost:1236', a);
        const second = value.httpgdManager.viewers[0];
        second.show();
        assert.strictEqual(first.webviewPanel, undefined);
        assert.ok(second.webviewPanel);
        assert.ok(other.webviewPanel);
        first.show();
        assert.strictEqual(second.webviewPanel, undefined);
        assert.ok(first.webviewPanel);
        assert.ok(other.webviewPanel);
        panels.at(-1)!.panel.dispose();
        const count = panels.length;
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, count + 1);
        assert.ok(first.webviewPanel, 'reopens the last used device for the focused session');
        assert.strictEqual(second.webviewPanel, undefined);
    });

    test('standard restoration requests only the focused session', async () => {
        const a = owner('a', '123');
        const b = owner('b', '456');
        focus(a);
        sandbox.stub(session, 'resolvePlotSession').returns(a);
        const request = sandbox
            .stub(session, 'sessionRequest')
            .resolves({ data: 'svg', format: 'svg' });
        const first = manager();
        await first.showStandardPlot(a);
        await first.showStandardPlot(b);
        for (const { panel } of panels) {
            panel.dispose();
        }
        await first.dispose();
        panels = [];
        manager();
        await callbacks.get('r.plot.showViewers')!();
        assert.strictEqual(panels.length, 1);
        await panels[0].receive({ type: 'ready' });
        sinon.assert.calledOnce(request);
        assert.strictEqual(request.firstCall.args[1], a);
    });

    test('JGD frames update only their own viewer without redundant toolbar messages', async () => {
        const value = manager();
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
        const value = manager();
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
        await callbacks.get('r.plot.prevPlot')!(
            vscode.Uri.from({ scheme: 'webview', path: a.getPanelPath()! }),
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
        const first = manager();
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
        const restored = manager();
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
        const first = manager();
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
        manager();
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
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=secret', source);
        first.httpgdManager.viewers[0].plots = [
            { id: '1', data: '<svg>not persisted</svg>', width: 400, height: 300, zoom: 1 },
        ];
        await first.dispose();
        assert.ok(!JSON.stringify([...state.values()]).includes('secret'));
        assert.ok(!JSON.stringify([...secrets.values()]).includes('<svg>'));
        panels = [];
        connect.resetHistory();
        const restored = manager();
        sinon.assert.notCalled(connect);
        await callbacks.get('r.plot.showViewers')!();
        sinon.assert.calledOnce(connect);
        const viewer = restored.httpgdManager.viewers[0];
        assert.strictEqual(viewer.token, 'secret');
        assert.deepStrictEqual(viewer.plots, []);
        viewer.plots = [{ id: 'live', data: '<svg/>', width: 1, height: 1, zoom: 1 }];
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
            const first = manager();
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
            restored = manager();
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
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old', source);
        await first.dispose();
        const restored = manager();
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
        const first = manager();
        await first.showHttpgdPlot('http://localhost:1234/live?token=old', source);
        await first.dispose();
        const restored = manager();
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
        const first = manager();
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
        manager();
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
        const value = manager();
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
        const first = manager();
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
        const restored = manager();
        const showing = callbacks.get('r.plot.showViewers')!();
        const stopping = restored.dispose();
        finishRead(value);
        await Promise.all([showing, stopping]);
        sinon.assert.notCalled(connect);
        assert.strictEqual(panels.length, 0);
    });
});
