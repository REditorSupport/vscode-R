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
import { SessionConnections, waitForValue as waitFor } from '../common/sessionConnections';

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
            sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
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
