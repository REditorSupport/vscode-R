import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import * as rTerminal from '../../rTerminal';
import * as session from '../../session';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, SessionConnections, waitForValue } from '../common/sessionConnections';

suite('External Terminal Integration', () => {
    let sandbox: sinon.SinonSandbox;
    let connections: SessionConnections;
    let terminals: sinon.SinonStub;
    let activeTerminal: sinon.SinonStub;
    let showError: sinon.SinonStub;
    let showInformation: sinon.SinonStub;
    let closeEvents: vscode.EventEmitter<vscode.Terminal>;
    let activeEvents: vscode.EventEmitter<vscode.Terminal | undefined>;
    let activeSubscriptionDisposals: sinon.SinonSpy[];
    const terminalSpies = new WeakMap<vscode.Terminal, { sendText: sinon.SinonStub; show: sinon.SinonStub }>();
    const extensionRoot = path.join(__dirname, '..', '..', '..');

    function makeTerminal(processId: Promise<number | undefined> = Promise.resolve(undefined)) {
        const sendText = sandbox.stub();
        const show = sandbox.stub();
        const terminal = {
            name: 'External R Console', processId,
            sendText, show, dispose: sandbox.stub(),
        } as unknown as vscode.Terminal;
        terminalSpies.set(terminal, { sendText, show });
        return terminal;
    }

    function setTerminals(values: vscode.Terminal[], active = values[0]) {
        terminals.value(values);
        activeTerminal.value(active);
    }

    setup(async () => {
        await session.shutdownSessionWatcher();
        sandbox = sinon.createSandbox();
        connections = new SessionConnections();
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        sandbox.stub(extension, 'rWorkspace').value(undefined);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        terminals = sandbox.stub(vscode.window, 'terminals').value([]);
        activeTerminal = sandbox.stub(vscode.window, 'activeTerminal').value(undefined);
        closeEvents = new vscode.EventEmitter<vscode.Terminal>();
        activeEvents = new vscode.EventEmitter<vscode.Terminal | undefined>();
        activeSubscriptionDisposals = [];
        sandbox.stub(vscode.window, 'onDidCloseTerminal').callsFake(closeEvents.event);
        sandbox.stub(vscode.window, 'onDidChangeActiveTerminal').callsFake(listener => {
            const subscription = activeEvents.event(listener);
            const disposed = sandbox.spy();
            activeSubscriptionDisposals.push(disposed);
            return { dispose: () => { disposed(); subscription.dispose(); } };
        });
        showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        showInformation = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        sandbox.stub(util, 'config').returns({
            get: (key: string) => ({ sessionWatcher: true, alwaysUseActiveTerminal: false, bracketedPaste: true })[key],
        } as unknown as vscode.WorkspaceConfiguration);
        session.deploySessionWatcher(extensionRoot);
        await session.getGlobalPipePath();
    });

    teardown(async () => {
        await connections.dispose();
        await session.shutdownSessionWatcher();
        closeEvents.dispose();
        activeEvents.dispose();
        sandbox.restore();
    });

    test('unresolved PID terminal uses the hook, then binds a real sess connection before success', async () => {
        const terminal = makeTerminal(new Promise<number>(() => undefined));
        setTerminals([terminal]);
        let hookCalls = 0;
        const registration = session.registerTerminalIntegration(terminal, {
            attach: async token => {
                hookCalls++;
                assert.strictEqual(token.isCancellationRequested, false);
                const socket = await connections.attach('integration-real-connection', 55101, 'external-host', {
                    attachmentId: 'integration-test', autoActivate: false,
                });
                const reference = await waitForValue(() => session.getSessionReference('integration-real-connection'));
                return !socket.destroyed && await session.activateSessionById(reference.sessionId, {
                    connectionId: reference.connectionId, terminal, select: false,
                });
            },
        });
        try {
            await session.activateRSession();
            assert.strictEqual(hookCalls, 1);
            assert.strictEqual(session.activeSession?.sessionId, 'integration-real-connection');
            assert.strictEqual(session.getSessionReference('integration-real-connection')?.attachmentId, 'integration-test');
            await session.executeSessionCode(session.activeSession!, '1 + 1');
            sinon.assert.calledOnceWithExactly(terminalSpies.get(terminal)!.sendText, '1 + 1');
            sinon.assert.calledOnce(terminalSpies.get(terminal)!.show);
        } finally {
            registration.dispose();
            await session.cleanupSession('integration-real-connection');
        }
    });

    test('live owner is focused before the integration hook', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const owner = session.registerSessionTransport('integration-existing-owner', 'host', '/tmp', () => Promise.resolve({}));
        await session.activateSessionById(owner.sessionId, { terminal, select: false });
        const attach = sandbox.stub().resolves(false);
        const registration = session.registerTerminalIntegration(terminal, { attach });
        try {
            await session.activateRSession();
            sinon.assert.notCalled(attach);
            sinon.assert.calledOnce(terminalSpies.get(terminal)!.show);
            assert.strictEqual(session.activeSession, owner);
        } finally {
            registration.dispose();
            session.unregisterSessionTransport(owner);
        }
    });

    test('a registered unresolved PID terminal is excluded from native discovery scans', async () => {
        const external = makeTerminal(new Promise<number>(() => undefined));
        const native = makeTerminal(Promise.resolve(55108));
        setTerminals([external, native], native);
        const registration = session.registerTerminalIntegration(external, { attach: () => Promise.resolve(false) });
        try {
            const socket = await connections.attach('native-scan-with-integration', 55108, os.hostname());
            assert.strictEqual(socket._terminalPid, 55108);
            assert.strictEqual(session.activeSession?.sessionId, 'native-scan-with-integration');
        } finally {
            registration.dispose();
            await session.cleanupSession('native-scan-with-integration');
        }
    });

    test('registering the active terminal during native PID discovery cancels the native path', async () => {
        let resolvePid!: (pid: number | undefined) => void;
        let pidRead!: () => void;
        const readStarted = new Promise<void>(resolve => { pidRead = resolve; });
        const sendText = sandbox.stub();
        const show = sandbox.stub();
        const terminal = {
            name: 'Native R',
            get processId() { pidRead(); return new Promise<number | undefined>(resolve => { resolvePid = resolve; }); },
            sendText, show,
        } as unknown as vscode.Terminal;
        terminalSpies.set(terminal, { sendText, show });
        setTerminals([terminal]);
        const createRTerm = sandbox.stub(rTerminal, 'createRTerm').resolves(true);
        const nativeOperation = session.activateRSession();
        await readStarted;
        const registration = session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(false) });
        try {
            await session.activateRSession();
            resolvePid(undefined);
            await nativeOperation;
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            sinon.assert.notCalled(createRTerm);
        } finally {
            resolvePid(undefined);
            registration.dispose();
        }
    });

    test('registering a background terminal does not invalidate an unrelated native operation', async () => {
        let resolvePid!: (pid: number | undefined) => void;
        let pidRead!: () => void;
        const readStarted = new Promise<void>(resolve => { pidRead = resolve; });
        const sendText = sandbox.stub();
        const show = sandbox.stub();
        const active = {
            name: 'Native R',
            get processId() { pidRead(); return new Promise<number | undefined>(resolve => { resolvePid = resolve; }); },
            sendText, show,
        } as unknown as vscode.Terminal;
        terminalSpies.set(active, { sendText, show });
        const background = makeTerminal();
        setTerminals([active, background], active);
        const createRTerm = sandbox.stub(rTerminal, 'createRTerm').resolves(true);
        const nativeOperation = session.activateRSession();
        await readStarted;
        const registration = session.registerTerminalIntegration(background, { attach: () => Promise.resolve(false) });
        try {
            resolvePid(undefined);
            await nativeOperation;
            sinon.assert.calledOnce(createRTerm);
        } finally {
            resolvePid(undefined);
            registration.dispose();
        }
    });

    test('false and thrown hooks never use native fallback; throws get a host diagnostic', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const createRTerm = sandbox.stub(rTerminal, 'createRTerm').resolves(true);
        const decline = session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(false) });
        try {
            await session.activateRSession();
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            sinon.assert.notCalled(createRTerm);
        } finally { decline.dispose(); }

        const failure = new Error('proxy setup failed');
        const rejecting = session.registerTerminalIntegration(terminal, { attach: () => Promise.reject(failure) });
        try {
            await session.activateRSession();
            sinon.assert.calledOnceWithExactly(showError,
                'Failed to attach the R session in this external terminal: proxy setup failed');
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            sinon.assert.notCalled(createRTerm);
        } finally { rejecting.dispose(); }
    });

    test('true without a current terminal binding is diagnosed and does not fall back', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const createRTerm = sandbox.stub(rTerminal, 'createRTerm').resolves(true);
        const registration = session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(true) });
        try {
            await session.activateRSession();
            sinon.assert.calledOnceWithExactly(showError,
                'The external R terminal reported a successful attach but has no current session binding.');
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            sinon.assert.notCalled(createRTerm);
        } finally { registration.dispose(); }
    });

    test('busy clicks do not duplicate or invalidate the in-flight hook', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const owner = session.registerSessionTransport('integration-busy-owner', 'host', '/tmp', () => Promise.resolve({}));
        const gate = deferred<boolean>();
        const started = deferred<void>();
        const attach = sandbox.stub().callsFake(() => { started.resolve(); return gate.promise; });
        const registration = session.registerTerminalIntegration(terminal, { attach });
        try {
            const first = session.activateRSession();
            await started.promise;
            await session.activateRSession();
            sinon.assert.calledOnce(attach);
            sinon.assert.calledOnceWithExactly(showInformation, 'An R session attach is already in progress for this terminal.');
            assert.strictEqual(await session.activateSessionById(owner.sessionId, { terminal, select: false }), true);
            gate.resolve(true);
            await first;
            assert.strictEqual(session.activeSession, owner, 'the successful hook should still select its live bound owner');
            sinon.assert.calledOnce(terminalSpies.get(terminal)!.show);
        } finally {
            gate.resolve(true);
            registration.dispose();
            session.unregisterSessionTransport(owner);
        }
    });

    test('focus away and back cancels the hook without reviving it or attaching natively', async () => {
        const terminal = makeTerminal();
        const other = makeTerminal();
        setTerminals([terminal, other]);
        const gate = deferred<boolean>();
        const started = deferred<vscode.CancellationToken>();
        const registration = session.registerTerminalIntegration(terminal, {
            attach: token => { started.resolve(token); return gate.promise; },
        });
        try {
            const operation = session.activateRSession();
            const token = await started.promise;
            activeTerminal.value(other);
            activeEvents.fire(other);
            activeTerminal.value(terminal);
            activeEvents.fire(terminal);
            assert.strictEqual(token.isCancellationRequested, true);
            gate.resolve(true);
            await operation;
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            sinon.assert.notCalled(showError);
        } finally {
            gate.resolve(false);
            registration.dispose();
        }
    });

    test('dispose, close, and shutdown cancel active hooks and revoke registration first', async () => {
        for (const end of ['dispose', 'close', 'shutdown'] as const) {
            const terminal = makeTerminal();
            setTerminals([terminal]);
            const gate = deferred<boolean>();
            const started = deferred<vscode.CancellationToken>();
            const registration = session.registerTerminalIntegration(terminal, {
                attach: token => { started.resolve(token); return gate.promise; },
            });
            const operation = session.activateRSession();
            const token = await started.promise;
            const focusDispose = activeSubscriptionDisposals.at(-1)!;
            if (end === 'dispose') { registration.dispose(); }
            else if (end === 'close') { closeEvents.fire(terminal); }
            else { await session.shutdownSessionWatcher(); }
            assert.strictEqual(token.isCancellationRequested, true, `${end} should cancel the hook`);
            sinon.assert.calledOnce(focusDispose);
            gate.resolve(true);
            await operation;
            sinon.assert.notCalled(terminalSpies.get(terminal)!.sendText);
            if (end === 'dispose') {
                const replacement = session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(false) });
                replacement.dispose();
            } else {
                assert.throws(() => session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(true) }), /closed|shutting down/);
            }
            if (end === 'close') {
                session.cleanupTerminalBinding(terminal);
                // A new lifecycle can register only after a fresh terminal object appears.
                const freshTerminal = makeTerminal();
                setTerminals([freshTerminal]);
                const fresh = session.registerTerminalIntegration(freshTerminal, { attach: () => Promise.resolve(false) });
                fresh.dispose();
            }
            if (end === 'shutdown') { break; }
        }
    });

    test('shutdown cancellation can redeploy without the old teardown revoking new registrations', async () => {
        const terminal = makeTerminal();
        const freshTerminal = makeTerminal();
        setTerminals([terminal, freshTerminal]);
        const gate = deferred<boolean>();
        const started = deferred<void>();
        let replacementRegistration: vscode.Disposable | undefined;
        const replacementAttach = sandbox.stub().resolves(false);
        const oldRegistration = session.registerTerminalIntegration(terminal, {
            attach: token => {
                token.onCancellationRequested(() => {
                    session.deploySessionWatcher(extensionRoot);
                    replacementRegistration = session.registerTerminalIntegration(freshTerminal, { attach: replacementAttach });
                });
                started.resolve();
                return gate.promise;
            },
        });
        const operation = session.activateRSession();
        await started.promise;
        try {
            await session.shutdownSessionWatcher();
            assert.ok(replacementRegistration, 'cancellation reentrancy should register against the redeployed lifecycle');
            assert.strictEqual(session.isTerminalClosed(freshTerminal), false);
            gate.resolve(false);
            await operation;
            activeTerminal.value(freshTerminal);
            activeEvents.fire(freshTerminal);
            await session.activateRSession();
            sinon.assert.calledOnce(replacementAttach);
            assert.strictEqual(session.activeSession, undefined, 'the new registration should remain live and may decline attach');
        } finally {
            gate.resolve(false);
            oldRegistration.dispose();
            replacementRegistration?.dispose();
            await session.shutdownSessionWatcher();
        }
    });

    test('duplicate registrations reject and unregistered terminals retain the native fallback path', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const registration = session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(false) });
        assert.throws(() => session.registerTerminalIntegration(terminal, { attach: () => Promise.resolve(false) }), /already registered/);
        registration.dispose();
        const createRTerm = sandbox.stub(rTerminal, 'createRTerm').resolves(true);
        await session.activateRSession();
        sinon.assert.calledOnce(createRTerm);
    });

    test('a stale registration Disposable cannot remove its replacement', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const oldAttach = sandbox.stub().resolves(false);
        const oldRegistration = session.registerTerminalIntegration(terminal, { attach: oldAttach });
        oldRegistration.dispose();
        const newAttach = sandbox.stub().resolves(false);
        const newRegistration = session.registerTerminalIntegration(terminal, { attach: newAttach });
        try {
            oldRegistration.dispose();
            await session.activateRSession();
            sinon.assert.notCalled(oldAttach);
            sinon.assert.calledOnce(newAttach);
        } finally { newRegistration.dispose(); }
    });

    test('an old pending handler completion cannot clear a replacement handler run', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const oldGate = deferred<boolean>();
        const oldStarted = deferred<void>();
        const oldRegistration = session.registerTerminalIntegration(terminal, {
            attach: () => { oldStarted.resolve(); return oldGate.promise; },
        });
        const oldOperation = session.activateRSession();
        await oldStarted.promise;
        oldRegistration.dispose();

        const newGate = deferred<boolean>();
        const newStarted = deferred<void>();
        const newAttach = sandbox.stub().callsFake(() => { newStarted.resolve(); return newGate.promise; });
        const newRegistration = session.registerTerminalIntegration(terminal, { attach: newAttach });
        try {
            const newOperation = session.activateRSession();
            await newStarted.promise;
            oldGate.resolve(true);
            await oldOperation;
            await session.activateRSession();
            sinon.assert.calledOnce(newAttach);
            newGate.resolve(false);
            await newOperation;
        } finally {
            oldGate.resolve(false);
            newGate.resolve(false);
            newRegistration.dispose();
        }
    });

    test('another session selection during the hook is preserved while terminal binding remains usable', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        const other = session.registerSessionTransport('integration-other-selection', 'host', '/tmp', () => Promise.resolve({}));
        const gate = deferred<boolean>();
        const started = deferred<void>();
        const registration = session.registerTerminalIntegration(terminal, {
            attach: async () => {
                const socket = await connections.attach('integration-select-false', 55102, 'external-host', {
                    attachmentId: 'select-false-binding', autoActivate: false,
                });
                const reference = await waitForValue(() => session.getSessionReference('integration-select-false'));
                const success = await session.activateSessionById(reference.sessionId, {
                    connectionId: reference.connectionId, terminal, select: false,
                });
                started.resolve();
                await gate.promise;
                return success && !socket.destroyed;
            },
        });
        try {
            const operation = session.activateRSession();
            await started.promise;
            await session.activateSessionById(other.sessionId);
            gate.resolve(true);
            await operation;
            assert.strictEqual(session.activeSession, other, 'hook completion must not take back a newer session selection');
            const reference = session.getSessionReference('integration-select-false');
            assert.ok(reference);
            assert.strictEqual(reference.attachmentId, 'select-false-binding');
            assert.strictEqual(await session.activateSessionById(reference.sessionId, {
                connectionId: reference.connectionId, terminal, select: false,
            }), true, 'the binding must remain available after a newer selection');
            assert.strictEqual(session.activeSession, other);
            assert.strictEqual(await session.activateSessionById(reference.sessionId, { connectionId: reference.connectionId }), true);
            await session.executeSessionCode(session.activeSession!, 'View(iris)');
            sinon.assert.calledOnceWithExactly(terminalSpies.get(terminal)!.sendText, 'View(iris)');
        } finally {
            gate.resolve(true);
            registration.dispose();
            session.unregisterSessionTransport(other);
            await session.cleanupSession('integration-select-false');
        }
    });

    test('integration registration survives a disconnect and can attach a replacement connection', async () => {
        const terminal = makeTerminal();
        setTerminals([terminal]);
        let connectionsMade = 0;
        const registration = session.registerTerminalIntegration(terminal, {
            attach: async token => {
                assert.strictEqual(token.isCancellationRequested, false);
                connectionsMade++;
                const id = 'integration-reconnect';
                const socket = await connections.attach(id, 55103 + connectionsMade, 'external-host', {
                    attachmentId: `reconnect-${connectionsMade}`, autoActivate: false,
                });
                const reference = await waitForValue(() => session.getSessionReference(id));
                return !socket.destroyed && await session.activateSessionById(id, {
                    connectionId: reference.connectionId, terminal, select: false,
                });
            },
        });
        try {
            await session.activateRSession();
            await session.cleanupSession('integration-reconnect');
            await session.activateRSession();
            assert.strictEqual(connectionsMade, 2);
            assert.strictEqual(session.getSessionReference('integration-reconnect')?.attachmentId, 'reconnect-2');
        } finally {
            registration.dispose();
            await session.cleanupSession('integration-reconnect');
        }
    });
});
