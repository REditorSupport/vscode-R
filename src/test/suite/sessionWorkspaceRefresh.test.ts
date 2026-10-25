import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import * as session from '../../session';
import * as util from '../../util';
import { SessConsentService } from '../../sessConsent';
import { mockExtensionContext } from '../common/mockvscode';
import { SessionConnections, waitForValue } from '../common/sessionConnections';

suite('Session workspace refresh demand', () => {
    let sandbox: sinon.SinonSandbox;
    let connections: SessionConnections;
    let foreground: session.Session;
    const extensionRoot = path.join(__dirname, '..', '..', '..');

    setup(async () => {
        await session.shutdownSessionWatcher();
        sandbox = sinon.createSandbox();
        connections = new SessionConnections();
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        sandbox.stub(extension, 'rWorkspace').value(undefined);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox.stub(vscode.window, 'terminals').value([]);
        sandbox.stub(vscode.window, 'activeTerminal').value(undefined);
        sandbox
            .stub(util, 'config')
            .returns({ get: () => undefined } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(SessConsentService.prototype, 'start').resolves();
        sandbox.stub(SessConsentService.prototype, 'stop').resolves();
        session.deploySessionWatcher(extensionRoot);
        await session.getGlobalPipePath();
    });

    teardown(async () => {
        if (foreground) {
            session.unregisterSessionTransport(foreground);
        }
        await connections.dispose();
        await session.shutdownSessionWatcher();
        sandbox.restore();
    });

    test('background invalidation refreshes a bound document without changing selection', async () => {
        const socket = await connections.attach('workspace-background', 55101, 'external-host', {
            autoActivate: false,
            attachmentId: 'workspace-background-fixture',
        });
        await session.activateSessionById('workspace-background');
        const background = session.activeSession!;
        foreground = session.registerSessionTransport('workspace-foreground', 'host', '/tmp', () =>
            Promise.resolve({ globalenv: {}, search: [], loaded_namespaces: [] }),
        );
        await session.activateSession(foreground);
        const requests: { id: number; params: { revision?: number } }[] = [];
        sandbox.stub(socket, 'write').callsFake((data: string | Uint8Array) => {
            const message = JSON.parse(data.toString()) as {
                method?: string;
                id: number;
                params: { revision?: number };
            };
            if (message.method === 'workspace') {
                requests.push(message);
            }
            return true;
        });
        const receive = (message: unknown) =>
            socket.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
        receive({ jsonrpc: '2.0', method: 'workspace_updated' });
        assert.strictEqual(requests.length, 0);
        const uri = vscode.Uri.parse('untitled:workspace-background.R');
        try {
            session.bindSessionDocument(uri, background);
            const request = await waitForValue(() => requests[0]);
            receive({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    revision: 1,
                    globalenv: {
                        latest: {
                            class: 'integer',
                            type: 'integer',
                            length: 1,
                            str: 'integer, length 1',
                        },
                    },
                    search: [],
                    loaded_namespaces: [],
                },
            });
            await session.ensureSessionWorkspace(background);
            assert.ok(background.workspaceData.globalenv.latest);
            assert.strictEqual(session.activeSession, foreground);
            receive({ jsonrpc: '2.0', method: 'workspace_updated' });
            assert.strictEqual(requests.length, 1);
            const refresh = session.ensureSessionWorkspace(background);
            const next = await waitForValue(() => requests[1]);
            assert.strictEqual(next.params.revision, 1);
            receive({ jsonrpc: '2.0', id: next.id, result: { revision: 1, unchanged: true } });
            await refresh;
            assert.ok(background.workspaceData.globalenv.latest);
            assert.strictEqual(session.activeSession, foreground);
        } finally {
            session.unbindSessionDocument(uri);
        }
    });
});
