import * as os from 'os';
import { dirname } from 'path';
import * as net from 'net';
import { URL } from 'url';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { Disposable, workspace, Uri, TextDocument, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { DisposableProcess, getRLibPaths, getRpath, promptToInstallRPackage, spawn } from './util';
import { extensionContext } from './extension';
import { CommonOptions } from 'child_process';

export class LanguageService implements Disposable {
    private client: LanguageClient | undefined;

    constructor() {
        this.client = undefined;
        this.startLanguageService(this);
    }

    dispose(): Thenable<void> {
        return this.stopLanguageService();
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
            void client.stop();
        });
        return childProcess;
    }

    private async createClient(config: WorkspaceConfiguration, selector: DocumentFilter[],
        cwd: string, workspaceFolder: WorkspaceFolder | undefined, outputChannel: OutputChannel): Promise<LanguageClient> {

        let client: LanguageClient;

        const debug = config.get<boolean>('lsp.debug');
        const rPath = await getRpath() || ''; // TODO: Abort gracefully
        if (debug) {
            console.log(`R path: ${rPath}`);
        }
        const use_stdio = config.get<boolean>('lsp.use_stdio');
        const env = Object.create(process.env) as NodeJS.ProcessEnv;
        env.VSCR_LSP_DEBUG = debug ? 'TRUE' : 'FALSE';
        env.VSCR_LIB_PATHS = getRLibPaths();

        const lang = config.get<string>('lsp.lang');
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
        const args = (config.get<string[]>('lsp.args') ?? []).concat(
            '--silent',
            '--slave',
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

    private async startLanguageService(self: LanguageService): Promise<void> {
        const config = workspace.getConfiguration('r');
        const outputChannel: OutputChannel = window.createOutputChannel('R Language Server');

        const documentSelector: DocumentFilter[] = [
            { language: 'r' },
            { language: 'rmd' },
        ];

        self.client = await self.createClient(config, documentSelector,
            os.homedir(), undefined, outputChannel);
    }

    private stopLanguageService(): Thenable<void> {
        if (this.client && this.client.needsStop()) {
            return this.client.stop();
        }
        return Promise.resolve(undefined);
    }
}
