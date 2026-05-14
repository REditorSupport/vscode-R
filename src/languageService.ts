'use strict';

import * as os from 'os';
import { dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import * as fs from 'fs';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn, substituteVariables } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';

export class LanguageService implements Disposable {
    private static readonly globalClientKey = 'global';
    private static readonly idleStopDelayMs = 30_000;
    private readonly clients: Map<string, LanguageClient> = new Map();
    private readonly initSet: Set<string> = new Set();
    private readonly idleStopTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private readonly trackedDocuments: Map<string, Set<string>> = new Map();
    private readonly disposables: Disposable[] = [];
    private readonly config: WorkspaceConfiguration;
    private readonly outputChannel: OutputChannel;
    private disposed = false;

    constructor() {
        this.outputChannel = window.createOutputChannel('R Language Server');
        this.config = workspace.getConfiguration('r');
        this.startLanguageService();
    }

    dispose(): Thenable<void> {
        this.disposed = true;
        return this.stopLanguageService();
    }

    private spawnServer(client: LanguageClient, rPath: string, args: readonly string[], options: CommonOptions & { cwd: string },
        onExit?: (client: LanguageClient) => void): DisposableProcess {
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
            onExit?.(client);
        });
        return childProcess;
    }

    private async createClient(selector: DocumentFilter[],
        cwd: string, workspaceFolder: WorkspaceFolder | undefined, outputChannel: OutputChannel,
        onExit?: (client: LanguageClient) => void): Promise<LanguageClient> {

        let client: LanguageClient;

        const debug = this.config.get<boolean>('lsp.debug');
        const useRenvLibPath = this.config.get<boolean>('useRenvLibPath') ?? false;
        const rPath = await getRpath() || ''; // TODO: Abort gracefully
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
        const args = (this.config.get<string[]>('lsp.args')?.map(substituteVariables) ?? []).concat(
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
                return this.spawnServer(client, rPath, args, options, onExit);
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
        return client;
    }


    private isSupportedDocumentScheme(document: TextDocument): boolean {
        return document.uri.scheme === 'file' ||
            document.uri.scheme === 'untitled' ||
            document.uri.scheme === 'vscode-notebook-cell';
    }

    private isRLanguageDocument(document: TextDocument): boolean {
        return document.languageId === 'r' || document.languageId === 'rmd';
    }

    private isTrackedRDocument(document: TextDocument): boolean {
        return this.isSupportedDocumentScheme(document) &&
            this.isRLanguageDocument(document) &&
            !this.isTemporaryRSource(document);
    }

    private isTemporaryRSource(document: TextDocument): boolean {
        if (document.uri.scheme !== 'file') {
            return false;
        }

        const fsPath = document.uri.fsPath.toLowerCase();
        return fsPath.includes('rtmp') &&
            fsPath.endsWith('.r') &&
            !fsPath.includes('.vdoc.');
    }

    private hasOpenRLanguageDocuments(): boolean {
        return workspace.textDocuments.some((document) => this.isTrackedRDocument(document));
    }

    private isQuartoDocument(document: TextDocument): boolean {
        return document.uri.fsPath.toLowerCase().endsWith('.qmd') ||
            this.isUntitledQuartoDocument(document);
    }

    private isUntitledQuartoDocument(document: TextDocument): boolean {
        return document.uri.scheme === 'untitled' &&
            (document.languageId === 'quarto' ||
                document.languageId === 'r' ||
                document.languageId === 'rmd');
    }

    private isQuartoChunkUri(uriString: string): boolean {
        try {
            const uri = Uri.parse(uriString);
            return uri.scheme === 'file' &&
                uri.fsPath.includes('.vdoc.') &&
                uri.fsPath.toLowerCase().endsWith('.r');
        } catch {
            return false;
        }
    }

    private getServerKey(document: TextDocument): string | undefined {
        const folder = workspace.getWorkspaceFolder(document.uri);
        if (folder) {
            return folder.uri.toString(true);
        }

        if (document.uri.scheme === 'vscode-notebook-cell') {
            return `vscode-notebook:${document.uri.fsPath}`;
        }

        if (document.uri.scheme === 'untitled') {
            return 'untitled';
        }

        if (document.uri.scheme === 'file') {
            return dirname(document.uri.fsPath);
        }

        return undefined;
    }

    private trackDocument(serverKey: string, document: TextDocument): void {
        let documentSet = this.trackedDocuments.get(serverKey);
        if (!documentSet) {
            documentSet = new Set<string>();
            this.trackedDocuments.set(serverKey, documentSet);
        }
        documentSet.add(document.uri.toString(true));
    }

    private untrackDocument(serverKey: string, document: TextDocument): boolean {
        const documentSet = this.trackedDocuments.get(serverKey);
        if (!documentSet) {
            return false;
        }

        documentSet.delete(document.uri.toString(true));
        if (documentSet.size === 0) {
            this.trackedDocuments.delete(serverKey);
            return true;
        }

        return false;
    }

    private getOpenTrackedDocuments(serverKey: string): TextDocument[] {
        const documentSet = this.trackedDocuments.get(serverKey);
        if (!documentSet) {
            return [];
        }

        const openDocuments: TextDocument[] = [];
        for (const uri of Array.from(documentSet)) {
            const document = workspace.textDocuments.find((doc) => doc.uri.toString(true) === uri);
            if (document && this.isTrackedRDocument(document) && this.getServerKey(document) === serverKey) {
                openDocuments.push(document);
            } else {
                documentSet.delete(uri);
            }
        }

        if (documentSet.size === 0) {
            this.trackedDocuments.delete(serverKey);
        }

        return openDocuments;
    }

    private hasOpenTrackedDocuments(serverKey: string): boolean {
        return this.getOpenTrackedDocuments(serverKey).length > 0;
    }

    private forgetStoppedClient(serverKey: string): void {
        const client = this.clients.get(serverKey);
        if (client && !client.needsStop()) {
            this.clients.delete(serverKey);
            this.initSet.delete(serverKey);
            void client.dispose();
        }
    }

    private cancelIdleStop(serverKey: string): void {
        const timer = this.idleStopTimers.get(serverKey);
        if (timer) {
            clearTimeout(timer);
            this.idleStopTimers.delete(serverKey);
        }
    }

    private scheduleIdleStop(serverKey: string, shouldStop: () => boolean): void {
        if (this.disposed || this.idleStopTimers.has(serverKey)) {
            return;
        }

        const timer = setTimeout(() => {
            this.idleStopTimers.delete(serverKey);
            if (shouldStop()) {
                void this.stopClient(serverKey);
            }
        }, LanguageService.idleStopDelayMs);
        this.idleStopTimers.set(serverKey, timer);
    }

    private scheduleMultiIdleStop(serverKey: string): void {
        this.scheduleIdleStop(serverKey, () => !this.hasOpenTrackedDocuments(serverKey));
    }

    private scheduleSingleIdleStop(): void {
        this.scheduleIdleStop(
            LanguageService.globalClientKey,
            () => !this.hasOpenRLanguageDocuments()
        );
    }

    private clearIdleStops(): void {
        for (const timer of this.idleStopTimers.values()) {
            clearTimeout(timer);
        }
        this.idleStopTimers.clear();
    }

    private stopStartedClient(client: LanguageClient): Thenable<void> {
        if (!client.needsStop()) {
            void client.dispose();
            return Promise.resolve();
        }

        return client.stop().then(() => {
            void client.dispose();
        });
    }

    private stopClient(serverKey: string): Thenable<void> | undefined {
        this.cancelIdleStop(serverKey);
        const client = this.clients.get(serverKey);
        this.trackedDocuments.delete(serverKey);

        if (!client) {
            return undefined;
        }

        this.clients.delete(serverKey);
        this.initSet.delete(serverKey);
        return this.stopStartedClient(client);
    }

    private handleClientExit(serverKey: string, client: LanguageClient): void {
        if (this.clients.get(serverKey) !== client) {
            return;
        }

        this.clients.delete(serverKey);
        this.initSet.delete(serverKey);
        this.cancelIdleStop(serverKey);
    }

    private getMultiServerOptions(document: TextDocument): {
        documentSelector: DocumentFilter[];
        cwd: string;
        workspaceFolder: WorkspaceFolder | undefined;
    } | undefined {
        const folder = workspace.getWorkspaceFolder(document.uri);

        if (document.uri.scheme === 'vscode-notebook-cell') {
            return {
                documentSelector: [
                    { scheme: 'vscode-notebook-cell', language: 'r', pattern: `${document.uri.fsPath}` },
                ],
                cwd: dirname(document.uri.fsPath),
                workspaceFolder: folder
            };
        }

        if (folder) {
            const pattern = `${folder.uri.fsPath}/**/*`;
            return {
                documentSelector: [
                    { scheme: 'file', language: 'r', pattern: pattern },
                    { scheme: 'file', language: 'rmd', pattern: pattern },
                ],
                cwd: folder.uri.fsPath,
                workspaceFolder: folder
            };
        }

        if (document.uri.scheme === 'untitled') {
            return {
                documentSelector: [
                    { scheme: 'untitled', language: 'r' },
                    { scheme: 'untitled', language: 'rmd' },
                ],
                cwd: os.homedir(),
                workspaceFolder: undefined
            };
        }

        if (document.uri.scheme === 'file') {
            const dir = dirname(document.uri.fsPath);
            return {
                documentSelector: [
                    { scheme: 'file', pattern: `${dir}/**/*.{R,r,Rmd,rmd}` },
                ],
                cwd: dir,
                workspaceFolder: undefined
            };
        }

        return undefined;
    }

    private async startMultiClient(document: TextDocument): Promise<void> {
        if (this.disposed || !this.isTrackedRDocument(document)) {
            return;
        }

        const serverKey = this.getServerKey(document);
        if (!serverKey) {
            return;
        }

        this.trackDocument(serverKey, document);
        this.cancelIdleStop(serverKey);

        this.forgetStoppedClient(serverKey);

        const client = this.clients.get(serverKey);
        if ((client && client.needsStop()) || this.initSet.has(serverKey)) {
            return;
        }

        const options = this.getMultiServerOptions(document);
        if (!options) {
            return;
        }

        this.initSet.add(serverKey);
        try {
            console.log(`Start language server for ${document.uri.toString(true)}`);
            const client = await this.createClient(
                options.documentSelector,
                options.cwd,
                options.workspaceFolder,
                this.outputChannel,
                (client) => this.handleClientExit(serverKey, client)
            );

            if (this.disposed) {
                await this.stopStartedClient(client);
                return;
            }

            this.clients.set(serverKey, client);
            if (!this.trackedDocuments.has(serverKey)) {
                this.scheduleMultiIdleStop(serverKey);
            }
        } finally {
            this.initSet.delete(serverKey);
        }
    }

    private closeMultiClient(document: TextDocument): void {
        if (this.isRLanguageDocument(document)) {
            const serverKey = this.getServerKey(document);
            if (serverKey) {
                this.untrackDocument(serverKey, document);
                if (!this.hasOpenTrackedDocuments(serverKey)) {
                    this.scheduleMultiIdleStop(serverKey);
                }
            }
            return;
        }

        if (this.isQuartoDocument(document)) {
            for (const [serverKey, documentSet] of this.trackedDocuments.entries()) {
                if (documentSet.size > 0 && Array.from(documentSet).every((uri) => this.isQuartoChunkUri(uri))) {
                    this.trackedDocuments.delete(serverKey);
                    this.scheduleMultiIdleStop(serverKey);
                }
            }
        }
    }

    private startMultiLanguageService(): void {
        const openDisposable = workspace.onDidOpenTextDocument((document) => {
            void this.startMultiClient(document);
        });
        const closeDisposable = workspace.onDidCloseTextDocument((document) => {
            this.closeMultiClient(document);
        });
        const workspaceDisposable = workspace.onDidChangeWorkspaceFolders((event) => {
            for (const folder of event.removed) {
                void this.stopClient(folder.uri.toString(true));
            }
        });

        this.disposables.push(openDisposable, closeDisposable, workspaceDisposable);
        workspace.textDocuments.forEach((document) => {
            void this.startMultiClient(document);
        });
    }

    private singleServerDocumentSelector(): DocumentFilter[] {
        return [
            { language: 'r' },
            { language: 'rmd' },
        ];
    }

    private async startSingleClient(): Promise<void> {
        const serverKey = LanguageService.globalClientKey;
        this.forgetStoppedClient(serverKey);
        if (this.disposed || !this.hasOpenRLanguageDocuments() || this.clients.has(serverKey) || this.initSet.has(serverKey)) {
            if (!this.disposed && this.hasOpenRLanguageDocuments()) {
                this.cancelIdleStop(serverKey);
            }
            return;
        }

        this.cancelIdleStop(serverKey);
        this.initSet.add(serverKey);
        try {
            const workspaceFolder = workspace.workspaceFolders?.[0];
            const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();
            const client = await this.createClient(
                this.singleServerDocumentSelector(),
                cwd,
                undefined,
                this.outputChannel,
                (client) => this.handleClientExit(serverKey, client)
            );

            if (this.disposed) {
                await this.stopStartedClient(client);
                return;
            }

            this.clients.set(serverKey, client);

            if (!this.hasOpenRLanguageDocuments()) {
                this.scheduleSingleIdleStop();
            }
        } finally {
            this.initSet.delete(serverKey);
        }
    }

    private stopSingleClientIfIdle(): void {
        if (!this.hasOpenRLanguageDocuments()) {
            this.scheduleSingleIdleStop();
        }
    }

    private startSingleLanguageService(): void {
        const openDisposable = workspace.onDidOpenTextDocument((document) => {
            if (this.isRLanguageDocument(document)) {
                void this.startSingleClient();
            }
        });
        const closeDisposable = workspace.onDidCloseTextDocument(() => {
            this.stopSingleClientIfIdle();
        });

        this.disposables.push(openDisposable, closeDisposable);

        if (this.hasOpenRLanguageDocuments()) {
            void this.startSingleClient();
        }
    }

    private startLanguageService(): void {
        let useMultiServer = false;
        const multiServerConfig = this.config.get<boolean>('lsp.multiServer');

        if (multiServerConfig === true) {
            useMultiServer = true;
        }

        if (useMultiServer) {
            this.startMultiLanguageService();
        } else {
            this.startSingleLanguageService();
        }
    }

    private stopLanguageService(): Thenable<void> {
        const promises: Thenable<void>[] = [];
        this.clearIdleStops();
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        for (const serverKey of Array.from(this.clients.keys())) {
            const promise = this.stopClient(serverKey);
            if (promise) {
                promises.push(promise);
            }
        }
        this.initSet.clear();
        this.trackedDocuments.clear();
        return Promise.all(promises).then(() => undefined);
    }
}
