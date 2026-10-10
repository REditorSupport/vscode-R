import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { RSessionApi } from '../../api';
import * as extension from '../../extension';
import * as executionTarget from '../../interactive/executionTarget';
import * as processTree from '../../processTree';
import * as rTerminal from '../../rTerminal';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, SessionConnections, waitForValue as waitFor } from '../common/sessionConnections';

suite('Session Terminal Lifecycle', () => {
    let sandbox: sinon.SinonSandbox;
    let ancestors: sinon.SinonStub;
    let connections: SessionConnections;

    setup(() => {
        sandbox = sinon.createSandbox();
        connections = new SessionConnections();
        mockExtensionContext(path.join(__dirname, '..', '..', '..'), sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        sandbox.stub(extension, 'rWorkspace').value(undefined);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        ancestors = sandbox.stub(processTree, 'getProcessAncestors').resolves([]);
    });

    teardown(async () => {
        await connections.dispose();
        session.deferWorkspaceRefresh();
        sandbox.restore();
    });

    for (const { delayedPid, parents } of [
        { delayedPid: false, parents: [] },
        { delayedPid: true, parents: [] },
        { delayedPid: false, parents: [46250] },
        { delayedPid: true, parents: [46299, 46250] },
    ]) {
        test(`terminal readiness waits for its own valid attach (delayed PID: ${String(delayedPid)}, ancestors: ${parents.length})`, async () => {
            const rPid = parents.length ? 46252 : 46250;
            ancestors.withArgs(rPid).resolves(parents);
            const otherRPid = parents.length ? 46253 : 46251;
            ancestors.withArgs(otherRPid).resolves([46251]);
            const backgroundPid = 46254;
            ancestors.withArgs(backgroundPid).resolves([rPid, ...parents]);
            const sendText = sandbox.stub();
            let resolvePid!: (pid: number) => void;
            const terminal = {
                processId: delayedPid ? new Promise<number>(resolve => { resolvePid = resolve; }) : Promise.resolve(46250),
                sendText, show: () => undefined,
            } as unknown as vscode.Terminal;
            const other = { processId: Promise.resolve(46251) } as unknown as vscode.Terminal;
            // Keep the unresolved PID out of terminal enumeration until attach
            // association runs, to avoid blocking an unrelated handshake.
            const terminals = sandbox.stub(vscode.window, 'terminals').value([other]);
            sandbox.stub(vscode.window, 'activeTerminal').value(other);
            let ready = false;
            const waiting = session.waitForTerminalReady(terminal).then(value => { ready = value; return value; });
            const sockets: session.Session['socket'][] = [];
            const attach = async (rPid: number) => {
                const socket = await connections.attach(`readiness-${rPid}`, rPid);
                sockets.push(socket);
            };
            try {
                await attach(otherRPid);
                assert.strictEqual(ready, false, 'another terminal must not release the wait');
                terminals.value([terminal, other]);
                if (delayedPid) { resolvePid(46250); }
                await attach(rPid);
                assert.strictEqual(await waiting, true);
                assert.strictEqual(sockets[1]._terminalPid, 46250);
                if (!parents.length) { sinon.assert.notCalled(ancestors); }
                assert.strictEqual(await session.waitForTerminalReady(terminal), true, 'already attached terminals resolve immediately');
                await session.switchSessionByTerminal(terminal);
                const foreground = session.activeSession;
                assert.strictEqual(foreground?.pid, String(rPid));
                assert.ok(foreground);

                await attach(backgroundPid);
                const background = await waitFor(() => session.activeSession?.pid === String(backgroundPid)
                    ? session.activeSession : undefined);
                assert.ok(background);
                assert.strictEqual(sockets[2]._terminalPid, undefined, 'background R must remain unassociated');
                await assert.rejects(session.executeSessionCode(background, 'Sys.getpid()'), /no attached terminal/);
                sinon.assert.notCalled(sendText);
                await session.switchSessionByTerminal(terminal);
                assert.strictEqual(session.activeSession, foreground, 'terminal selection must retain the foreground workspace');
                await session.executeSessionCode(foreground, 'Sys.getpid()');
                sinon.assert.calledOnce(sendText);

                // An explicit owner takes precedence even over a matching native PID.
                sendText.resetHistory();
                assert.strictEqual(await session.activateSessionById(background.sessionId, { terminal }), true);
                await assert.rejects(session.executeSessionCode(foreground, 'rm(iris)'), /no attached terminal/);
                sinon.assert.notCalled(sendText);
                await session.executeSessionCode(background, 'View(iris)');
                sinon.assert.calledOnce(sendText);

                // Moving the explicit owner away must not revive old native ownership.
                sendText.resetHistory();
                assert.strictEqual(await session.activateSessionById(background.sessionId, { terminal: other }), true);
                await assert.rejects(session.executeSessionCode(foreground, 'rm(iris)'), /no attached terminal/);
                await session.switchSessionByTerminal(terminal);
                assert.strictEqual(session.activeSession, background);
                assert.strictEqual(await session.waitForTerminalReady(terminal, 1), false);
                sinon.assert.notCalled(sendText);

                // IPC disconnect also leaves the superseded PID association retired.
                assert.strictEqual(await session.activateSessionById(background.sessionId, { terminal }), true);
                await session.cleanupSession(background.sessionId);
                assert.strictEqual(await session.activateSessionById(`readiness-${otherRPid}`), true);
                const selected = session.activeSession;
                await assert.rejects(session.executeSessionCode(foreground, 'rm(iris)'), /no attached terminal/);
                await session.switchSessionByTerminal(terminal);
                assert.strictEqual(session.activeSession, selected);
                sinon.assert.notCalled(sendText);

                // Only a fresh native handshake establishes terminal ownership again.
                await attach(rPid);
                await session.switchSessionByTerminal(terminal);
                const reattached = session.activeSession;
                assert.ok(reattached);
                assert.notStrictEqual(reattached, foreground);
                assert.strictEqual(reattached.pid, String(rPid));
                assert.strictEqual(await session.waitForTerminalReady(terminal), true);
                await session.executeSessionCode(reattached, 'View(iris)');
                sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');

                // A slow native PID lookup must not override a newer API selection.
                let resolveSelectionPid!: (pid: number) => void;
                const slowTerminal = {
                    ...terminal,
                    processId: new Promise<number>(resolve => { resolveSelectionPid = resolve; }),
                } as vscode.Terminal;
                terminals.value([slowTerminal, other]);
                const pendingSelection = session.switchSessionByTerminal(slowTerminal);
                assert.strictEqual(await session.activateSessionById(`readiness-${otherRPid}`), true);
                resolveSelectionPid(46250);
                await pendingSelection;
                assert.strictEqual(session.activeSession, selected);
            } finally {
                await connections.dispose();
            }
        });
    }

    for (const explicitBinding of [false, true]) {
        test(`managed terminal accepts its first source command after native attach (explicit binding: ${String(explicitBinding)})`, async () => {
            sandbox.stub(executionTarget, 'tryInteractiveExecution').resolves(false);
            sandbox.stub(util, 'config').returns({
                get: (key: string) => ({ sessionWatcher: true, consoleArgs: [], 'source.focus': 'none' })[key],
            } as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(util, 'getRterm').resolves(process.execPath);
            sandbox.stub(session, 'getSessConsentDirectory').resolves('/unused-test-consent');
            sandbox.stub(session, 'createSessionDiscoveryFile').resolves('/unused-test-discovery');
            sandbox.stub(session, 'updateTerminalSessionDiscoveryFile').resolves();
            const waitUntilReady = session.waitForTerminalReady;
            // Exercise the real readiness logic, with a bounded failure timeout.
            const readiness = sandbox.stub(session, 'waitForTerminalReady')
                .callsFake(terminal => waitUntilReady(terminal, 1000));
            const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            const sendText = sandbox.stub();
            const terminal = {
                name: 'R Interactive', processId: Promise.resolve(46260),
                show: () => undefined, sendText,
            } as unknown as vscode.Terminal;
            sandbox.stub(vscode.window, 'terminals').value([terminal]);
            sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
            sandbox.stub(vscode.window, 'createTerminal').returns(terminal);
            const sessionId = `source-readiness-${String(explicitBinding)}`;
            try {
                assert.strictEqual(await rTerminal.createRTerm(), true);
                await connections.attach(sessionId, 46260);
                const owner = await waitFor(() => session.activeSession?.sessionId === sessionId ? session.activeSession : undefined);
                assert.ok(owner);
                assert.strictEqual(owner.socket._terminalPid, 46260);
                if (explicitBinding) {
                    const api: RSessionApi = { getConnectionInfo: session.getConnectionInfo, activate: session.activateSessionById };
                    assert.strictEqual(await api.activate(owner.sessionId, { terminal }), true);
                }
                assert.strictEqual(await rTerminal.runTextInTerm('source("example.R")'), true);
                sinon.assert.calledOnceWithExactly(readiness, terminal);
                sinon.assert.calledOnceWithExactly(sendText, 'source("example.R")');
                sinon.assert.notCalled(warning);
            } finally {
                rTerminal.deleteTerminal(terminal);
                await session.cleanupSession(sessionId);
            }
        });
    }

    test('moving a native session to an explicit terminal requires a fresh attach after close', async () => {
        const sendText = sandbox.stub();
        const explicitSend = sandbox.stub();
        const terminal = { processId: Promise.resolve(46280), sendText, show: sandbox.stub() } as unknown as vscode.Terminal;
        const other = { processId: Promise.resolve(undefined), sendText: explicitSend, show: sandbox.stub() } as unknown as vscode.Terminal;
        sandbox.stub(vscode.window, 'terminals').value([terminal, other]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'source.focus' ? 'none' : undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        const api: RSessionApi = { getConnectionInfo: session.getConnectionInfo, activate: session.activateSessionById };
        await connections.attach('native-moved-to-explicit', 46280);
        const owner = session.activeSession;
        assert.ok(owner);
        await session.executeSessionCode(owner, 'View(iris)');
        sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
        sendText.resetHistory();

        // Input already queued for the native terminal is invalidated by the move.
        const queued = session.executeSessionCode(owner, 'rm(iris)');
        const rejected = assert.rejects(queued, /no longer owns/);
        await api.activate(owner.sessionId, { terminal: other });
        await rejected;
        assert.strictEqual(await session.waitForTerminalReady(terminal, 1), false);
        assert.strictEqual(await session.waitForTerminalReady(other, 100), true);
        await session.executeSessionCode(owner, 'View(iris)');
        sinon.assert.calledOnceWithExactly(explicitSend, 'View(iris)');

        // The old terminal must not select this session or become its execution fallback.
        await connections.attach('native-move-unrelated', 46281);
        const selected = session.activeSession;
        assert.strictEqual(selected?.sessionId, 'native-move-unrelated');
        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(session.activeSession, selected);
        rTerminal.deleteTerminal(other);
        await assert.rejects(session.executeSessionCode(owner, 'rm(iris)'), /no attached terminal/);
        assert.strictEqual(await session.waitForTerminalReady(terminal, 1), false);
        sinon.assert.notCalled(sendText);

        await connections.attach(owner.sessionId, 46280);
        await session.switchSessionByTerminal(terminal);
        const reattached = session.activeSession;
        assert.ok(reattached);
        assert.notStrictEqual(reattached, owner);
        assert.strictEqual(await session.waitForTerminalReady(terminal, 100), true);
        await session.executeSessionCode(reattached, 'View(iris)');
        sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
    });

    test('an older pending handshake cannot replace a newer connection with the same session ID', async () => {
        const entered = deferred<void>();
        const ancestorsResolved = deferred<number[]>();
        ancestors.withArgs(46270).callsFake(() => { entered.resolve(); return ancestorsResolved.promise; });
        const terminal = { processId: Promise.resolve(46271) } as unknown as vscode.Terminal;
        sandbox.stub(vscode.window, 'terminals').value([terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
        const old = await connections.startAttach('overlapping-reconnect', 46270);
        await entered.promise;
        const newer = await connections.attach('overlapping-reconnect', 46271);
        const owner = session.activeSession;
        assert.strictEqual(owner?.socket, newer);
        ancestorsResolved.resolve([46271]);
        await waitFor(() => old.destroyed || old._sessionId ? true : undefined);
        assert.strictEqual(session.activeSession, owner);
        assert.strictEqual(newer.destroyed, false);
        await session.cleanupSession('overlapping-reconnect', old);
        assert.strictEqual(session.activeSession, owner);
    });

    // Selection belongs to a logical session; execution still belongs to a connection.
    for (const selection of ['unchanged', 'same terminal', 'same public activation', 'same manual activation',
        'away and back', 'different terminal', 'different public activation'] as const) {
        test(`reconnect preserves logical selection during discovery (${selection})`, async () => {
            const entered = deferred<void>();
            const proceed = deferred<number[]>();
            ancestors.withArgs(46301).onFirstCall().resolves([46300]);
            ancestors.withArgs(46301).onSecondCall().callsFake(() => { entered.resolve(); return proceed.promise; });
            const sendText = sandbox.stub();
            const otherSendText = sandbox.stub();
            const terminal = { processId: Promise.resolve(46300), sendText, show: sandbox.stub() } as unknown as vscode.Terminal;
            const other = { processId: Promise.resolve(46310), sendText: otherSendText, show: sandbox.stub() } as unknown as vscode.Terminal;
            sandbox.stub(vscode.window, 'terminals').value([terminal, other]);
            const activeTerminal = sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
            sandbox.stub(util, 'config').returns({
                get: (key: string) => key === 'sessionWatcher' ? true : key === 'source.focus' ? 'none' : undefined,
            } as unknown as vscode.WorkspaceConfiguration);
            const api: RSessionApi = { getConnectionInfo: session.getConnectionInfo, activate: session.activateSessionById };
            const old = await connections.attach('selected-reconnect', 46301);
            const previous = session.activeSession;
            assert.ok(previous);
            const otherSocket = await connections.attach('other-selected-reconnect', 46310);
            assert.strictEqual(session.activeSession, previous);
            const replacement = await connections.startAttach(previous.sessionId, 46301);
            try {
                await entered.promise;
                if (selection === 'same terminal') { await session.switchSessionByTerminal(terminal); }
                else if (selection === 'same public activation') { assert.strictEqual(await api.activate(previous.sessionId), true); }
                else if (selection === 'same manual activation') { await session.activateRSession(); }
                else if (selection === 'away and back') {
                    await api.activate('other-selected-reconnect');
                    await session.switchSessionByTerminal(terminal);
                } else if (selection === 'different terminal') {
                    activeTerminal.value(other);
                    await session.switchSessionByTerminal(other);
                } else if (selection === 'different public activation') { await api.activate('other-selected-reconnect'); }
                const preserveOther = selection === 'different terminal' || selection === 'different public activation';
                const selected = session.activeSession;
                assert.ok(selected);
                assert.strictEqual(selected.socket, preserveOther ? otherSocket : old);
                proceed.resolve([46300]);
                await waitFor(() => replacement._sessionId === previous.sessionId ? true : undefined);

                assert.strictEqual(old.destroyed, true);
                assert.strictEqual(replacement.destroyed, false);
                assert.strictEqual(await session.waitForTerminalReady(terminal, 100), true);
                const current = session.activeSession;
                assert.ok(current);
                assert.strictEqual(current.socket, preserveOther ? otherSocket : replacement);
                if (preserveOther) { assert.strictEqual(current, selected); }
                else { assert.notStrictEqual(current, previous); }
                assert.strictEqual(session.workspaceData, current.workspaceData, 'Workspace state must follow the selected connection');
                await session.cleanupSession(previous.sessionId, old);
                assert.strictEqual(session.activeSession, current, 'late old-socket cleanup must not clear the selection');

                // Refresh selection, but never redirect a node owned by the old connection.
                await assert.rejects(session.executeSessionCode(previous, 'rm(iris)'), /no longer attached/);
                await session.executeSessionCode(current, 'View(iris)');
                sinon.assert.calledOnceWithExactly(preserveOther ? otherSendText : sendText, 'View(iris)');
                sinon.assert.notCalled(preserveOther ? sendText : otherSendText);
            } finally { proceed.resolve([46300]); }
        });
    }

    test('native discovery cannot revive ownership changed while its PID was pending', async () => {
        const entered = deferred<void>();
        const pid = deferred<number>();
        const terminal = { get processId() { entered.resolve(); return pid.promise; } } as unknown as vscode.Terminal;
        const other = { processId: Promise.resolve(46273) } as unknown as vscode.Terminal;
        sandbox.stub(vscode.window, 'terminals').value([terminal, other]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
        const owner = session.registerSessionTransport('binding-during-discovery', 'host', '/project', () => Promise.resolve({}));
        try {
            const socket = await connections.startAttach('pending-native-discovery', 46272);
            await entered.promise;
            await session.activateSessionById(owner.sessionId, { terminal });
            await session.activateSessionById(owner.sessionId, { terminal: other });
            pid.resolve(46272);
            await waitFor(() => socket._sessionId === 'pending-native-discovery' ? true : undefined);
            assert.strictEqual(socket._terminalPid, undefined);
            assert.strictEqual(session.activeSession, owner);
            assert.strictEqual(await session.waitForTerminalReady(terminal, 1), false);
        } finally { session.unregisterSessionTransport(owner); }
    });

    test('terminal readiness aborts on close even before processId resolves', async () => {
        const terminal = { processId: new Promise<number>(() => undefined) } as unknown as vscode.Terminal;
        const close = new vscode.EventEmitter<vscode.Terminal>();
        sandbox.stub(vscode.window, 'onDidCloseTerminal').callsFake(close.event);
        const waiting = session.waitForTerminalReady(terminal);
        close.fire(terminal);
        assert.strictEqual(await waiting, false);
        close.dispose();
    });

    test('terminal readiness timeout does not declare the terminal ready', async () => {
        const terminal = { processId: new Promise<number>(() => undefined) } as unknown as vscode.Terminal;
        const clock = sandbox.useFakeTimers();
        const waiting = session.waitForTerminalReady(terminal, 100);
        await clock.tickAsync(100);
        assert.strictEqual(await waiting, false);
        assert.strictEqual(clock.countTimers(), 0);
    });

});
