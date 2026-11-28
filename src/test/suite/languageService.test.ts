import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    createMessageConnection,
    State,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-languageclient/node';
import type { LanguageClient } from 'vscode-languageclient/node';
import childProcess from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LanguageService } from '../../languageService';
import { connectTcpLanguageServer } from '../../languageServerTransport';
import { CancellableLanguageClient } from '../../languageServerClient';
import * as util from '../../util';
import {
    bindSessionDocument,
    updateSessionLanguageEnvironment,
    registerSessionTransport,
    replaceSessionTransport,
    unregisterSessionTransport,
} from '../../session';
import { mockExtensionContext } from '../common/mockvscode';

suite('Language service startup lifecycle', () => {
    let sandbox: sinon.SinonSandbox;
    let appendLine: sinon.SinonStub;
    const prototype = LanguageService.prototype as unknown as {
        createClient: () => Promise<LanguageClient>;
        startMultiLanguageService: (virtualOnly?: boolean) => void;
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
        sinon.assert.calledOnceWithExactly(register, true);
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
        sinon.assert.calledOnceWithExactly(register, true);
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
        sinon.assert.calledOnceWithExactly(register, true);
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

    test('closing an input while its server starts stops the server once it is registered', async () => {
        const opened: ((document: vscode.TextDocument) => unknown)[] = [];
        const closed: ((document: vscode.TextDocument) => unknown)[] = [];
        const listen =
            (listeners: ((document: vscode.TextDocument) => unknown)[]) =>
            (listener: (document: vscode.TextDocument) => unknown) => {
                listeners.push(listener);
                return { dispose: () => {} };
            };
        sandbox.stub(vscode.workspace, 'onDidOpenTextDocument').callsFake(listen(opened));
        sandbox.stub(vscode.workspace, 'onDidCloseTextDocument').callsFake(listen(closed));
        sandbox.stub(vscode.workspace, 'textDocuments').value([]);
        const globalStop = sandbox.stub().resolves();
        const inputStop = sandbox.stub().resolves();
        let finish!: (client: LanguageClient) => void;
        const createClient = sandbox.stub(prototype, 'createClient');
        createClient.onFirstCall().resolves({ stop: globalStop } as unknown as LanguageClient);
        createClient.onSecondCall().returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const service = new LanguageService();
        const state = service as unknown as {
            clients: Map<string, LanguageClient>;
            clientUpdates: Map<string, Promise<void>>;
        };
        const until = async (predicate: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!predicate()) {
                assert.ok(Date.now() < deadline, 'Timed out waiting for the language service');
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };
        await until(() => opened.length === 1 && closed.length === 1);
        const input = {
            // A space makes the encoded and unencoded forms of the URI differ.
            uri: vscode.Uri.parse('vscode-interactive-input:/Interactive%20Input-1'),
            languageId: 'r',
            isClosed: false,
        } as unknown as vscode.TextDocument;
        let finished = false;
        try {
            opened[0](input);
            await until(() => createClient.calledTwice);
            (input as { isClosed: boolean }).isClosed = true;
            closed[0](input);
            finish({ stop: inputStop } as unknown as LanguageClient);
            finished = true;
            await until(() => state.clientUpdates.size === 0);
            sinon.assert.calledOnce(inputStop);
            assert.deepStrictEqual([...state.clients.keys()], ['global']);
        } finally {
            if (!finished) {
                finish?.({ stop: inputStop } as unknown as LanguageClient);
            }
            await service.dispose();
        }
        sinon.assert.calledOnce(globalStop);
        sinon.assert.calledOnce(inputStop);
    });

    test('changing the language of a file outside the workspace stops its server', async () => {
        const opened: ((document: vscode.TextDocument) => unknown)[] = [];
        const closed: ((document: vscode.TextDocument) => unknown)[] = [];
        const listen =
            (listeners: ((document: vscode.TextDocument) => unknown)[]) =>
            (listener: (document: vscode.TextDocument) => unknown) => {
                listeners.push(listener);
                return { dispose: () => {} };
            };
        sandbox.stub(vscode.workspace, 'onDidOpenTextDocument').callsFake(listen(opened));
        sandbox.stub(vscode.workspace, 'onDidCloseTextDocument').callsFake(listen(closed));
        let documents: vscode.TextDocument[] = [];
        sandbox.stub(vscode.workspace, 'textDocuments').get(() => documents);
        // Start one server per file outside the workspace.
        (vscode.workspace.getConfiguration as sinon.SinonStub).returns({
            get: (key: string) => key === 'lsp.multiServer',
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);
        const stop = sandbox.stub().resolves();
        sandbox
            .stub(prototype, 'createClient')
            .resolves({ stop, needsStop: () => false } as unknown as LanguageClient);
        const service = new LanguageService();
        const state = service as unknown as {
            clients: Map<string, LanguageClient>;
            clientUpdates: Map<string, Promise<void>>;
        };
        const until = async (predicate: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!predicate()) {
                assert.ok(Date.now() < deadline, 'Timed out waiting for the language service');
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };
        try {
            await until(() => opened.length === 1 && closed.length === 1);
            const uri = vscode.Uri.file(path.join(os.tmpdir(), 'outside-workspace.R'));
            const r = { uri, languageId: 'r', isClosed: false } as unknown as vscode.TextDocument;
            documents = [r];
            opened[0](r);
            await until(() => state.clients.size === 1 && state.clientUpdates.size === 0);
            // VS Code closes the document and opens it again in the new language.
            const text = {
                uri,
                languageId: 'plaintext',
                isClosed: false,
            } as unknown as vscode.TextDocument;
            documents = [text];
            closed[0](r);
            opened[0](text);
            await until(() => state.clientUpdates.size === 0);
            sinon.assert.calledOnce(stop);
            assert.strictEqual(state.clients.size, 0);
        } finally {
            await service.dispose();
        }
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

suite('Language service for bound Interactive documents', () => {
    test('keeps an ordinary bound source in its own workspace with multiServer enabled', async () => {
        const sandbox = sinon.createSandbox();
        const a = vscode.Uri.file(path.join(os.tmpdir(), 'workspace-a'));
        const b = vscode.Uri.file(path.join(os.tmpdir(), 'workspace-b'));
        const source = {
            uri: vscode.Uri.joinPath(a, 'helper.R'),
            languageId: 'r',
            isClosed: false,
        } as vscode.TextDocument;
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string) => key === 'lsp.multiServer',
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'textDocuments').get(() => [source]);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake((uri) => {
            const root = uri.fsPath.startsWith(a.fsPath) ? a : b;
            return { uri: root, name: path.basename(root.fsPath), index: 0 };
        });
        const target = registerSessionTransport(
            'cross-folder-run',
            'host',
            b.fsPath,
            () => Promise.resolve({}),
            'webr',
        );
        bindSessionDocument(source.uri, target);
        const start = sandbox
            .stub(
                LanguageService.prototype as unknown as {
                    createClient: (
                        selector: unknown[],
                        cwd: string,
                        folder: vscode.WorkspaceFolder,
                    ) => Promise<LanguageClient>;
                },
                'createClient',
            )
            .resolves({ stop: () => Promise.resolve() } as LanguageClient);
        const service = new LanguageService();
        try {
            const state = service as unknown as {
                startup: Promise<void>;
                clientUpdates: Map<string, Promise<void>>;
            };
            await state.startup;
            await Promise.all(state.clientUpdates.values());
            sinon.assert.calledOnce(start);
            assert.strictEqual(start.firstCall.args[1], a.fsPath);
            assert.strictEqual(start.firstCall.args[2].uri.toString(), a.toString());
        } finally {
            await service.dispose();
            unregisterSessionTransport(target);
            sandbox.restore();
        }
    });

    test('starts a bound webR input even when the ordinary native source client cannot start', async () => {
        const sandbox = sinon.createSandbox();
        const input = {
            uri: vscode.Uri.parse('vscode-interactive-input:/session-only'),
            languageId: 'r',
            isClosed: false,
        } as vscode.TextDocument;
        const config = vscode.workspace.getConfiguration;
        sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((...args) => {
            const settings = config(...args);
            return args[0] !== 'r'
                ? settings
                : ({
                      ...settings,
                      get: (key: string, fallback?: unknown) =>
                          key === 'lsp.runtime'
                              ? 'native'
                              : key === 'lsp.multiServer'
                                ? false
                                : settings.get(key, fallback),
                  } as vscode.WorkspaceConfiguration);
        });
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(vscode.workspace, 'textDocuments').get(() => [input]);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);
        sandbox.stub(util, 'getRpath').resolves(undefined);
        sandbox.stub(CancellableLanguageClient.prototype, 'start').resolves();
        sandbox.stub(CancellableLanguageClient.prototype, 'stop').resolves();
        const target = registerSessionTransport(
            'wasm-only',
            'host',
            os.tmpdir(),
            () => Promise.resolve({}),
            'webr',
        );
        bindSessionDocument(input.uri, target);
        const service = new LanguageService();
        try {
            const state = service as unknown as {
                startup: Promise<void>;
                clientUpdates: Map<string, Promise<void>>;
                clients: Map<string, LanguageClient>;
            };
            await state.startup;
            await Promise.all(state.clientUpdates.values());
            assert.strictEqual(state.clients.has('global'), false);
            assert.strictEqual(
                state.clients.get(input.uri.toString(true))?.name,
                'R Language Server (webR)',
            );
        } finally {
            await service.dispose();
            unregisterSessionTransport(target);
            sandbox.restore();
        }
    });

    for (const policy of ['auto', 'native', 'webR']) {
        test(`uses the session runtime for Interactive and the configured runtime for ordinary sources (${policy})`, async () => {
            const sandbox = sinon.createSandbox();
            const tester = (scheme: string, path: string, fragment?: string) =>
                ({
                    uri: vscode.Uri.from({ scheme, path, fragment }),
                    isClosed: false,
                    languageId: 'r',
                }) as vscode.TextDocument;
            const source = tester('file', '/test/script.R');
            const notebook = tester('vscode-notebook-cell', '/test/Interactive.rnb', 'cell1');
            const prompt = tester('vscode-interactive-input', '/test/Interactive.input');
            const nativePrompt = tester('vscode-interactive-input', '/test/Other.input');
            const docs = [source, notebook, prompt, nativePrompt];
            const opened = new vscode.EventEmitter<vscode.TextDocument>();
            sandbox.stub(vscode.workspace, 'onDidOpenTextDocument').callsFake(opened.event);
            const getConfiguration = vscode.workspace.getConfiguration;
            sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((...args) => {
                const config = getConfiguration(...args);
                return args[0] === 'r'
                    ? ({
                          ...config,
                          get: (key: string, fallback?: unknown) => {
                              if (key === 'lsp.runtime') {
                                  return policy;
                              }
                              if (key === 'lsp.multiServer') {
                                  return false;
                              }
                              return config.get(key, fallback);
                          },
                      } as vscode.WorkspaceConfiguration)
                    : config;
            });
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            sandbox.stub(vscode.workspace, 'textDocuments').get(() => docs);
            sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns({
                dispose() {},
            } as vscode.FileSystemWatcher);
            sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns(undefined);
            const findR = sandbox.stub(util, 'getRpath').resolves(process.execPath);
            // Only transport startup is stubbed: createClient must select the real
            // client type/providers using the same document events as an editor.
            const start = sandbox.stub(CancellableLanguageClient.prototype, 'start').resolves();
            sandbox.stub(CancellableLanguageClient.prototype, 'needsStop').returns(true);
            sandbox.stub(CancellableLanguageClient.prototype, 'stop').resolves();
            const session = (id: string, provider: 'webr' | 'arf') =>
                registerSessionTransport(
                    id,
                    'host',
                    path.join(os.tmpdir(), id),
                    () => Promise.resolve({}),
                    provider,
                );
            const wasm = session('lsp-test-webr', 'webr');
            const native = session('lsp-test-arf', 'arf');
            updateSessionLanguageEnvironment(native, process.execPath, [
                path.join(os.tmpdir(), 'first-library'),
            ]);
            const languageService = new LanguageService();
            const state = languageService as unknown as {
                startup: Promise<void>;
                clients: Map<string, LanguageClient>;
                clientUpdates: Map<string, Promise<void>>;
            };
            const settle = async () => {
                await state.startup;
                while (state.clientUpdates.size) {
                    await Promise.all(state.clientUpdates.values());
                }
            };
            const check = (usesWasm: boolean) => {
                const expected = usesWasm ? 'R Language Server (webR)' : 'R Language Server';
                assert.strictEqual(
                    state.clients.get(`vscode-notebook:${notebook.uri.fsPath}`)?.name,
                    expected,
                );
                assert.strictEqual(state.clients.get(prompt.uri.toString(true))?.name, expected);
            };
            try {
                await settle();
                const project = state.clients.get('global');
                check(policy === 'webR');
                const unboundPrompt = state.clients.get(prompt.uri.toString(true));
                // Queue ordinary open updates before the editor reports its binding.
                // Both updates run after the owner changes and reuse an existing client.
                opened.fire(notebook);
                opened.fire(prompt);
                bindSessionDocument(source.uri, wasm);
                bindSessionDocument(notebook.uri.with({ fragment: '' }), wasm);
                bindSessionDocument(prompt.uri, wasm);
                bindSessionDocument(nativePrompt.uri, native);
                await settle();
                check(true);
                const nativeKey = nativePrompt.uri.toString(true);
                const nativeClient = state.clients.get(nativeKey);
                assert.strictEqual(nativeClient?.name, 'R Language Server');
                assert.strictEqual(
                    nativeClient.clientOptions.workspaceFolder?.uri.fsPath,
                    vscode.Uri.file(native.workingDir).fsPath,
                );
                assert.strictEqual(
                    state.clients.get(prompt.uri.toString(true))?.clientOptions.workspaceFolder?.uri
                        .fsPath,
                    vscode.Uri.file(wasm.workingDir).fsPath,
                );
                assert.notStrictEqual(state.clients.get(prompt.uri.toString(true)), unboundPrompt);
                assert.strictEqual(state.clients.get('global'), project);
                const count = start.callCount;
                bindSessionDocument(notebook.uri, wasm);
                await settle();
                assert.strictEqual(
                    start.callCount,
                    count,
                    'Adding another binding to the same notebook restarted its client',
                );
                replaceSessionTransport(wasm, native);
                await settle();
                check(false);
                const nativeKeyAfterRestart = prompt.uri.toString(true);
                const oldClient = state.clients.get(nativeKeyAfterRestart);
                updateSessionLanguageEnvironment(native, process.execPath, [
                    path.join(os.tmpdir(), 'changed-library'),
                ]);
                await settle();
                assert.notStrictEqual(state.clients.get(nativeKeyAfterRestart), oldClient);
                const callsAfterMetadata = start.callCount;
                updateSessionLanguageEnvironment(native, process.execPath, [
                    path.join(os.tmpdir(), 'changed-library'),
                ]);
                await settle();
                assert.strictEqual(start.callCount, callsAfterMetadata);
                // Never silently analyze this session with the workspace's R or webR.
                const finds = findR.callCount;
                updateSessionLanguageEnvironment(
                    native,
                    path.join(os.tmpdir(), 'unavailable-session-R'),
                    [],
                );
                await settle();
                assert.strictEqual(state.clients.has(nativeKeyAfterRestart), false);
                assert.strictEqual(findR.callCount, finds);
                assert.strictEqual(state.clients.get('global'), project);
                replaceSessionTransport(native, wasm);
                await settle();
                check(true);
                unregisterSessionTransport(wasm);
                await settle();
                check(policy === 'webR');
            } finally {
                await languageService.dispose();
                opened.dispose();
                unregisterSessionTransport(wasm);
                unregisterSessionTransport(native);
                sandbox.restore();
            }
        });
    }
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
                    if (${reply} && message.method === 'exit') setTimeout(() => process.exit(0), 75);
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
            assert.strictEqual(
                first.exitCode,
                0,
                'Graceful shutdown must allow server cleanup to finish',
            );
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
            assert.strictEqual(next.exitCode, 0);
            assert.ok(shutdowns.has(next));
            assert.strictEqual(state.startingClients.size, 0);
        });
    }

    test('disposal cancels a pending executable lookup and does not start a late client', async () => {
        configure(false, false);
        let finish!: (value: string) => void;
        (util.getRpath as sinon.SinonStub).returns(
            new Promise<string>((resolve) => {
                finish = resolve;
            }),
        );
        service = new LanguageService();
        await Promise.resolve();
        let deadline: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                service.dispose(),
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(
                        () => reject(new Error('Executable lookup blocked disposal')),
                        3000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(deadline);
            finish(process.execPath);
        }
        await Promise.resolve();
        assert.strictEqual(children.length, 0);
        assert.strictEqual(watcherDisposals.length, 0);
    });

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

suite('Language client stop', () => {
    let sandbox: sinon.SinonSandbox;
    let errors: sinon.SinonStub;
    let cleanup: Array<() => unknown>;

    setup(() => {
        sandbox = sinon.createSandbox();
        errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        cleanup = [];
    });

    teardown(async () => {
        try {
            for (const release of cleanup.reverse()) {
                await release();
            }
        } finally {
            sandbox.restore();
        }
    });

    const disconnect = (code: string) => Object.assign(new Error(`socket ${code}`), { code });

    /**
     * A TCP language server owned by a real child process, like R's server.
     * The child exits only when the test calls `exitChild()`. With
     * `closeAtExitNotification`, the client sees the order R can produce: the
     * server has answered shutdown and closed, so reading resets and writing the
     * exit notification fails.
     */
    async function startServer(options: {
        closeAtExitNotification?: { exitChild: boolean };
    }): Promise<{
        client: CancellableLanguageClient;
        child: childProcess.ChildProcess;
        errorHandler: sinon.SinonSpy;
        serverSocket: () => net.Socket;
    }> {
        const channel = vscode.window.createOutputChannel('Test language client stop', {
            log: true,
        });
        cleanup.push(() => channel.dispose());
        const child = childProcess.spawn(
            process.execPath,
            ['-e', "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();"],
            {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['pipe', 'ignore', 'ignore'],
            },
        );
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        cleanup.push(async () => {
            child.kill('SIGKILL');
            await closed;
        });
        let serverSocket: net.Socket | undefined;
        const connections: Array<{ dispose(): void }> = [];
        const server = net.createServer((socket) => {
            serverSocket = socket;
            socket.on('error', () => undefined);
            const connection = createMessageConnection(
                new StreamMessageReader(socket),
                new StreamMessageWriter(socket),
            );
            connections.push(connection);
            connection.onRequest('initialize', () => ({ capabilities: {} }));
            connection.onRequest('shutdown', () => null);
            connection.listen();
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(async () => {
            connections.forEach((connection) => connection.dispose());
            serverSocket?.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const client: CancellableLanguageClient = new CancellableLanguageClient(
            'stop-test',
            'Stop test',
            async () => {
                client.ownProcess(
                    Object.assign(child, {
                        dispose: () => child.kill('SIGKILL'),
                    }) as unknown as util.DisposableProcess,
                );
                const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
                await new Promise<void>((resolve) => socket.once('connect', resolve));
                client.ownSocket(socket);
                const writer = new StreamMessageWriter(socket);
                const close = options.closeAtExitNotification;
                if (close) {
                    const write = writer.write.bind(writer);
                    writer.write = async (message) => {
                        if (!('method' in message) || message.method !== 'exit') {
                            return write(message);
                        }
                        if (close.exitChild) {
                            child.stdin!.end();
                            await closed;
                        }
                        socket.emit('error', disconnect('ECONNRESET'));
                        throw disconnect('EPIPE');
                    };
                }
                return { reader: new StreamMessageReader(socket), writer };
            },
            { documentSelector: [], outputChannel: channel },
            new AbortController().signal,
        );
        const errorHandler = sandbox.spy(client.clientOptions.errorHandler!, 'error');
        await client.start();
        cleanup.push(() => client.stop().catch(() => undefined));
        return { client, child, errorHandler, serverSocket: () => serverSocket! };
    }

    test('a server that exits after answering shutdown stops without a user-facing error', async () => {
        const { client, child, errorHandler } = await startServer({
            closeAtExitNotification: { exitChild: true },
        });
        await client.stop();
        assert.strictEqual(client.state, State.Stopped);
        assert.strictEqual(child.exitCode, 0, 'The server must exit by itself, not be killed');
        sinon.assert.calledWithMatch(errorHandler, sinon.match.has('code', 'ECONNRESET'));
        // The client reports connection errors after its handler returns.
        await new Promise((resolve) => setImmediate(resolve));
        sinon.assert.notCalled(errors);
    });

    test('a server that answers shutdown but keeps running still fails the stop', async () => {
        const { client } = await startServer({ closeAtExitNotification: { exitChild: false } });
        await assert.rejects(
            client.stop(),
            (error) => (error as { code?: string }).code === 'EPIPE',
        );
    });

    test('a reset connection while running is still reported', async () => {
        const { serverSocket } = await startServer({});
        serverSocket().resetAndDestroy();
        const deadline = Date.now() + 5000;
        while (!errors.called) {
            assert.ok(Date.now() < deadline, 'An unexpected disconnect must be reported');
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    });
});
