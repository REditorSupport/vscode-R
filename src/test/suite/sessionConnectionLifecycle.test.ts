import * as assert from 'assert';
import * as fsp from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { RSessionConnectionChange, RSessionPreparation } from '../../api';
import * as extension from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { pathExists } from '../../fileSystem';
import { SessConsentService } from '../../sessConsent';
import { mockExtensionContext } from '../common/mockvscode';
import { deferred, SessionConnections, waitForValue } from '../common/sessionConnections';

async function waitForFileRemoval(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (!await pathExists(filePath)) { return; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${filePath} to be removed`);
}

suite('Session Connection Lifecycle API', () => {
    let sandbox: sinon.SinonSandbox;
    let connections: SessionConnections;
    let terminals: sinon.SinonStub;
    let activeTerminal: sinon.SinonStub;
    let executeCommand: sinon.SinonStub;
    const extensionRoot = path.join(__dirname, '..', '..', '..');

    setup(async () => {
        await session.shutdownSessionWatcher();
        sandbox = sinon.createSandbox();
        connections = new SessionConnections();
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        sandbox.stub(extension, 'rWorkspace').value(undefined);
        executeCommand = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        terminals = sandbox.stub(vscode.window, 'terminals').value([]);
        activeTerminal = sandbox.stub(vscode.window, 'activeTerminal').value(undefined);
        sandbox.stub(util, 'config').returns({
            get: (key: string) => ({ bracketedPaste: true, 'source.focus': 'none' })[key],
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(SessConsentService.prototype, 'start').resolves();
        sandbox.stub(SessConsentService.prototype, 'stop').resolves();
        session.deploySessionWatcher(extensionRoot);
        await session.getGlobalPipePath();
    });

    teardown(async () => {
        await connections.dispose();
        session.deferWorkspaceRefresh();
        await session.shutdownSessionWatcher();
        sandbox.restore();
    });

    test('background external attach remains unselected and exposes its current reference', async () => {
        const events: RSessionConnectionChange[] = [];
        const subscription = session.onDidChangeSessionConnection(event => events.push(event));
        let socket: session.Session['socket'] | undefined;
        try {
            socket = await connections.attach('external-background', 55001, 'external-host', {
                attachmentId: 'attachment-01', autoActivate: false,
            });
            assert.ok(socket);
            const reference = await waitForValue(() => session.getSessionReference('external-background'));
            assert.strictEqual(session.activeSession, undefined);
            assert.strictEqual(reference.sessionId, 'external-background');
            assert.strictEqual(reference.attachmentId, 'attachment-01');
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].kind, 'connected');
            assert.deepStrictEqual(events[0].session, reference);
            assert.strictEqual(await session.activateSessionById('external-background', {
                connectionId: reference.connectionId, select: false,
            }), true);
            assert.strictEqual(session.activeSession, undefined);
        } finally {
            subscription.dispose();
            await session.cleanupSession('external-background', socket);
        }
    });

    test('autoActivate false skips pending PID discovery and select:false binds executable ownership only', async () => {
        const sendText = sandbox.stub();
        const pendingTerminal = {
            processId: new Promise<number>(() => undefined), sendText, show: sandbox.stub(),
        } as unknown as vscode.Terminal;
        terminals.value([pendingTerminal]);
        const socket = await connections.attach('external-pending-pid', 55009, os.hostname(), {
            attachmentId: 'pending-pid', autoActivate: false,
        });
        const reference = await waitForValue(() => session.getSessionReference('external-pending-pid'));
        assert.strictEqual(session.activeSession, undefined);
        assert.strictEqual(await session.activateSessionById('external-pending-pid'), true);
        const attachedOwner = session.activeSession;
        assert.ok(attachedOwner);
        const otherOwner = session.registerSessionTransport('temporary-selected-owner', 'host', '/tmp', () => Promise.resolve(undefined));
        assert.strictEqual(await session.activateSessionById(otherOwner.sessionId), true);
        session.unregisterSessionTransport(otherOwner);
        assert.strictEqual(session.activeSession, undefined);
        assert.strictEqual(await session.activateSessionById('external-pending-pid', {
            connectionId: reference.connectionId, terminal: pendingTerminal, select: false,
        }), true);
        assert.strictEqual(session.activeSession, undefined, 'select:false must not change the logical selection');
        await session.executeSessionCode(attachedOwner, 'View(iris)');
        assert.strictEqual(sendText.calledOnce, true);
        assert.ok(String(sendText.firstCall.args[0]).includes('View(iris)'));

        const nativeTerminal = { processId: Promise.resolve(55010), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([nativeTerminal]);
        const nativeSocket = await connections.attach('native-selected', 55010, os.hostname());
        const nativeOwner = await waitForValue(() => session.activeSession?.sessionId === 'native-selected' ? session.activeSession : undefined);
        assert.strictEqual(session.activeSession, nativeOwner);
        await connections.attach('background-over-native', 55011, os.hostname(), { autoActivate: false, attachmentId: 'bg-native' });
        assert.strictEqual(session.activeSession, nativeOwner);

        const explicitTerminal = { processId: Promise.resolve(undefined), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([explicitTerminal]);
        const explicitOwnerSocket = await connections.attach('explicit-selected', 55012, 'external-host');
        const explicitOwner = session.activeSession;
        assert.ok(explicitOwner);
        assert.strictEqual(await session.activateSessionById('explicit-selected', { terminal: explicitTerminal }), true);
        await connections.attach('background-over-explicit', 55013, os.hostname(), { autoActivate: false, attachmentId: 'bg-explicit' });
        assert.strictEqual(session.activeSession, explicitOwner);
        assert.notStrictEqual(socket, nativeSocket);
        assert.ok(explicitOwnerSocket.destroyed === false);
        assert.strictEqual(vscode.window.activeTerminal, undefined);
    });

    test('foreground external attach selects itself and selected logical replacement follows reconnect', async () => {
        const first = await connections.attach('external-foreground', 55005, 'external-host', {
            attachmentId: 'foreground-1', autoActivate: true,
        });
        const oldReference = await waitForValue(() => session.getSessionReference('external-foreground'));
        assert.strictEqual(session.activeSession?.socket, first);

        const replacement = await connections.attach('external-foreground', 55006, 'external-host', {
            attachmentId: 'foreground-2', autoActivate: false,
        });
        const newReference = await waitForValue(() => {
            const reference = session.getSessionReference('external-foreground');
            return reference?.connectionId !== oldReference.connectionId ? reference : undefined;
        });
        assert.strictEqual(session.activeSession?.socket, replacement);
        assert.notStrictEqual(newReference.connectionId, oldReference.connectionId);
    });

    test('attach UI effects preserve native behavior but ignore background and superseded choices', async () => {
        const showHttpgdPlot = sandbox.stub().resolves();
        sandbox.stub(extension, 'globalPlotManager').value({ showHttpgdPlot } as unknown as typeof extension.globalPlotManager);
        const explicitTerminal = { processId: Promise.resolve(undefined), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        const nativeTerminal = { processId: Promise.resolve(55031), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([explicitTerminal, nativeTerminal]);
        const first = await connections.attach('plot-selected-explicit', 55030, 'external-host');
        const selected = session.activeSession;
        assert.ok(selected);
        assert.strictEqual(await session.activateSessionById('plot-selected-explicit', { terminal: explicitTerminal }), true);
        activeTerminal.value(explicitTerminal);

        await connections.attach('plot-native-background', 55031, os.hostname(), { plotUrl: 'http://127.0.0.1:55031' });
        await waitForValue(() => showHttpgdPlot.calledOnce ? true : undefined);
        assert.deepStrictEqual(showHttpgdPlot.firstCall.args, ['http://127.0.0.1:55031']);
        assert.strictEqual(session.activeSession, selected, 'native attach preserves the explicit terminal selection');

        await connections.attach('plot-external-background', 55032, 'external-host', {
            attachmentId: 'plot-background', autoActivate: false, plotUrl: 'http://127.0.0.1:55032',
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.strictEqual(showHttpgdPlot.calledOnce, true, 'autoActivate:false background attach must not open its plot');

        const listenerTarget = session.registerSessionTransport('plot-listener-target', 'listener', '/tmp', () => Promise.resolve(undefined));
        const subscription = session.onDidChangeSessionConnection(change => {
            if (change.kind === 'connected' && change.session.sessionId === 'plot-listener-background') {
                void session.activateSessionById(listenerTarget.sessionId);
            }
        });
        try {
            await connections.attach('plot-listener-background', 55033, 'external-host', {
                attachmentId: 'plot-listener', autoActivate: true, plotUrl: 'http://127.0.0.1:55033',
            });
            await waitForValue(() => session.activeSession === listenerTarget ? true : undefined);
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(showHttpgdPlot.calledOnce, true, 'a listener selection must cancel stale attach plot effects');
        } finally {
            subscription.dispose();
            session.unregisterSessionTransport(listenerTarget);
            await session.cleanupSession('plot-selected-explicit', first);
        }
    });

    test('a replaced socket cannot publish its delayed attach plot', async () => {
        const showHttpgdPlot = sandbox.stub().resolves();
        sandbox.stub(extension, 'globalPlotManager').value({ showHttpgdPlot } as unknown as typeof extension.globalPlotManager);
        const activationGate = deferred<unknown>();
        let delayedFirstContext = true;
        executeCommand.callsFake((command: string, ..._args: unknown[]) => {
            if (command === 'setContext' && delayedFirstContext) {
                delayedFirstContext = false;
                return activationGate.promise;
            }
            return Promise.resolve(undefined);
        });
        let oldSocket: session.Session['socket'] | undefined;
        try {
            oldSocket = await connections.startAttach('plot-replaced', 55034, 'external-host', {
                attachmentId: 'plot-old', autoActivate: true, plotUrl: 'http://127.0.0.1:55034',
            });
            const oldReference = await waitForValue(() => session.getSessionReference('plot-replaced'));
            const replacement = await connections.attach('plot-replaced', 55035, 'external-host', {
                attachmentId: 'plot-new', autoActivate: false,
            });
            assert.notStrictEqual(session.getSessionReference('plot-replaced')?.connectionId, oldReference.connectionId);
            activationGate.resolve(undefined);
            await waitForValue(() => !session.activeConnections.has(oldSocket!) ? true : undefined);
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.strictEqual(showHttpgdPlot.called, false, 'the stale socket must not open its plot after replacement');
            assert.strictEqual(session.getSessionReference('plot-replaced')?.attachmentId, 'plot-new');
            await session.cleanupSession('plot-replaced', replacement);
        } finally {
            activationGate.resolve(undefined);
            if (oldSocket) { await session.cleanupSession('plot-replaced', oldSocket); }
        }
    });

    test('only the replacement reference can bind its terminal and old sockets cannot remove it', async () => {
        const events: RSessionConnectionChange[] = [];
        const subscription = session.onDidChangeSessionConnection(event => events.push(event));
        const sendText = sandbox.stub();
        const terminal = { processId: Promise.resolve(undefined), sendText, show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([terminal]);
        let oldSocket: session.Session['socket'] | undefined;
        let newSocket: session.Session['socket'] | undefined;
        try {
            oldSocket = await connections.attach('external-rebind', 55014, 'external-host', {
                attachmentId: 'rebind-old', autoActivate: false,
            });
            const oldReference = await waitForValue(() => session.getSessionReference('external-rebind'));
            assert.strictEqual(await session.activateSessionById('external-rebind'), true);
            const oldOwner = session.activeSession;
            assert.ok(oldOwner);

            newSocket = await connections.startAttach('external-rebind', 55015, 'external-host', {
                attachmentId: 'rebind-new', autoActivate: false,
            });
            await waitForValue(() => newSocket?._sessionId === 'external-rebind' ? true : undefined);
            const newReference = await waitForValue(() => {
                const value = session.getSessionReference('external-rebind');
                return value?.connectionId !== oldReference.connectionId ? value : undefined;
            });
            const newOwner = session.activeSession;
            assert.ok(newOwner);
            assert.strictEqual(newOwner.socket, newSocket);
            assert.strictEqual(await session.activateSessionById('external-rebind', {
                connectionId: oldReference.connectionId, terminal,
            }), false, 'a stale reference must not bind a terminal to its replacement');
            await assert.rejects(session.executeSessionCode(oldOwner, 'View(old)'), /no longer attached/);
            await assert.rejects(session.executeSessionCode(newOwner, 'View(new)'), /no attached terminal/);
            assert.strictEqual(await session.activateSessionById('external-rebind', {
                connectionId: newReference.connectionId, terminal, select: false,
            }), true);
            assert.strictEqual(session.activeSession, newOwner, 'select:false must preserve the current logical selection');
            await session.executeSessionCode(newOwner, 'View(new)');
            assert.strictEqual(sendText.calledOnce, true);
            assert.ok(String(sendText.firstCall.args[0]).includes('View(new)'));

            const connectedCount = events.filter(event => event.kind === 'connected').length;
            connections.repeatAttach('external-rebind');
            const response = await connections.request('external-rebind', 'rstudioapi/get_project_path');
            assert.ok('result' in response || 'error' in response, 'the repeated-handshake client remains connected');
            assert.strictEqual(events.filter(event => event.kind === 'connected').length, connectedCount,
                'a repeated handshake on the same socket is idempotent');
            const replacedSocket = oldSocket;
            assert.ok(replacedSocket);
            replacedSocket.destroy();
            await waitForValue(() => !session.activeConnections.has(replacedSocket) ? true : undefined);
            assert.strictEqual(session.getSessionReference('external-rebind')?.connectionId, newReference.connectionId,
                'closing the old socket must not remove the replacement');
        } finally {
            subscription.dispose();
            if (newSocket) { await session.cleanupSession('external-rebind', newSocket); }
            if (oldSocket) { await session.cleanupSession('external-rebind', oldSocket); }
        }
    });

    test('activation returns false when its awaited terminal or connection becomes stale', async () => {
        const terminal = { processId: Promise.resolve(undefined), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([terminal]);
        await connections.attach('activation-terminal-close', 55016, 'external-host', {
            attachmentId: 'activate-close', autoActivate: false,
        });
        const terminalReference = await waitForValue(() => session.getSessionReference('activation-terminal-close'));
        let releaseTerminalContext!: () => void;
        const terminalContext = deferred<void>();
        releaseTerminalContext = () => terminalContext.resolve(undefined);
        let blockNext = true;
        executeCommand.callsFake((async (command: unknown, key: unknown, value: unknown) => {
            if (blockNext && command === 'setContext' && key === 'rSessionActive' && value === true) {
                blockNext = false;
                return terminalContext.promise;
            }
            return undefined;
        }) as typeof vscode.commands.executeCommand);
        const closingActivation = session.activateSessionById('activation-terminal-close', {
            connectionId: terminalReference.connectionId, terminal,
        });
        await waitForValue(() => !blockNext ? true : undefined);
        session.cleanupTerminalBinding(terminal);
        terminals.value([]);
        releaseTerminalContext();
        assert.strictEqual(await closingActivation, false, 'a terminal closed during UI work invalidates activation');

        const rebindTerminal = { processId: Promise.resolve(undefined), sendText: sandbox.stub(), show: sandbox.stub() } as unknown as vscode.Terminal;
        terminals.value([rebindTerminal]);
        await connections.attach('activation-terminal-old-owner', 55028, 'external-host', {
            attachmentId: 'terminal-owner-old', autoActivate: false,
        });
        await connections.attach('activation-terminal-new-owner', 55029, 'external-host', {
            attachmentId: 'terminal-owner-new', autoActivate: false,
        });
        const oldOwnerReference = await waitForValue(() => session.getSessionReference('activation-terminal-old-owner'));
        const newOwnerReference = await waitForValue(() => session.getSessionReference('activation-terminal-new-owner'));
        const rebindContext = deferred<void>();
        let releaseRebindContext!: () => void;
        releaseRebindContext = () => rebindContext.resolve(undefined);
        blockNext = true;
        executeCommand.callsFake((async (command: unknown, key: unknown, value: unknown) => {
            if (blockNext && command === 'setContext' && key === 'rSessionActive' && value === true) {
                blockNext = false;
                return rebindContext.promise;
            }
            return undefined;
        }) as typeof vscode.commands.executeCommand);
        const rebindActivation = session.activateSessionById('activation-terminal-old-owner', {
            connectionId: oldOwnerReference.connectionId, terminal: rebindTerminal,
        });
        await waitForValue(() => !blockNext ? true : undefined);
        assert.strictEqual(await session.activateSessionById('activation-terminal-new-owner', {
            connectionId: newOwnerReference.connectionId, terminal: rebindTerminal, select: false,
        }), true);
        releaseRebindContext();
        assert.strictEqual(await rebindActivation, false, 'a terminal rebound during UI work invalidates activation');

        await connections.attach('activation-connection-replace', 55017, 'external-host', {
            attachmentId: 'activate-replace-old', autoActivate: false,
        });
        const oldReference = await waitForValue(() => session.getSessionReference('activation-connection-replace'));
        const connectionContext = deferred<void>();
        let releaseConnectionContext!: () => void;
        releaseConnectionContext = () => connectionContext.resolve(undefined);
        blockNext = true;
        executeCommand.callsFake((async (command: unknown, key: unknown, value: unknown) => {
            if (blockNext && command === 'setContext' && key === 'rSessionActive' && value === true) {
                blockNext = false;
                return connectionContext.promise;
            }
            return undefined;
        }) as typeof vscode.commands.executeCommand);
        const replacedActivation = session.activateSessionById('activation-connection-replace', {
            connectionId: oldReference.connectionId,
        });
        await waitForValue(() => !blockNext ? true : undefined);
        await connections.attach('activation-connection-replace', 55018, 'external-host', {
            attachmentId: 'activate-replace-new', autoActivate: false,
        });
        releaseConnectionContext();
        assert.strictEqual(await replacedActivation, false, 'a replaced connection must not report successful activation');
        assert.notStrictEqual(session.getSessionReference('activation-connection-replace')?.connectionId, oldReference.connectionId);
    });

    test('a connection listener can activate another session without later attach work overriding it', async () => {
        await connections.attach('listener-selected-session', 55019, 'external-host', {
            attachmentId: 'listener-owner', autoActivate: false,
        });
        assert.strictEqual(await session.activateSessionById('listener-selected-session'), true);
        const selected = session.activeSession;
        assert.ok(selected);
        const subscription = session.onDidChangeSessionConnection(event => {
            if (event.kind === 'connected' && event.session.sessionId === 'listener-background-attach') {
                void session.activateSessionById('listener-selected-session');
            }
        });
        try {
            await connections.attach('listener-background-attach', 55020, 'external-host', {
                attachmentId: 'listener-background', autoActivate: true,
            });
            assert.strictEqual(session.activeSession, selected,
                'the attach handler must not auto-select again after delivering connection events');
        } finally { subscription.dispose(); }
    });

    test('replacing sess with a Requester revokes the old ref once and moves document routing', async () => {
        const id = 'sess-to-requester';
        const events: RSessionConnectionChange[] = [];
        const subscription = session.onDidChangeSessionConnection(event => events.push(event));
        const socket = await connections.attach(id, 55021, 'external-host', {
            attachmentId: 'sess-before-requester', autoActivate: false,
        });
        const sessReference = await waitForValue(() => session.getSessionReference(id));
        const document = vscode.Uri.file('/tmp/sess-to-requester.R');
        assert.strictEqual(await session.activateSessionById(id), true);
        const oldOwner = session.activeSession;
        assert.ok(oldOwner);
        session.bindSessionDocument(document, oldOwner);
        let requests = 0;
        const requester = session.registerSessionTransport(id, 'interactive-host', '/interactive', () => {
            requests++;
            return Promise.resolve('requester response');
        });
        try {
            assert.notStrictEqual(requester, oldOwner);
            assert.strictEqual(session.getSessionReference(id), undefined);
            assert.strictEqual(session.sessionForDocument(document), requester);
            assert.deepStrictEqual(events.map(event => [event.kind, event.session.connectionId]), [
                ['connected', sessReference.connectionId], ['disconnected', sessReference.connectionId],
            ]);
            assert.strictEqual(await session.sessionRequest({ method: 'test' }, session.sessionForDocument(document)), 'requester response');
            socket.destroy();
            await waitForValue(() => !session.activeConnections.has(socket) ? true : undefined);
            assert.strictEqual(await session.activateSessionById(id), true, 'late sess close must not unregister the requester');
            assert.strictEqual(session.getSessionReference(id), undefined);
            assert.strictEqual(events.length, 2, 'the sess connection is invalidated exactly once');
            assert.strictEqual(requests, 1);
        } finally {
            subscription.dispose();
            session.unregisterSessionTransport(requester);
            await session.cleanupSession(id, socket);
        }
    });

    test('replacement emits committed FIFO history and stale references cannot activate', async () => {
        const events: RSessionConnectionChange[] = [];
        let replacement: session.Session['socket'] | undefined;
        let revokedReplacement = false;
        const subscription = session.onDidChangeSessionConnection(event => {
            events.push(event);
            if (event.kind === 'disconnected' && event.session.sessionId === 'external-replace' && !revokedReplacement) {
                revokedReplacement = true;
                void session.cleanupSession('external-replace');
            }
        });
        let first: session.Session['socket'] | undefined;
        try {
            first = await connections.attach('external-replace', 55002, 'external-host', {
                attachmentId: 'first', autoActivate: false,
            });
            assert.ok(first);
            const oldReference = await waitForValue(() => session.getSessionReference('external-replace'));
            replacement = await connections.startAttach('external-replace', 55003, 'external-host', {
                attachmentId: 'second', autoActivate: false,
            });
            await waitForValue(() => replacement?._sessionId === 'external-replace' ? true : undefined);
            await waitForValue(() => events.length >= 4 ? true : undefined);
            assert.deepStrictEqual(events.map(event => `${event.kind}:${event.session.attachmentId}`), [
                'connected:first', 'disconnected:first', 'connected:second', 'disconnected:second',
            ]);
            assert.strictEqual(await session.activateSessionById('external-replace', {
                connectionId: oldReference.connectionId,
            }), false);
            assert.strictEqual(session.getSessionReference('external-replace'), undefined);
            await session.cleanupSession('external-replace', first);
            assert.strictEqual(session.getSessionReference('external-replace'), undefined);
        } finally {
            subscription.dispose();
            if (replacement) { await session.cleanupSession('external-replace', replacement); }
            if (first) { await session.cleanupSession('external-replace', first); }
        }
    });

    test('malformed attach metadata is rejected before a session reference is published', async () => {
        const showErrorMessage = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const invalidId = await connections.startAttach('external-malformed', 55004, 'external-host', {
            attachmentId: 'invalid space', autoActivate: false,
        });
        await waitForValue(() => invalidId.destroyed ? true : undefined);
        await waitForValue(() => showErrorMessage.calledOnce ? true : undefined);
        assert.match(String(showErrorMessage.firstCall.args[0]), /invalid attachment_id metadata/);
        const missingId = await connections.startAttach('external-missing-id', 55008, 'external-host', {
            autoActivate: false,
        });
        await waitForValue(() => missingId.destroyed ? true : undefined);
        await waitForValue(() => showErrorMessage.calledTwice ? true : undefined);
        assert.match(String(showErrorMessage.secondCall.args[0]), /auto_activate=false requires a valid attachment_id/);
        assert.strictEqual(session.getSessionReference('external-malformed'), undefined);
        assert.strictEqual(session.getSessionReference('external-missing-id'), undefined);
    });

    test('prepared scripts carry their ID and autoActivate value while dispose leaves the connection live', async () => {
        const background = await session.prepareAttachment({ autoActivate: false });
        const foreground = await session.prepareAttachment();
        assert.ok(background);
        assert.ok(foreground);
        try {
            const backgroundScript = await fsp.readFile(background.scriptPath, 'utf8');
            const foregroundScript = await fsp.readFile(foreground.scriptPath, 'utf8');
            assert.ok(backgroundScript.includes(`attachment_id = "${background.attachmentId}"`));
            assert.match(backgroundScript, /auto_activate = FALSE/);
            assert.ok(foregroundScript.includes(`attachment_id = "${foreground.attachmentId}"`));
            assert.match(foregroundScript, /auto_activate = TRUE/);

            await connections.attach('prepared-dispose-live', 55022, 'external-host', {
                attachmentId: background.attachmentId, autoActivate: false,
            });
            const reference = await waitForValue(() => session.getSessionReference('prepared-dispose-live'));
            background.dispose();
            await waitForFileRemoval(background.scriptPath);
            assert.strictEqual(session.getSessionReference('prepared-dispose-live')?.connectionId, reference.connectionId,
                'disposing a preparation only removes its script');
        } finally {
            background.dispose();
            foreground.dispose();
        }
    });

    test('shutdown revokes live references and emits disconnect before awaiting teardown', async () => {
        const events: RSessionConnectionChange[] = [];
        const subscription = session.onDidChangeSessionConnection(event => events.push(event));
        let shutdown: Promise<void> | undefined;
        try {
            await connections.attach('external-shutdown', 55007, 'external-host', {
                attachmentId: 'shutdown', autoActivate: false,
            });
            assert.ok(session.getSessionReference('external-shutdown'));
            shutdown = session.shutdownSessionWatcher();
            assert.strictEqual(session.getSessionReference('external-shutdown'), undefined);
            assert.deepStrictEqual(events.map(event => event.kind), ['connected', 'disconnected']);
            assert.strictEqual(events[1].session.attachmentId, 'shutdown');
        } finally {
            await shutdown;
            subscription.dispose();
        }
    });

    test('shutdown listener can redeploy resources and accept a new attachment without old cleanup reclaiming them', async () => {
        let preparationPromise: Promise<RSessionPreparation | undefined> | undefined;
        let redeployed = false;
        const subscription = session.onDidChangeSessionConnection(event => {
            if (event.kind === 'disconnected' && event.session.sessionId === 'shutdown-redeploy-old' && !redeployed) {
                redeployed = true;
                session.deploySessionWatcher(extensionRoot);
                preparationPromise = session.prepareAttachment({ autoActivate: false });
            }
        });
        let oldShutdown: Promise<void> | undefined;
        let preparation: RSessionPreparation | undefined;
        try {
            await connections.attach('shutdown-redeploy-old', 55023, 'external-host', {
                attachmentId: 'old-lifecycle', autoActivate: false,
            });
            oldShutdown = session.shutdownSessionWatcher();
            await oldShutdown;
            assert.strictEqual(redeployed, true);
            preparation = await preparationPromise;
            assert.ok(preparation);
            assert.ok(await pathExists(preparation.scriptPath), 'old shutdown must not remove a new preparation');
            const socket = await connections.attach('shutdown-redeploy-new', 55024, 'external-host', {
                attachmentId: preparation.attachmentId, autoActivate: false,
            });
            assert.strictEqual(socket.destroyed, false);
            assert.strictEqual(session.getSessionReference('shutdown-redeploy-new')?.attachmentId, preparation.attachmentId);
        } finally {
            subscription.dispose();
            preparation?.dispose();
            await oldShutdown;
            await session.shutdownSessionWatcher();
        }
    });

    test('an old PID discovery cannot commit after shutdown and redeploy, while the new server accepts attaches', async () => {
        const delayedPid = deferred<number>();
        let discoveryStarted = false;
        const terminal = {
            get processId() { discoveryStarted = true; return delayedPid.promise; },
            sendText: sandbox.stub(), show: sandbox.stub(),
        } as unknown as vscode.Terminal;
        terminals.value([terminal]);
        const events: RSessionConnectionChange[] = [];
        const subscription = session.onDidChangeSessionConnection(event => events.push(event));
        let oldShutdown: Promise<void> | undefined;
        try {
            await connections.startAttach('late-discovery-old', 55025, os.hostname());
            await waitForValue(() => discoveryStarted ? true : undefined);
            oldShutdown = session.shutdownSessionWatcher();
            session.deploySessionWatcher(extensionRoot);
            const newEndpoint = await session.getGlobalPipePath();
            delayedPid.resolve(55025);
            await connections.attach('late-discovery-new', 55026, 'external-host', {
                attachmentId: 'new-server', autoActivate: false,
            });
            await oldShutdown;
            assert.ok(newEndpoint);
            assert.ok(events.some(event => event.kind === 'connected' && event.session.sessionId === 'late-discovery-new'));
            assert.ok(!events.some(event => event.kind === 'connected' && event.session.sessionId === 'late-discovery-old'),
                'the old server must reject a discovery result that completed after redeploy');
            assert.ok(session.getSessionReference('late-discovery-new'));
        } finally {
            delayedPid.resolve(55025);
            subscription.dispose();
            await oldShutdown;
            await session.shutdownSessionWatcher();
        }
    });

    test('redeploying a running watcher reuses its live server and still accepts connections', async () => {
        const originalEndpoint = await session.getGlobalPipePath();
        session.deploySessionWatcher(extensionRoot);
        assert.strictEqual(await session.getGlobalPipePath(), originalEndpoint);
        await connections.attach('same-server-redeploy', 55027, 'external-host', {
            attachmentId: 'same-server', autoActivate: false,
        });
        assert.strictEqual(session.getSessionReference('same-server-redeploy')?.attachmentId, 'same-server');
    });
});
