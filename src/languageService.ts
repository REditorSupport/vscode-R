'use strict';

import * as os from 'os';
import { basename, dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { config, DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn, substituteVariables } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';
import { boundSessionForDocument, onDidBindSessionDocument, Session } from './session';
import { SessionSignatureHelpProvider } from './signatureHelp';

interface SessionState {
    attachedPackages: string[];
    loadedNamespaces: string[];
}

interface SessionWorkspaceData {
    search: string[];
    loaded_namespaces: string[];
}

export class LanguageService implements Disposable {
    private readonly clients: Map<string, LanguageClient> = new Map();
    private readonly initSet: Set<string> = new Set();
    private readonly config: WorkspaceConfiguration;
    private readonly outputChannel: OutputChannel;
    private readonly sessionSignatures = new SessionSignatureHelpProvider();
    private readonly clientUpdates = new Map<string, Promise<void>>();
    private readonly listeners: Disposable[] = [];
    private disposed = false;
    private readonly sessionStates: Map<string, { state: SessionState; stateKey: string; sessionId: string }> = new Map();

    constructor() {
        this.outputChannel = window.createOutputChannel('R Language Server');
        this.config = workspace.getConfiguration('r');
        void this.startLanguageService();
    }

    dispose(): Thenable<void> {
        this.disposed = true;
        this.listeners.forEach(listener => { listener.dispose(); });
        return this.stopLanguageService();
    }

    syncSessionState(data?: SessionWorkspaceData, resource?: Uri, sessionId = ''): void {
        const clientKey = this.config.get<boolean>('lsp.multiServer') === true
            ? resource ? this.getClientKey(resource) : undefined
            : 'global';
        if (!clientKey) {
            return;
        }

        const current = this.sessionStates.get(clientKey);
        if (!data) {
            if (!current || (sessionId && current.sessionId !== sessionId)) {
                return;
            }
            this.sessionStates.delete(clientKey);
            const client = this.clients.get(clientKey);
            if (client) {
                void this.applySessionState(client, {
                    attachedPackages: [],
                    loadedNamespaces: [],
                });
            }
            return;
        }

        const state: SessionState = {
            attachedPackages: data.search
                .filter(value => value.startsWith('package:'))
                .map(value => value.substring(8)),
            loadedNamespaces: data.loaded_namespaces,
        };
        const stateKey = this.getSessionStateKey(state);
        if (current?.stateKey === stateKey && current.sessionId === sessionId) {
            return;
        }

        this.sessionStates.set(clientKey, { state, stateKey, sessionId });
        const client = this.clients.get(clientKey);
        if (client) {
            void this.applySessionState(client, state);
        }
    }

    private async applySessionState(client: LanguageClient, state: SessionState): Promise<void> {
        try {
            await client.sendRequest('r/syncSessionState', state);
        } catch {
            // Keep language-service features available if session synchronization fails.
        }
    }

    private getSessionStateKey(state: SessionState): string {
        return [
            state.attachedPackages.join('\u0000'),
            state.loadedNamespaces.join('\u0000'),
        ].join('\u0001');
    }

    private spawnServer(client: LanguageClient, rPath: string, args: readonly string[], options: CommonOptions & { cwd: string }): DisposableProcess {
        const childProcess = spawn(rPath, args, options);
        const pid = childProcess.pid || -1;
        client.outputChannel.appendLine(`R Language Server (${pid}) started`);
        childProcess.stderr.on('data', (chunk: Buffer) => {
            client.outputChannel.appendLine(chunk.toString());
        });
        childProcess.on('exit', (code, signal) => {
            client.outputChannel.appendLine(`R Language Server (${pid}) exited ` +
                (signal ? `from signal ${signal}` : `with exit code ${code || 'null'}`));
            if (code !== 0) {
                if (code === 10) {
                    // languageserver is not installed.
                    void promptToInstallRPackage(
                        'languageserver', 'lsp.promptToInstall', options.cwd,
                        'R package {languageserver} is required to enable R language service features such as code completion, function signature, find references, etc. Do you want to install it?',
                        'You may need to reopen an R file to start the language service after the package is installed.'
                    );
                } else {
                    client.outputChannel.show();
                }
            }
            if (client.needsStop()) {
                void client.stop();
            }
        });
        return childProcess;
    }

    private async createClient(selector: DocumentFilter[],
        cwd: string, workspaceFolder: WorkspaceFolder | undefined, outputChannel: OutputChannel,
        resource?: Uri, clientKey: string = 'global', target?: Session): Promise<LanguageClient> {

        let client: LanguageClient;
        const virtualOnly = selector.every(filter => 'scheme' in filter
            && (filter.scheme === 'vscode-notebook-cell' || filter.scheme === 'vscode-interactive-input'));
        // An unrooted server resolves opaque document paths against cwd, which
        // makes languageserver discard cells when the session lives under /tmp.
        // Give virtual documents their actual working directory as the root.
        const syntheticWorkspace = virtualOnly && !workspaceFolder;
        if (syntheticWorkspace) {
            workspaceFolder = { uri: Uri.file(cwd), name: basename(cwd), index: 0 };
        }
        const pathlessNotebook = selector.some(filter => 'scheme' in filter && filter.scheme === 'vscode-notebook-cell'
            && typeof filter.pattern === 'string' && !fs.existsSync(filter.pattern));

        const resourceConfig = config(resource);
        const debug = this.config.get<boolean>('lsp.debug');
        const useRenvLibPath = this.config.get<boolean>('useRenvLibPath') ?? false;
        const rPath = target?.rPath || await getRpath(false, resource) || ''; // TODO: Abort gracefully
        if (debug) {
            console.log(`R path: ${rPath}`);
        }
        const use_stdio = this.config.get<boolean>('lsp.use_stdio');
        const env = Object.create(process.env) as NodeJS.ProcessEnv;
        env.VSCR_LSP_DEBUG = debug ? 'TRUE' : 'FALSE';
        env.VSCR_LSP_VIRTUAL_DOCUMENTS = virtualOnly ? 'TRUE' : 'FALSE';
        env.VSCR_LSP_SYNTHETIC_WORKSPACE = syntheticWorkspace ? 'TRUE' : 'FALSE';
        env.VSCR_LIB_PATHS = target?.libraryPaths?.join('\n') ?? getRLibPaths();
        env.VSCR_USE_RENV_LIB_PATH = useRenvLibPath ? 'TRUE' : 'FALSE';

        const lang = this.config.get<string>('lsp.lang');
        if (lang !== '') {
            env.LANG = lang;
        } else if (env.LANG === undefined) {
            env.LANG = 'en_US.UTF-8';
        }

        if (debug) {
            console.log(`LANG: ${env.LANG}`);
        }

        const rScriptPath = extensionContext.asAbsolutePath('R/languageServer.R');
        const options = { cwd: cwd, env: env };
        const args = (resourceConfig.get<string[]>('lsp.args')?.map(value => substituteVariables(value, resource)) ?? []).concat(
            '--silent',
            '--no-echo',
            '--no-save',
            '--no-restore',
            '-e',
            'base::source(base::commandArgs(TRUE))',
            '--args',
            rScriptPath
        );

        const tcpServerOptions = () => new Promise<DisposableProcess | StreamInfo>((resolve, reject) => {
            // Use a TCP socket because of problems with blocking STDIO
            const server = net.createServer(socket => {
                // 'connection' listener
                console.log('R process connected');
                socket.on('end', () => {
                    console.log('R process disconnected');
                });
                socket.on('error', (e: Error) => {
                    console.log(`R process error: ${e.message}`);
                    reject(e);
                });
                server.close();
                resolve({ reader: socket, writer: socket });
            });
            // Listen on random port
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as net.AddressInfo).port;
                env.VSCR_LSP_PORT = String(port);
                return this.spawnServer(client, rPath, args, options);
            });
        });

        // Options to control the language client
        const clientOptions: LanguageClientOptions = {
            // Register the server for selected R documents
            documentSelector: selector,
            uriConverters: {
                // VS Code by default %-encodes even the colon after the drive letter
                // NodeJS handles it much better
                // languageserver interprets vscode-notebook-cell paths as real files.
                // Unsaved Interactive notebooks have no such file; namespace linters
                // call normalizePath even with lint_cache disabled. Use an opaque
                // scheme so the server lints the text like an unsaved input document.
                // Preserve the full path/fragment and translate every result back.
                code2Protocol: uri => new URL((uri.scheme === 'vscode-notebook-cell' && pathlessNotebook
                    ? uri.with({ scheme: 'vscode-r-cell' }) : uri).toString(true)).toString(),
                protocol2Code: str => {
                    const uri = Uri.parse(str);
                    return uri.scheme === 'vscode-r-cell' ? uri.with({ scheme: 'vscode-notebook-cell' }) : uri;
                }
            },
            workspaceFolder: workspaceFolder,
            outputChannel: outputChannel,
            synchronize: {
                // Synchronize the setting section 'r' to the server
                configurationSection: 'r.lsp',
                fileEvents: workspace.createFileSystemWatcher('**/*.{R,r}'),
            },
            middleware: {
                provideSignatureHelp: async (document, position, context, token, next) => {
                    const result = await next(document, position, context, token);
                    // An empty LSP result still suppresses other VS Code providers.
                    // Preserve source/package signatures, then consult this session.
                    return result?.signatures.length ? result : this.sessionSignatures.provideSignatureHelp(document, position, token);
                },
                didChange: (event, next) => {
                    if (event.document.uri.scheme === 'vscode-interactive-input' && !event.document.getText().trim()) {
                        client.diagnostics?.delete(event.document.uri);
                    }
                    return next(event);
                },
                handleDiagnostics: (uri, diagnostics, next) => {
                    const supportedSchemes = ['file', 'untitled', 'vscode-notebook-cell', 'vscode-interactive-input'];
                    
                    // Drop diagnostics for unsupported schemes (like git://)
                    if (!supportedSchemes.includes(uri.scheme)) {
                        return next(uri, []); 
                    }
                    
                    // Drop diagnostics for files that no longer exist on disk
                    if (uri.scheme === 'file' && !fs.existsSync(uri.fsPath)) {
                        return next(uri, []);
                    }
                    // An empty prompt is ready for the next command, not an R source file
                    // needing whitespace repairs. Also reject late replies after it clears.
                    if (uri.scheme === 'vscode-interactive-input' && !workspace.textDocuments.find(document =>
                        document.uri.toString() === uri.toString())?.getText().trim()) {
                        return next(uri, []);
                    }
                    
                    return next(uri, diagnostics);
                }
            },
            revealOutputChannelOn: RevealOutputChannelOn.Never,
            errorHandler: {
                error: () =>    {
                    return {
                        action: ErrorAction.Continue
                    };
                },
                closed: () => {
                    return {
                        action: CloseAction.DoNotRestart
                    };
                },
            },
        };

        // Create the language client and start the client.
        if (use_stdio && process.platform !== 'win32') {
            client = new LanguageClient('r', 'R Language Server', { command: rPath, args: args, options: options }, clientOptions);
        } else {
            client = new LanguageClient('r', 'R Language Server', tcpServerOptions, clientOptions);
        }

        extensionContext.subscriptions.push(client);
        await client.start();
        const sessionState = this.sessionStates.get(clientKey)?.state;
        if (sessionState) {
            await this.applySessionState(client, sessionState);
        }
        return client;
    }


    private checkClient(name: string): boolean {
        if (this.initSet.has(name)) {
            return true;
        }
        const client = this.clients.get(name);
        if (client && client.needsStop()) {
            return true;
        }
        this.initSet.add(name);
        return false;
    }

    private getClientKey(uri: Uri): string {
        const folder = workspace.getWorkspaceFolder(uri);
        return this.getKey(folder?.uri ?? uri);
    }

    private getKey(uri: Uri): string {
        switch (uri.scheme) {
            case 'untitled':
                return uri.scheme;
            case 'vscode-notebook-cell':
                return `vscode-notebook:${uri.fsPath}`;
            default:
                return uri.toString(true);
        }
    }

    private startMultiLanguageService(virtualOnly = false): void {
        const clientTargets = new Map<string, Session | undefined>();
        const didOpenTextDocument = async (document: TextDocument) => {
            if (virtualOnly && !['vscode-notebook-cell', 'vscode-interactive-input'].includes(document.uri.scheme)) { return; }
            if (!['file', 'untitled', 'vscode-notebook-cell', 'vscode-interactive-input'].includes(document.uri.scheme)) {
                return;
            }

            if (document.languageId !== 'r' && document.languageId !== 'rmd') {
                return;
            }

            const target = boundSessionForDocument(document.uri);
            const folder = workspace.getWorkspaceFolder(target ? Uri.file(target.workingDir) : document.uri);

            if (document.uri.scheme === 'vscode-interactive-input') {
                const key = document.uri.toString();
                if (!this.checkClient(key)) {
                    const selector = [{ scheme: 'vscode-interactive-input', language: 'r', pattern: document.uri.fsPath }];
                    const client = await this.createClient(selector, target?.workingDir ?? folder?.uri.fsPath ?? os.homedir(), folder, this.outputChannel, folder?.uri, key, target);
                    this.clients.set(key, client); this.initSet.delete(key);
                }
                return;
            }

            // Each notebook uses a server started from parent folder
            if (document.uri.scheme === 'vscode-notebook-cell') {
                const key = this.getKey(document.uri);
                if (!this.checkClient(key)) {
                    console.log(`Start language server for ${document.uri.toString(true)}`);
                    const documentSelector: DocumentFilter[] = [
                        { scheme: 'vscode-notebook-cell', language: 'r', pattern: `${document.uri.fsPath}` },
                    ];
                    const client = await this.createClient(documentSelector,
                        target?.workingDir ?? folder?.uri.fsPath ?? dirname(document.uri.fsPath), folder, this.outputChannel, folder?.uri ?? document.uri, key, target);
                    this.clients.set(key, client);
                    this.initSet.delete(key);
                }
                return;
            }

            if (folder) {

                // Each workspace uses a server started from the workspace folder
                const key = this.getKey(folder.uri);
                if (!this.checkClient(key)) {
                    console.log(`Start language server for ${document.uri.toString(true)}`);
                    const pattern = `${folder.uri.fsPath}/**/*`;
                    const documentSelector: DocumentFilter[] = [
                        { scheme: 'file', language: 'r', pattern: pattern },
                        { scheme: 'file', language: 'rmd', pattern: pattern },
                    ];
                    const client = await this.createClient(documentSelector, folder.uri.fsPath, folder, this.outputChannel, folder.uri, key);
                    this.clients.set(key, client);
                    this.initSet.delete(key);
                }

            } else {

                // All untitled documents share a server started from home folder
                if (document.uri.scheme === 'untitled') {
                    const key = this.getKey(document.uri);
                    if (!this.checkClient(key)) {
                        console.log(`Start language server for ${document.uri.toString(true)}`);
                        const documentSelector: DocumentFilter[] = [
                            { scheme: 'untitled', language: 'r' },
                            { scheme: 'untitled', language: 'rmd' },
                        ];
                        const client = await this.createClient(documentSelector, os.homedir(), undefined, this.outputChannel, document.uri, key);
                        this.clients.set(key, client);
                        this.initSet.delete(key);
                    }
                    return;
                }

                // Each file outside workspace uses a server started from parent folder
                if (document.uri.scheme === 'file') {
                    const key = this.getKey(document.uri);
                    if (!this.checkClient(key)) {
                        console.log(`Start language server for ${document.uri.toString(true)}`);
                        const documentSelector: DocumentFilter[] = [
                            { scheme: 'file', pattern: document.uri.fsPath },
                        ];
                        const client = await this.createClient(documentSelector,
                            dirname(document.uri.fsPath), undefined, this.outputChannel, document.uri, key);
                        this.clients.set(key, client);
                        this.initSet.delete(key);
                    }
                    return;
                }
            }
        };

        const didCloseTextDocument = (document: TextDocument): void => {
            if (document.uri.scheme === 'untitled') {
                const result = workspace.textDocuments.find((doc) => doc.uri.scheme === 'untitled');
                if (result) {
                    // Stop the language server when all untitled documents are closed.
                    return;
                }
            }

            if (document.uri.scheme === 'vscode-notebook-cell') {
                const result = workspace.textDocuments.find((doc) =>
                    doc.uri.scheme === document.uri.scheme && doc.uri.fsPath === document.uri.fsPath);
                if (result) {
                    // Stop the language server when all cell documents are closed (notebook closed).
                    return;
                }
            }

            // Stop the language server when single file outside workspace is closed, or the above cases.
            const key = this.getKey(document.uri);
            clientTargets.delete(key);
            const client = this.clients.get(key);
            if (client) {
                this.clients.delete(key);
                this.initSet.delete(key);
                void client.stop();
            }
        };

        const updateDocument = (document: TextDocument, restart = false): void => {
            const key = this.getKey(document.uri);
            // A native input may already be R when interactive.open returns,
            // before its owner is bound. Serialize startup and rebinding so its
            // server uses the owner's R, library paths, and working directory.
            const update = (this.clientUpdates.get(key) ?? Promise.resolve()).then(async () => {
                if (this.disposed || document.isClosed) { return; }
                const target = boundSessionForDocument(document.uri);
                // Rebinding retained cells can report the same notebook owner
                // repeatedly. Restart its shared server only once per owner.
                if (restart && clientTargets.get(key) !== target) {
                    const client = this.clients.get(key);
                    this.clients.delete(key); this.initSet.delete(key);
                    await client?.stop();
                }
                await didOpenTextDocument(document);
                if (this.clients.has(key)) { clientTargets.set(key, target); }
            }).catch((error: unknown) => {
                this.initSet.delete(key);
                this.outputChannel.appendLine(`Failed to start language server: ${String(error)}`);
            });
            this.clientUpdates.set(key, update);
            void update.then(() => {
                if (this.clientUpdates.get(key) === update) { this.clientUpdates.delete(key); }
            });
        };
        this.listeners.push(onDidBindSessionDocument(uri => {
            if (!['vscode-notebook-cell', 'vscode-interactive-input'].includes(uri.scheme)) { return; }
            const document = workspace.textDocuments.find(doc => this.getKey(doc.uri) === this.getKey(uri));
            if (document) { updateDocument(document, true); }
        }));
        this.listeners.push(workspace.onDidOpenTextDocument(document => updateDocument(document)));
        this.listeners.push(workspace.onDidCloseTextDocument(didCloseTextDocument));
        workspace.textDocuments.forEach(document => updateDocument(document));
        this.listeners.push(workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                const key = this.getKey(folder.uri);
                const client = this.clients.get(key);
                if (client) {
                    this.clients.delete(key);
                    this.initSet.delete(key);
                    void client.stop();
                }
            }
        }));
    }

    private async startLanguageService(): Promise<void> {
        let useMultiServer = false;
        const multiServerConfig = this.config.get<boolean>('lsp.multiServer');

        if (multiServerConfig === true) {
            useMultiServer = true;
        }

        if (useMultiServer) {
            this.startMultiLanguageService();
        } else {
            const documentSelector: DocumentFilter[] = [
                { scheme: 'file', language: 'r' },
                { scheme: 'file', language: 'rmd' },
                { scheme: 'untitled', language: 'r' },
                { scheme: 'untitled', language: 'rmd' },
            ];

            const workspaceFolder = workspace.workspaceFolders?.[0];
            const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
            const client = await this.createClient(documentSelector, cwd, undefined, this.outputChannel, workspaceFolder?.uri, 'global');
            this.clients.set('global', client);
            this.startMultiLanguageService(true);
        }
    }

    private async stopLanguageService(): Promise<void> {
        await Promise.all(this.clientUpdates.values());
        const promises: Thenable<void>[] = [];
        for (const client of this.clients.values()) {
            promises.push(client.stop());
        }
        return Promise.all(promises).then(() => undefined);
    }
}
