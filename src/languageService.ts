'use strict';

import * as os from 'os';
import { dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { config, DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn, substituteVariables } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';

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
    private readonly clientScopes: Map<string, string> = new Map();
    private readonly sessionStates: Map<string, { state: SessionState; stateKey: string; sessionId: string }> = new Map();

    constructor() {
        this.outputChannel = window.createOutputChannel('R Language Server');
        this.config = workspace.getConfiguration('r');
        void this.startLanguageService();
    }

    dispose(): Thenable<void> {
        return this.stopLanguageService();
    }

    syncSessionState(data?: SessionWorkspaceData, resource?: Uri, sessionId = ''): void {
        const scope = this.getSessionScope(resource);
        const current = this.sessionStates.get(scope);
        if (!data) {
            if (!current || (sessionId && current.sessionId !== sessionId)) {
                return;
            }
            this.sessionStates.delete(scope);
            this.applySessionStateToScope(scope, {
                attachedPackages: [],
                loadedNamespaces: [],
            });
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

        this.sessionStates.set(scope, { state, stateKey, sessionId });
        this.applySessionStateToScope(scope, state);
    }

    private applySessionStateToScope(scope: string, state: SessionState): void {
        for (const [key, client] of this.clients) {
            if (this.clientScopes.get(key) === scope) {
                void this.applySessionState(client, state);
            }
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
        resource?: Uri, sessionScope: string = 'global'): Promise<LanguageClient> {

        let client: LanguageClient;

        const resourceConfig = config(resource);
        const debug = this.config.get<boolean>('lsp.debug');
        const useRenvLibPath = this.config.get<boolean>('useRenvLibPath') ?? false;
        const rPath = await getRpath(false, resource) || ''; // TODO: Abort gracefully
        if (debug) {
            console.log(`R path: ${rPath}`);
        }
        const use_stdio = this.config.get<boolean>('lsp.use_stdio');
        const env = Object.create(process.env) as NodeJS.ProcessEnv;
        env.VSCR_LSP_DEBUG = debug ? 'TRUE' : 'FALSE';
        env.VSCR_LIB_PATHS = getRLibPaths();
        env.VSCR_USE_RENV_LIB_PATH = useRenvLibPath ? 'TRUE' : 'FALSE';

        const lang = this.config.get<string>('lsp.lang');
        if (lang !== '') {
            env.LANG = lang;
        } else if (env.LANG === undefined) {
            env.LANG = 'en_US.UTF-8';
        }

        if (debug) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
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
                code2Protocol: uri => new URL(uri.toString(true)).toString(),
                protocol2Code: str => Uri.parse(str)
            },
            workspaceFolder: workspaceFolder,
            outputChannel: outputChannel,
            synchronize: {
                // Synchronize the setting section 'r' to the server
                configurationSection: 'r.lsp',
                fileEvents: workspace.createFileSystemWatcher('**/*.{R,r}'),
            },
            middleware: {
                handleDiagnostics: (uri, diagnostics, next) => {
                    const supportedSchemes = ['file', 'untitled', 'vscode-notebook-cell'];
                    
                    // Drop diagnostics for unsupported schemes (like git://)
                    if (!supportedSchemes.includes(uri.scheme)) {
                        return next(uri, []); 
                    }
                    
                    // Drop diagnostics for files that no longer exist on disk
                    if (uri.scheme === 'file' && !fs.existsSync(uri.fsPath)) {
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
        const sessionState = this.sessionStates.get(sessionScope)?.state;
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

    private getSessionScope(resource?: Uri): string {
        if (this.config.get<boolean>('lsp.multiServer') !== true) {
            return 'global';
        }
        const folder = resource ? workspace.getWorkspaceFolder(resource) : undefined;
        return folder ? this.getKey(folder.uri) : 'unscoped';
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

    private startMultiLanguageService(): void {
        const didOpenTextDocument = async (document: TextDocument) => {
            if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== 'vscode-notebook-cell') {
                return;
            }

            if (document.languageId !== 'r' && document.languageId !== 'rmd') {
                return;
            }

            const folder = workspace.getWorkspaceFolder(document.uri);

            // Each notebook uses a server started from parent folder
            if (document.uri.scheme === 'vscode-notebook-cell') {
                const key = this.getKey(document.uri);
                const scope = folder ? this.getKey(folder.uri) : 'unscoped';
                if (!this.checkClient(key)) {
                    console.log(`Start language server for ${document.uri.toString(true)}`);
                    const documentSelector: DocumentFilter[] = [
                        { scheme: 'vscode-notebook-cell', language: 'r', pattern: `${document.uri.fsPath}` },
                    ];
                    const client = await this.createClient(documentSelector,
                        dirname(document.uri.fsPath), folder, this.outputChannel, folder?.uri ?? document.uri, scope);
                    this.clients.set(key, client);
                    this.clientScopes.set(key, scope);
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
                    this.clientScopes.set(key, key);
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
                        const client = await this.createClient(documentSelector, os.homedir(), undefined, this.outputChannel, document.uri, 'unscoped');
                        this.clients.set(key, client);
                        this.clientScopes.set(key, 'unscoped');
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
                            dirname(document.uri.fsPath), undefined, this.outputChannel, document.uri, 'unscoped');
                        this.clients.set(key, client);
                        this.clientScopes.set(key, 'unscoped');
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
            const client = this.clients.get(key);
            if (client) {
                this.clients.delete(key);
                this.clientScopes.delete(key);
                this.initSet.delete(key);
                void client.stop();
            }
        };

        workspace.onDidOpenTextDocument(didOpenTextDocument);
        workspace.onDidCloseTextDocument(didCloseTextDocument);
        workspace.textDocuments.forEach((doc) => void didOpenTextDocument(doc));
        workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                const key = this.getKey(folder.uri);
                const client = this.clients.get(key);
                if (client) {
                    this.clients.delete(key);
                    this.clientScopes.delete(key);
                    this.initSet.delete(key);
                    void client.stop();
                }
            }
        });
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
                { scheme: 'vscode-notebook-cell', language: 'r' },
            ];

            const workspaceFolder = workspace.workspaceFolders?.[0];
            const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
            const client = await this.createClient(documentSelector, cwd, undefined, this.outputChannel, workspaceFolder?.uri, 'global');
            this.clients.set('global', client);
            this.clientScopes.set('global', 'global');
        }
    }

    private stopLanguageService(): Thenable<void> {
        const promises: Thenable<void>[] = [];
        for (const client of this.clients.values()) {
            promises.push(client.stop());
        }
        return Promise.all(promises).then(() => undefined);
    }
}
