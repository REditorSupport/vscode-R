import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import fsp from 'node:fs/promises';
import * as fileSystem from '../../fileSystem';
import type { RSessionApi } from '../../api';
import * as extension from '../../extension';
import * as rTerminal from '../../rTerminal';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, SessionConnections } from '../common/sessionConnections';

suite('Session Terminal Binding', () => {
    let sandbox: sinon.SinonSandbox;
    let first: session.Session;
    let second: session.Session;
    let terminal: vscode.Terminal;
    let other: vscode.Terminal;
    let terminals: sinon.SinonStub;
    let activeTerminal: sinon.SinonStub;
    let configuration: sinon.SinonStub;
    let sendText: sinon.SinonStub;
    let otherSendText: sinon.SinonStub;
    let show: sinon.SinonStub;
    const api: RSessionApi = { getConnectionInfo: session.getConnectionInfo, activate: session.activateSessionById };

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.join(__dirname, '..', '..', '..'), sandbox);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(extension, 'rWorkspace').value(undefined);
        configuration = sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'source.focus' ? 'none' : undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        first = session.registerSessionTransport('binding-first', 'host', '/first', () => Promise.resolve(first.workspaceData));
        second = session.registerSessionTransport('binding-second', 'host', '/second', () => Promise.resolve(second.workspaceData));
        first.pid = '101'; second.pid = '202';
        sendText = sandbox.stub(); otherSendText = sandbox.stub(); show = sandbox.stub();
        terminal = { processId: Promise.resolve(undefined), sendText, show } as unknown as vscode.Terminal;
        other = { processId: Promise.resolve(99999), sendText: otherSendText, show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals = sandbox.stub(vscode.window, 'terminals').value([terminal, other]);
        activeTerminal = sandbox.stub(vscode.window, 'activeTerminal').value(other);
    });

    teardown(() => {
        session.unregisterSessionTransport(first);
        session.unregisterSessionTransport(second);
        session.deferWorkspaceRefresh();
        sandbox.restore();
    });

    test('one-argument activation preserves bindings and unbound background sessions reject execution', async () => {
        assert.strictEqual(await api.activate(first.sessionId), true);
        await assert.rejects(session.executeSessionCode(first, 'rm(iris)'), /no attached terminal/);
        assert.strictEqual(await api.activate(first.sessionId, { terminal }), true);
        assert.strictEqual(await api.activate(second.sessionId, { terminal: other }), true);
        await session.executeSessionCode(first, 'View(iris)');
        sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
        sinon.assert.notCalled(otherSendText);
        assert.strictEqual(await api.activate(first.sessionId), true);
        await session.executeSessionCode(first, 'rm(iris)');
        sinon.assert.calledWithExactly(sendText, 'rm(iris)');
    });

    test('Interactive execution takes priority over an explicit terminal', async () => {
        first.execute = sandbox.stub().resolves();
        assert.strictEqual(await api.activate(first.sessionId, { terminal }), true);
        await session.executeSessionCode(first, 'View(iris)');
        sinon.assert.calledOnceWithExactly(first.execute as sinon.SinonStub, 'View(iris)');
        sinon.assert.notCalled(sendText);
    });

    for (const pid of ['native', 'missing', 'pending'] as const) {
        for (const bindBeforeWaiting of [false, true]) {
            test(`readiness recognizes an explicit binding (PID: ${pid}, already bound: ${String(bindBeforeWaiting)})`, async () => {
                terminal = {
                    ...terminal,
                    processId: pid === 'pending' ? new Promise<number>(() => undefined)
                        : Promise.resolve(pid === 'native' ? 12345 : undefined),
                } as vscode.Terminal;
                terminals.value([terminal, other]);
                if (bindBeforeWaiting) { await api.activate(first.sessionId, { terminal }); }
                let ready = false;
                const waiting = session.waitForTerminalReady(terminal, 100).then(result => { ready = result; return result; });
                if (!bindBeforeWaiting) {
                    await Promise.resolve();
                    await api.activate(second.sessionId, { terminal: other });
                    assert.strictEqual(ready, false, 'another terminal binding must not release the wait');
                    await api.activate(first.sessionId, { terminal });
                }
                assert.strictEqual(await waiting, true);
                sinon.assert.notCalled(sendText);
            });
        }
    }

    test('terminal selection and manual activation recognize a binding without awaiting a PID', async () => {
        terminal = { ...terminal, processId: new Promise<number>(() => undefined) } as vscode.Terminal;
        terminals.value([terminal, other]);
        assert.strictEqual(await api.activate(first.sessionId, { terminal }), true);
        await api.activate(second.sessionId);
        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(session.activeSession, first);
        await api.activate(second.sessionId);
        activeTerminal.value(terminal);
        configuration.returns({ get: (key: string) => key === 'sessionWatcher' } as unknown as vscode.WorkspaceConfiguration);
        await session.activateRSession();
        assert.strictEqual(session.activeSession, first);
        sinon.assert.calledOnce(show);
    });

    for (const selection of ['terminal selection', 'manual activation'] as const) {
        for (const rebind of [false, true]) {
            test(`pending ${selection} cannot overwrite a newer public activation (rebind: ${String(rebind)})`, async () => {
                await api.activate(first.sessionId, { terminal });
                activeTerminal.value(terminal);
                configuration.returns({ get: (key: string) => key === 'sessionWatcher' } as unknown as vscode.WorkspaceConfiguration);
                const pending = selection === 'terminal selection'
                    ? session.switchSessionByTerminal(terminal) : session.activateRSession();
                assert.strictEqual(await api.activate(second.sessionId, rebind ? { terminal } : undefined), true);
                await pending;
                assert.strictEqual(session.activeSession, second);
                sinon.assert.notCalled(show);
                if (rebind) {
                    await session.executeSessionCode(second, 'View(iris)');
                    sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
                    await assert.rejects(session.executeSessionCode(first, 'rm(iris)'), /no attached terminal/);
                }
            });
        }
    }

    test('newer terminal selection wins over an older pending selection', async () => {
        await api.activate(first.sessionId, { terminal });
        await api.activate(second.sessionId, { terminal: other });
        await api.activate(first.sessionId);
        const older = session.switchSessionByTerminal(terminal);
        const newer = session.switchSessionByTerminal(other);
        await Promise.all([older, newer]);
        assert.strictEqual(session.activeSession, second);
    });

    for (const change of ['close', 'disconnect'] as const) {
        test(`pending manual activation does not focus a terminal after ${change}`, async () => {
            await api.activate(first.sessionId, { terminal });
            activeTerminal.value(terminal);
            configuration.returns({ get: (key: string) => key === 'sessionWatcher' } as unknown as vscode.WorkspaceConfiguration);
            const pending = session.activateRSession();
            if (change === 'close') { rTerminal.deleteTerminal(terminal); }
            else { session.unregisterSessionTransport(first); }
            await pending;
            sinon.assert.notCalled(show);
            sinon.assert.notCalled(sendText);
            if (change === 'disconnect') { assert.strictEqual(session.activeSession, undefined); }
        });
    }

    test('rebinding is exclusive for both the session and terminal', async () => {
        await api.activate(first.sessionId, { terminal });
        await api.activate(first.sessionId, { terminal: other });
        await api.activate(second.sessionId);
        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(session.activeSession, second, 'old terminal must not select its former owner');
        await session.executeSessionCode(first, 'View(iris)');
        sinon.assert.calledOnce(otherSendText);
        sinon.assert.notCalled(sendText);
        await api.activate(second.sessionId, { terminal: other });
        await assert.rejects(session.executeSessionCode(first, 'rm(iris)'), /no attached terminal/);
        await session.switchSessionByTerminal(other);
        assert.strictEqual(session.activeSession, second);
    });

    test('invalid activation leaves the active session and existing binding intact', async () => {
        await api.activate(first.sessionId, { terminal });
        assert.strictEqual(await api.activate('missing', { terminal }), false);
        terminals.value([terminal]);
        assert.strictEqual(await api.activate(second.sessionId, { terminal: other }), false);
        assert.strictEqual(session.activeSession, first);
        await session.executeSessionCode(first, 'View(iris)');
        sinon.assert.calledOnce(sendText);
    });

    // All consumers must agree after each ownership transition.
    for (const transition of ['close', 'disconnect', 'cleanup', 'replace', 'move'] as const) {
        test(`${transition} invalidates execution, readiness and terminal selection together`, async () => {
            await api.activate(first.sessionId, { terminal });
            if (transition === 'close') { rTerminal.deleteTerminal(terminal); }
            else if (transition === 'disconnect') { session.unregisterSessionTransport(first); }
            else if (transition === 'cleanup') { await session.cleanupSession(first.sessionId); }
            else if (transition === 'replace') { session.replaceSessionTransport(first, second); }
            else { await api.activate(first.sessionId, { terminal: other }); }
            await api.activate(second.sessionId);
            await session.switchSessionByTerminal(terminal);
            assert.strictEqual(session.activeSession, second);
            assert.strictEqual(await session.waitForTerminalReady(terminal, 1), false);
            if (transition !== 'move') {
                await assert.rejects(session.executeSessionCode(first, 'rm(iris)'), /no (attached terminal|longer attached)/);
            } else {
                await session.executeSessionCode(first, 'View(iris)');
                sinon.assert.calledOnce(otherSendText);
            }
            if (transition === 'close') { assert.strictEqual(await api.activate(first.sessionId, { terminal }), false); }
            sinon.assert.notCalled(sendText);
        });
    }

    for (const change of ['close', 'rebind', 'disconnect'] as const) {
        test(`queued input rejects a ${change} before sending to the terminal`, async () => {
            await api.activate(first.sessionId, { terminal });
            const sending = session.executeSessionCode(first, 'rm(iris)');
            if (change === 'close') { rTerminal.deleteTerminal(terminal); }
            else if (change === 'rebind') { await api.activate(second.sessionId, { terminal }); }
            else { session.unregisterSessionTransport(first); }
            await assert.rejects(sending, /no longer (owns|attached)/);
            sinon.assert.notCalled(sendText);
        });
    }

    test('a terminal closed between lines receives no remaining input', async () => {
        await api.activate(first.sessionId, { terminal });
        sendText.callsFake(() => rTerminal.deleteTerminal(terminal));
        await assert.rejects(session.executeSessionCode(first, 'View(iris)\nrm(iris)'), /no longer owns/);
        sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
    });
    test('queued input cannot reuse ownership after rebinding away and back', async () => {
        await api.activate(first.sessionId, { terminal });
        const sending = session.executeSessionCode(first, 'rm(iris)');
        const rejected = assert.rejects(sending, /no longer owns/);
        // Both ownership changes happen before the terminal input queue resumes.
        const away = api.activate(second.sessionId, { terminal });
        const back = api.activate(first.sessionId, { terminal });
        await Promise.all([away, back, rejected]);
        sinon.assert.notCalled(sendText);
        await session.executeSessionCode(first, 'View(iris)');
        sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
    });

    test('manual focus resolves the active session explicit terminal', async () => {
        const otherShow = sandbox.stub();
        terminal = { ...terminal, processId: Promise.resolve(12345) } as vscode.Terminal;
        other = { ...other, show: otherShow } as vscode.Terminal;
        terminals.value([terminal, other]);
        activeTerminal.value(terminal);
        configuration.returns({ get: (key: string) => key === 'sessionWatcher' } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(fileSystem, 'pathExists').resolves(false);
        const create = sandbox.stub(rTerminal, 'createRTerm').resolves(false);
        await api.activate(first.sessionId, { terminal: other });
        await session.activateRSession();
        sinon.assert.calledOnce(otherShow);
        sinon.assert.notCalled(create);
        sinon.assert.notCalled(sendText);
    });

    for (const change of ['activation', 'binding', 'close'] as const) {
        test(`manual attach is cancelled by ${change} while creating its command`, async () => {
            await session.getGlobalPipePath();
            const discovery = path.join(extension.extensionContext.globalStorageUri.fsPath, 'sessions', `${'a'.repeat(32)}.json`);
            terminal = {
                ...terminal, processId: Promise.resolve(12345),
                creationOptions: { env: { SESS_DISCOVERY_FILE: discovery } },
            } as vscode.Terminal;
            terminals.value([terminal, other]);
            activeTerminal.value(terminal);
            configuration.returns({ get: (key: string) => key === 'sessionWatcher' } as unknown as vscode.WorkspaceConfiguration);
            const started = deferred<void>();
            const proceed = deferred<void>();
            const mkdir = fsp.mkdir;
            const mkdirStub = sandbox.stub(fsp, 'mkdir') as unknown as sinon.SinonStub<[string, { recursive: true }], Promise<string | undefined>>;
            mkdirStub.callsFake(async (directory, options) => {
                started.resolve();
                await proceed.promise;
                return mkdir(directory, options);
            });
            const pending = session.activateRSession();
            await started.promise;
            if (change === 'close') { rTerminal.deleteTerminal(terminal); }
            else { await api.activate(second.sessionId, change === 'binding' ? { terminal } : undefined); }
            proceed.resolve();
            await pending;
            sinon.assert.notCalled(sendText);
            sinon.assert.notCalled(show);
            if (change !== 'close') { assert.strictEqual(session.activeSession, second); }
        });
    }

    test('a native attach preserves the selected terminal explicit owner', async () => {
        const connections = new SessionConnections();
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        terminal = { ...terminal, processId: Promise.resolve(12345) } as vscode.Terminal;
        other = { ...other, processId: Promise.resolve(23456) } as vscode.Terminal;
        terminals.value([terminal, other]);
        activeTerminal.value(terminal);
        await api.activate(first.sessionId, { terminal });
        try {
            await connections.attach('native-beside-explicit', 23456);
            assert.strictEqual(session.activeSession, first);
            assert.strictEqual(await session.waitForTerminalReady(terminal, 100), true);
            await session.executeSessionCode(first, 'View(iris)');
            sinon.assert.calledOnceWithExactly(sendText, 'View(iris)');
        } finally { await connections.dispose(); }
    });

});
