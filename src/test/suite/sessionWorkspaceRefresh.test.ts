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
    let workspace: sinon.SinonStub;
    const extensionRoot = path.join(__dirname, '..', '..', '..');

    setup(async () => {
        await session.shutdownSessionWatcher();
        sandbox = sinon.createSandbox();
        connections = new SessionConnections();
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(extension, 'enableSessionWatcher').value(true);
        workspace = sandbox.stub(extension, 'rWorkspace').value(undefined);
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

    test('native unchanged replies invalidate child values once after a notification burst', async () => {
        const socket = await connections.attach(
            'workspace-native-unchanged',
            55102,
            'external-host',
            {
                autoActivate: false,
                attachmentId: 'workspace-native-unchanged-fixture',
            },
        );
        await session.activateSessionById('workspace-native-unchanged');
        session.deferWorkspaceRefresh();
        const target = session.activeSession!;
        target.workspaceData = { revision: 1, globalenv: {}, search: [], loaded_namespaces: [] };
        const metadata = target.workspaceData;
        const invalidateChildren = sandbox.spy();
        const refresh = sandbox.spy();
        workspace.value({ invalidateChildren, refresh });
        let requests = 0;
        sandbox.stub(socket, 'write').callsFake((data: string | Uint8Array) => {
            const message = JSON.parse(data.toString()) as { id: number; method?: string };
            if (message.method === 'workspace') {
                requests++;
                socket.emit(
                    'data',
                    Buffer.from(
                        `${JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: { revision: 1, unchanged: true },
                        })}\n`,
                    ),
                );
            }
            return true;
        });
        for (let i = 0; i < 20; i++) {
            socket.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"workspace_updated"}\n'));
        }
        await session.ensureSessionWorkspace(target);
        assert.strictEqual(requests, 1);
        sinon.assert.calledOnceWithExactly(invalidateChildren, target);
        sinon.assert.notCalled(refresh);
        assert.strictEqual(target.workspaceData, metadata);
    });

    test('native workspace access retries a failed request without a new invalidation', async () => {
        const socket = await connections.attach('workspace-retry-demand', 55103, 'external-host', {
            autoActivate: false,
            attachmentId: 'workspace-retry-demand-fixture',
        });
        await session.activateSessionById('workspace-retry-demand');
        session.deferWorkspaceRefresh();
        const target = session.activeSession!;
        const previous: session.WorkspaceData = {
            revision: 1,
            globalenv: {},
            search: [],
            loaded_namespaces: [],
        };
        target.workspaceData = previous;
        let requests = 0;
        sandbox.stub(socket, 'write').callsFake((data: string | Uint8Array) => {
            const request = JSON.parse(data.toString()) as { method?: string; id: number };
            if (request.method === 'workspace') {
                requests++;
                const response =
                    requests === 1
                        ? { error: { code: -32603, message: 'Transient inspection failure' } }
                        : {
                              result: {
                                  revision: 2,
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
                          };
                socket.emit(
                    'data',
                    Buffer.from(
                        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`,
                    ),
                );
            }
            return true;
        });
        await session.ensureSessionWorkspace(target);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(requests, 1, 'A failed read must not trigger automatic retries');
        assert.strictEqual(target.workspaceData, previous);
        await session.ensureSessionWorkspace(target);
        assert.strictEqual(requests, 2);
        assert.ok(target.workspaceData.globalenv.latest);
        assert.strictEqual(session.activeSession, target);
        await session.ensureSessionWorkspace(target);
        assert.strictEqual(requests, 2, 'Successful metadata stays cached until invalidated');
    });
});
