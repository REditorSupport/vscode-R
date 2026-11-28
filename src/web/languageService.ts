import * as vscode from 'vscode';
import {
    CloseAction,
    ErrorAction,
    LanguageClient,
    RevealOutputChannelOn,
    State,
} from 'vscode-languageclient/browser';
import { createWebRLanguageSession, type WebRLanguageSession } from '../webr/languageSession';
import { createWebRMessageTransports } from '../webr/messageTransports';
import { cachedWebRAssets } from '../webr/assetCache';
import { WEBR_BASE_URL } from '../webr/runtime';

/** The service provides one retry action for startup and worker failures. */
class WorkerLanguageClient extends LanguageClient {
    override error(
        message: string,
        data?: unknown,
        showNotification: boolean | 'force' = true,
    ): void {
        super.error(message, data, this.state === State.Running ? showNotification : false);
    }
}

export class BrowserLanguageService implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('R Language Server', { log: true });
    private readonly listeners: vscode.Disposable[];
    private current?: {
        client: LanguageClient;
        abort: AbortController;
        session?: WebRLanguageSession;
    };
    private stopped = false;
    private stopping = Promise.resolve();
    private nativePreferenceReported = false;

    constructor(private readonly storage: vscode.Uri) {
        this.listeners = [
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (doc.languageId === 'r' || doc.languageId === 'rmd') {
                    this.refresh();
                }
            }),
            vscode.workspace.onDidChangeConfiguration((change) => {
                if (
                    change.affectsConfiguration('r.lsp.enabled') ||
                    change.affectsConfiguration('r.lsp.runtime')
                ) {
                    this.refresh();
                }
            }),
        ];
        this.refresh();
    }

    private refresh(): void {
        if (this.stopped) {
            return;
        }
        const settings = vscode.workspace.getConfiguration('r');
        if (
            !settings.get('lsp.enabled', true) ||
            settings.get<string>('lsp.runtime') === 'native'
        ) {
            this.stopClient();
            if (
                !this.nativePreferenceReported &&
                settings.get<string>('lsp.runtime') === 'native'
            ) {
                this.nativePreferenceReported = true;
                this.output.appendLine(
                    'The browser has no native R executable. Set r.lsp.runtime to auto or webR to enable the R language server.',
                );
            }
            return;
        }
        this.nativePreferenceReported = false;
        if (
            this.current ||
            !vscode.workspace.textDocuments.some((doc) => ['r', 'rmd'].includes(doc.languageId))
        ) {
            return;
        }
        const abort = new AbortController();
        const client: LanguageClient = new WorkerLanguageClient(
            'r',
            'R Language Server',
            async () => {
                const session = await createWebRLanguageSession({
                    baseUrl: WEBR_BASE_URL,
                    signal: abort.signal,
                    loadAsset: cachedWebRAssets(this.storage),
                });
                if (abort.signal.aborted || this.current?.client !== client) {
                    session.close();
                    throw new Error('The webR language service was stopped.');
                }
                this.current.session = session;
                return createWebRMessageTransports(session);
            },
            {
                documentSelector: [{ language: 'r' }, { language: 'rmd' }],
                outputChannel: this.output,
                revealOutputChannelOn: RevealOutputChannelOn.Never,
                initializationFailedHandler: () => false,
                errorHandler: {
                    error: () => ({ action: ErrorAction.Continue }),
                    closed: () => {
                        if (this.current?.client === client) {
                            // Allow the language client to unregister the disconnected providers first.
                            setTimeout(
                                () =>
                                    this.reportFailure(
                                        client,
                                        new Error('The webR worker disconnected.'),
                                    ),
                                0,
                            );
                        }
                        return { action: CloseAction.DoNotRestart, handled: true };
                    },
                },
            },
        );
        this.current = { client, abort };
        void this.stopping
            .then(async () => {
                if (this.current?.client === client) {
                    await client.start();
                }
            })
            .catch((error) => this.reportFailure(client, error));
    }

    private reportFailure(client: LanguageClient, error: unknown): void {
        if (this.current?.client !== client) {
            return;
        }
        this.stopClient();
        this.output.appendLine(String(error));
        void vscode.window
            .showErrorMessage(
                `The webR language server could not continue: ${String(error)}`,
                'Retry',
            )
            .then((action) => {
                if (action === 'Retry') {
                    this.refresh();
                }
            });
    }

    private stopClient(): void {
        const current = this.current;
        this.current = undefined;
        if (current) {
            if (current.client.state !== State.Running) {
                current.abort.abort();
                current.session?.close();
            }
            const disposing = current.client
                .dispose()
                .catch(() => {})
                .finally(() => {
                    current.session?.close();
                    current.abort.abort();
                });
            this.stopping = Promise.all([this.stopping, disposing]).then(() => {});
        }
    }

    dispose(): void {
        this.stopped = true;
        this.stopClient();
        for (const listener of this.listeners) {
            listener.dispose();
        }
        void this.stopping.then(() => this.output.dispose());
    }
}
