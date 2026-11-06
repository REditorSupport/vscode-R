import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LanguageService } from '../../languageService';
import { connectTcpLanguageServer } from '../../languageServerTransport';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('Language service startup lifecycle', () => {
    let sandbox: sinon.SinonSandbox;
    let appendLine: sinon.SinonStub;
    const prototype = LanguageService.prototype as unknown as {
        createClient: () => Promise<LanguageClient>;
        startMultiLanguageService: () => void;
        spawnServer: (
            client: LanguageClient,
            executable: string,
            args: string[],
            options: { cwd: string },
        ) => util.DisposableProcess;
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        appendLine = sandbox.stub();
        sandbox.stub(vscode.window, 'createOutputChannel').returns({
            appendLine,
        } as unknown as vscode.LogOutputChannel);
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => false,
        } as unknown as vscode.WorkspaceConfiguration);
    });
    teardown(() => sandbox.restore());

    test('an initial startup rejection is logged and does not block disposal', async () => {
        sandbox.stub(prototype, 'createClient').rejects(new Error('R exited before connecting'));
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const service = new LanguageService();
        await service.dispose();
        sinon.assert.calledWithMatch(appendLine, 'Failed to start language server:');
        sinon.assert.notCalled(register);
    });

    test('disposal during startup stops the eventual client without registering listeners', async () => {
        let finish!: (client: LanguageClient) => void;
        sandbox.stub(prototype, 'createClient').returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const stop = sandbox.stub().resolves();
        const service = new LanguageService();
        const disposal = service.dispose();
        finish({ stop } as unknown as LanguageClient);
        await disposal;
        sinon.assert.calledOnce(stop);
        sinon.assert.notCalled(register);
    });

    test('disposal cancels TCP startup while R remains alive without connecting', async () => {
        const disposeChild = sandbox.stub();
        const child = Object.assign(new EventEmitter(), {
            dispose: disposeChild,
        }) as unknown as util.DisposableProcess;
        let started!: () => void;
        const listening = new Promise<void>((resolve) => {
            started = resolve;
        });
        sandbox.stub(prototype, 'createClient').callsFake(function (this: LanguageService) {
            const cancellation = (this as unknown as { startupCancellation: AbortController })
                .startupCancellation;
            return connectTcpLanguageServer(() => {
                started();
                return child;
            }, cancellation.signal).then(() => {
                throw new Error('R never connected');
            });
        });
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const service = new LanguageService();
        await listening;
        await service.dispose();
        sinon.assert.calledOnce(disposeChild);
        sinon.assert.notCalled(register);
    });

    test('a missing package still prompts for installation without stopping a starting client', () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        }) as unknown as util.DisposableProcess;
        sandbox.stub(util, 'spawn').returns(child);
        const install = sandbox.stub(util, 'promptToInstallRPackage').resolves();
        const stop = sandbox.stub().resolves();
        const client = {
            outputChannel: { appendLine, show: sandbox.stub() },
            isRunning: () => false,
            stop,
        } as unknown as LanguageClient;
        prototype.spawnServer(client, 'R', [], { cwd: '/project' });
        child.emit('exit', 10, null);
        sinon.assert.calledOnce(install);
        assert.strictEqual(install.firstCall.args[0], 'languageserver');
        sinon.assert.notCalled(stop);
    });

    test('a rejected stop after R exits is logged', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        }) as unknown as util.DisposableProcess;
        sandbox.stub(util, 'spawn').returns(child);
        const client = {
            outputChannel: { appendLine },
            isRunning: () => true,
            stop: sandbox.stub().rejects(new Error('shutdown failed')),
        } as unknown as LanguageClient;
        prototype.spawnServer(client, 'R', [], { cwd: '/project' });
        child.emit('exit', 0, null);
        await Promise.resolve();
        sinon.assert.calledWithMatch(
            appendLine,
            'Failed to stop language server: Error: shutdown failed',
        );
    });
});

suite('Language service initialization cancellation', () => {
    let sandbox: sinon.SinonSandbox;
    let service: LanguageService | undefined;
    let directory: string;
    let children: childProcess.ChildProcess[];
    let initialized: Set<childProcess.ChildProcess>;
    let shutdowns: Set<childProcess.ChildProcess>;
    let watcherDisposals: sinon.SinonSpy[];

    setup(async () => {
        sandbox = sinon.createSandbox();
        service = undefined;
        children = [];
        initialized = new Set();
        shutdowns = new Set();
        watcherDisposals = [];
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-cancel-initialize-'));
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(util, 'getRpath').resolves(process.execPath);
        const createWatcher = vscode.workspace.createFileSystemWatcher;
        sandbox.stub(vscode.workspace, 'createFileSystemWatcher').callsFake((...args) => {
            const watcher = createWatcher(...args);
            watcherDisposals.push(sandbox.spy(watcher, 'dispose'));
            return watcher;
        });
        sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    });

    teardown(async () => {
        try {
            children.forEach((child) => child.kill('SIGKILL'));
            await service?.dispose();
            await fs.rm(directory, { recursive: true, force: true });
        } finally {
            sandbox.restore();
        }
    });

    async function waitFor(predicate: () => boolean): Promise<void> {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
            assert.ok(
                Date.now() < deadline,
                'The real client must send initialize before disposal',
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    function configure(stdio: boolean, multiServer: boolean, reply = false): void {
        const getConfiguration = vscode.workspace.getConfiguration;
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section, scope) => {
            const original = getConfiguration(section, scope);
            if (section !== 'r') {
                return original;
            }
            return {
                ...original,
                get: (key: string, fallback?: unknown) => {
                    if (key === 'lsp.use_stdio') {
                        return stdio;
                    }
                    if (key === 'lsp.multiServer') {
                        return multiServer;
                    }
                    if (key === 'lsp.args') {
                        return [];
                    }
                    return original.get(key, fallback);
                },
            } as vscode.WorkspaceConfiguration;
        });
        // Use the real child process, TCP/stdio streams, and LanguageClient.
        // The stand-in can read initialize without answering it.
        const script = `
            const net = require('node:net');
            const input = ${stdio ? 'process.stdin' : "net.connect(Number(process.env.VSCR_LSP_PORT), '127.0.0.1')"};
            const output = ${stdio ? 'process.stdout' : 'input'};
            let bytes = Buffer.alloc(0);
            input.on('data', chunk => {
                bytes = Buffer.concat([bytes, chunk]);
                while (true) {
                    const boundary = bytes.indexOf('\\r\\n\\r\\n');
                    if (boundary < 0) return;
                    const length = Number(/Content-Length: (\\d+)/i.exec(bytes.subarray(0, boundary).toString())[1]);
                    const end = boundary + 4 + length;
                    if (bytes.length < end) return;
                    const message = JSON.parse(bytes.subarray(boundary + 4, end).toString());
                    bytes = bytes.subarray(end);
                    if (message.method === 'initialize') process.stderr.write('initialize received\\n');
                    if (message.method === 'shutdown') process.stderr.write('shutdown received\\n');
                    if (${reply} && message.id !== undefined) {
                        const response = JSON.stringify({jsonrpc:'2.0', id:message.id, result:message.method === 'initialize' ? {capabilities:{}} : null});
                        output.write('Content-Length: ' + Buffer.byteLength(response) + '\\r\\n\\r\\n' + response);
                    }
                    if (${reply} && message.method === 'exit') process.exit(0);
                }
            });
            input.on('error', () => {});
            setInterval(() => {}, 1000);
        `;
        const spawn = childProcess.spawn;
        sandbox.stub(childProcess, 'spawn').callsFake(((
            command: string,
            argsOrOptions?: readonly string[] | childProcess.SpawnOptions,
            options?: childProcess.SpawnOptions,
        ): childProcess.ChildProcess => {
            const args = Array.isArray(argsOrOptions) ? (argsOrOptions as readonly string[]) : [];
            const spawnOptions = Array.isArray(argsOrOptions)
                ? (options ?? {})
                : ((argsOrOptions as childProcess.SpawnOptions | undefined) ?? {});
            const child =
                command === process.execPath &&
                Array.isArray(args) &&
                args.includes(path.resolve(__dirname, '../../..', 'R/languageServer.R'))
                    ? spawn(command, ['-e', script], {
                          ...spawnOptions,
                          // The extension host executable can be Electron on
                          // every platform; these stand-ins need its Node mode.
                          env: {
                              ...process.env,
                              ...spawnOptions.env,
                              ELECTRON_RUN_AS_NODE: '1',
                          },
                      })
                    : spawn(command, args, spawnOptions);
            if (command === process.execPath) {
                children.push(child);
                let stderr = '';
                child.stderr?.on('data', (chunk: Buffer) => {
                    stderr += chunk.toString();
                    if (stderr.includes('initialize received')) {
                        initialized.add(child);
                    }
                    if (stderr.includes('shutdown received')) {
                        shutdowns.add(child);
                    }
                });
            }
            return child;
        }) as typeof childProcess.spawn);
    }

    for (const stdio of [false, true]) {
        test(`disposal terminates ${stdio ? 'stdio' : 'connected TCP'} initialization which never replies`, async function () {
            if (stdio && process.platform === 'win32') {
                this.skip();
            }
            configure(stdio, false);
            service = new LanguageService();
            await waitFor(() => initialized.size === 1);
            assert.strictEqual(children.length, 1, 'Observing startup must not spawn R twice');
            const exits = children.map(
                (child) => new Promise<void>((resolve) => child.once('close', () => resolve())),
            );
            let deadline: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    service.dispose(),
                    new Promise<never>((_resolve, reject) => {
                        deadline = setTimeout(
                            () => reject(new Error('Disposal waited for an unanswered initialize')),
                            3000,
                        );
                    }),
                ]);
                await Promise.all(exits);
            } finally {
                clearTimeout(deadline);
            }
            const state = service as unknown as {
                clients: Map<string, unknown>;
                startingClients: Set<unknown>;
                clientUpdates: Map<string, unknown>;
            };
            assert.strictEqual(state.clients.size, 0);
            assert.strictEqual(state.startingClients.size, 0);
            assert.strictEqual(state.clientUpdates.size, 0);
            assert.ok(watcherDisposals.length > 0);
            watcherDisposals.forEach((dispose) => sinon.assert.calledOnce(dispose));
        });

        test(`successful ${stdio ? 'stdio' : 'TCP'} startup can restart and shut down normally`, async function () {
            if (stdio && process.platform === 'win32') {
                this.skip();
            }
            configure(stdio, false, true);
            service = new LanguageService();
            const state = service as unknown as {
                clients: Map<string, LanguageClient>;
                startingClients: Set<unknown>;
            };
            await waitFor(() => state.clients.get('global')?.isRunning() === true);
            const client = state.clients.get('global')!;
            const first = children[0];
            assert.strictEqual(children.length, 1);
            const firstExit = new Promise<void>((resolve) => first.once('close', () => resolve()));
            await client.stop();
            await firstExit;
            assert.ok(
                shutdowns.has(first),
                'Running clients must send shutdown before transport cleanup',
            );
            await client.start();
            assert.strictEqual(client.isRunning(), true);
            assert.strictEqual(children.length, 2);
            const next = children[1];
            const nextExit = new Promise<void>((resolve) => next.once('close', () => resolve()));
            await service.dispose();
            await nextExit;
            assert.ok(shutdowns.has(next));
            assert.strictEqual(state.startingClients.size, 0);
        });
    }

    test('disposal cancels every pending multi-server initialization before awaiting updates', async () => {
        configure(false, true);
        const documents: vscode.TextDocument[] = [];
        for (const name of ['first.R', 'second.R']) {
            const file = path.join(directory, name);
            await fs.writeFile(file, 'x <- 1');
            documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
        }
        sandbox.stub(vscode.workspace, 'textDocuments').value(documents);
        service = new LanguageService();
        await waitFor(() => initialized.size === 2);
        const exits = children.map(
            (child) => new Promise<void>((resolve) => child.once('close', () => resolve())),
        );
        let deadline: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                service.dispose(),
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(
                        () =>
                            reject(
                                new Error('Pending multi-server initialization blocked disposal'),
                            ),
                        3000,
                    );
                }),
            ]);
            await Promise.all(exits);
        } finally {
            clearTimeout(deadline);
        }
        const state = service as unknown as {
            clients: Map<string, unknown>;
            startingClients: Set<unknown>;
            clientUpdates: Map<string, unknown>;
        };
        assert.strictEqual(state.clients.size, 0);
        assert.strictEqual(state.startingClients.size, 0);
        assert.strictEqual(state.clientUpdates.size, 0);
        assert.strictEqual(children.length, 2);
        watcherDisposals.forEach((dispose) => sinon.assert.calledOnce(dispose));
    });
});
