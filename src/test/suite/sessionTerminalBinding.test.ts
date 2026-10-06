import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { RSessionApi } from '../../api';
import * as extension from '../../extension';
import * as rTerminal from '../../rTerminal';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

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

    test('closing a downstream terminal clears the binding even without an exit status or PID', async () => {
        await api.activate(first.sessionId, { terminal });
        rTerminal.deleteTerminal(terminal);
        assert.strictEqual(await api.activate(first.sessionId, { terminal }), false);
        await assert.rejects(session.executeSessionCode(first, 'View(iris)'), /no attached terminal/);
        await api.activate(second.sessionId);
        await session.switchSessionByTerminal(terminal);
        assert.strictEqual(session.activeSession, second);
        sinon.assert.notCalled(sendText);
    });

    for (const lifecycle of ['cleanup', 'unregister', 'replace'] as const) {
        test(`${lifecycle} removes bindings instead of transferring them to a replacement`, async () => {
            await api.activate(first.sessionId, { terminal });
            if (lifecycle === 'cleanup') { await session.cleanupSession(first.sessionId); }
            else if (lifecycle === 'unregister') { session.unregisterSessionTransport(first); }
            else { session.replaceSessionTransport(first, second); }
            await api.activate(second.sessionId);
            await session.switchSessionByTerminal(terminal);
            assert.strictEqual(session.activeSession, second);
            await assert.rejects(session.executeSessionCode(first, 'rm(iris)'), /no longer attached/);
            await assert.rejects(session.executeSessionCode(second, 'rm(iris)'), /no attached terminal/);
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
});
