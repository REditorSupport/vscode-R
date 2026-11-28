import * as vscode from 'vscode';
import { Message } from 'vscode-jsonrpc';
import {
    CloseAction,
    type DocumentFilter,
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

const interactiveType = 'r-interactive';
const rLanguages = ['r', 'rmd'];

interface ClientSlot {
    client: LanguageClient;
    abort: AbortController;
    selector: string;
    session?: WebRLanguageSession;
}

/** A notebook filter is matched against the owning notebook URI, not the cell URI. */
function notebookSelector(notebook: vscode.NotebookDocument): DocumentFilter[] {
    const pattern = notebook.uri.fsPath.replace(/[?*{}[\]]/g, (char) => `[${char}]`);
    return rLanguages.map((language) => ({
        language,
        notebook: { notebookType: interactiveType, scheme: notebook.uri.scheme, pattern },
    }));
}

/** The provider selector matches fsPath. Virtual notebooks can also differ only
 * in URI authority or query. Keep their text and requests in the owning worker.
 */
function notebookSession(owner: vscode.Uri, session: WebRLanguageSession): WebRLanguageSession {
    return {
        close: () => session.close(),
        dispatch(message) {
            if (Message.isRequest(message) || Message.isNotification(message)) {
                const params = message.params as { textDocument?: { uri?: unknown } } | undefined;
                if (typeof params?.textDocument?.uri === 'string') {
                    const cell = vscode.Uri.parse(params.textDocument.uri);
                    if (
                        cell.scheme !== 'vscode-notebook-cell' ||
                        cell.authority !== owner.authority ||
                        cell.path !== owner.path ||
                        cell.query !== owner.query
                    ) {
                        return Promise.resolve(
                            Message.isRequest(message)
                                ? [{ jsonrpc: '2.0', id: message.id, result: null }]
                                : [],
                        );
                    }
                }
            }
            return session.dispatch(message);
        },
    };
}

export class BrowserLanguageService implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('R Language Server', { log: true });
    private readonly listeners: vscode.Disposable[];
    private readonly clients = new Map<string, ClientSlot>();
    private stopped = false;
    private stopping = Promise.resolve();
    private nativePreferenceReported = false;

    constructor(private readonly storage: vscode.Uri) {
        this.listeners = [
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (rLanguages.includes(doc.languageId)) {
                    this.refresh();
                }
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                if (rLanguages.includes(doc.languageId)) {
                    this.refresh();
                }
            }),
            vscode.workspace.onDidOpenNotebookDocument(() => this.refresh()),
            vscode.workspace.onDidCloseNotebookDocument((doc) =>
                this.stopClient(doc.uri.toString()),
            ),
            vscode.workspace.onDidChangeNotebookDocument((event) => {
                if (event.contentChanges.length) {
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
        const desired = new Map<string, DocumentFilter[]>();
        if (settings.get('lsp.enabled', true)) {
            const sources = new Set<string>();
            const otherNotebooks = new Set<string>();
            for (const doc of vscode.workspace.textDocuments) {
                if (
                    rLanguages.includes(doc.languageId) &&
                    doc.uri.scheme !== 'vscode-notebook-cell'
                ) {
                    sources.add(doc.uri.scheme);
                }
            }
            for (const notebook of vscode.workspace.notebookDocuments) {
                if (
                    !notebook
                        .getCells()
                        .some((cell) => rLanguages.includes(cell.document.languageId))
                ) {
                    continue;
                }
                if (notebook.notebookType === interactiveType) {
                    desired.set(notebook.uri.toString(), notebookSelector(notebook));
                } else {
                    otherNotebooks.add(notebook.notebookType);
                }
            }
            if (settings.get<string>('lsp.runtime') === 'native') {
                if (!this.nativePreferenceReported && (sources.size || otherNotebooks.size)) {
                    this.nativePreferenceReported = true;
                    this.output.appendLine(
                        'R Interactive notebooks use webR. Set r.lsp.runtime to auto or webR to enable language features for other R documents in the browser.',
                    );
                }
            } else {
                this.nativePreferenceReported = false;
                if (sources.size || otherNotebooks.size) {
                    // Keep one project client across ordinary virtual files and untitled editors.
                    // Notebook cells have their own selectors, so an Interactive session cannot
                    // leak its symbols into source completions or another session.
                    const selector: DocumentFilter[] = [];
                    for (const scheme of [...sources].sort()) {
                        selector.push(...rLanguages.map((language) => ({ language, scheme })));
                    }
                    for (const notebook of [...otherNotebooks].sort()) {
                        selector.push(...rLanguages.map((language) => ({ language, notebook })));
                    }
                    desired.set('source', selector);
                }
            }
        }
        for (const [key, active] of this.clients) {
            if (JSON.stringify(desired.get(key)) !== active.selector) {
                this.stopClient(key);
            }
        }
        for (const [key, selector] of desired) {
            if (!this.clients.has(key)) {
                this.startClient(key, selector);
            }
        }
    }

    private startClient(key: string, selector: DocumentFilter[]): void {
        const abort = new AbortController();
        const client: LanguageClient = new WorkerLanguageClient(
            key === 'source' ? 'r' : 'r:' + key,
            'R Language Server',
            async () => {
                const session = await createWebRLanguageSession({
                    baseUrl: WEBR_BASE_URL,
                    signal: abort.signal,
                    loadAsset: cachedWebRAssets(this.storage),
                });
                const current = this.clients.get(key);
                if (abort.signal.aborted || current?.client !== client) {
                    session.close();
                    throw new Error('The webR language service was stopped.');
                }
                current.session = session;
                return createWebRMessageTransports(
                    key === 'source' ? session : notebookSession(vscode.Uri.parse(key), session),
                );
            },
            {
                documentSelector: selector,
                outputChannel: this.output,
                revealOutputChannelOn: RevealOutputChannelOn.Never,
                initializationFailedHandler: () => false,
                errorHandler: {
                    error: () => ({ action: ErrorAction.Continue }),
                    closed: () => {
                        if (this.clients.get(key)?.client === client) {
                            setTimeout(
                                () =>
                                    this.reportFailure(
                                        key,
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
        this.clients.set(key, { client, abort, selector: JSON.stringify(selector) });
        void this.stopping
            .then(async () => {
                if (this.clients.get(key)?.client === client) {
                    await client.start();
                }
            })
            .catch((error) => this.reportFailure(key, client, error));
    }

    private reportFailure(key: string, client: LanguageClient, error: unknown): void {
        if (this.clients.get(key)?.client !== client) {
            return;
        }
        this.stopClient(key);
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

    private stopClient(key: string): void {
        const current = this.clients.get(key);
        if (!current) {
            return;
        }
        this.clients.delete(key);
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

    dispose(): void {
        this.stopped = true;
        for (const key of this.clients.keys()) {
            this.stopClient(key);
        }
        for (const listener of this.listeners) {
            listener.dispose();
        }
        void this.stopping.then(() => this.output.dispose());
    }
}
