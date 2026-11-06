import { LanguageClient, State } from 'vscode-languageclient/node';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import type { Socket } from 'node:net';
import type { DisposableProcess } from './util';

function cancelledStartup(): Error {
    const error = new Error('R language server startup was cancelled.');
    error.name = 'AbortError';
    return error;
}

/** Own R and its transport until initialization finishes, and during shutdown. */
class StartupResources {
    readonly cancellation = new AbortController();
    private readonly releases: Array<() => void> = [];
    private disposed = false;

    constructor(
        private readonly parent: AbortSignal,
        private readonly reportError: (error: unknown) => void,
    ) {
        parent.addEventListener('abort', this.dispose, { once: true });
        if (parent.aborted) {
            this.dispose();
        }
    }

    own(release: () => void): () => void {
        let released = false;
        const once = () => {
            if (released) {
                return;
            }
            released = true;
            try {
                release();
            } catch (error) {
                this.reportError(error);
            }
        };
        if (this.disposed) {
            once();
        } else {
            this.releases.push(once);
        }
        return once;
    }

    finishStartup(): void {
        this.throwIfCancelled();
        // Running clients retain their resources for stop(), which first sends
        // the normal shutdown/exit requests rather than interrupting them.
        this.parent.removeEventListener('abort', this.dispose);
    }

    throwIfCancelled(): void {
        if (this.disposed) {
            throw cancelledStartup();
        }
    }

    readonly dispose = (): void => {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.parent.removeEventListener('abort', this.dispose);
        this.cancellation.abort();
        this.releases
            .splice(0)
            .reverse()
            .forEach((release) => release());
    };
}

export class CancellableLanguageClient extends LanguageClient {
    private resources?: StartupResources;
    private starting?: Promise<void>;

    constructor(
        id: string,
        name: string,
        serverOptions: ServerOptions,
        clientOptions: LanguageClientOptions,
        private readonly cancellation: AbortSignal,
    ) {
        super(id, name, serverOptions, clientOptions);
    }

    override start(): Promise<void> {
        if (this.starting || this.isRunning()) {
            return this.starting ?? super.start();
        }
        const resources = new StartupResources(this.cancellation, (error) =>
            this.outputChannel.appendLine(`Failed to release language server: ${String(error)}`),
        );
        this.resources = resources;
        if (this.cancellation.aborted) {
            return Promise.reject(cancelledStartup());
        }
        // v10's connection-close handler can clear its shared start promise
        // before initialize rejects. Its idempotent second call snapshots that
        // promise, so both it and the outer startup operation stay observed.
        const operation = super.start();
        const initialized = super.start();
        const starting = Promise.all([operation, initialized])
            .then(
                () => resources.finishStartup(),
                (error: unknown) => {
                    resources.dispose();
                    throw error;
                },
            )
            .finally(() => {
                if (this.starting === starting) {
                    this.starting = undefined;
                }
            });
        this.starting = starting;
        return starting;
    }

    get startupSignal(): AbortSignal {
        return this.resources?.cancellation.signal ?? this.cancellation;
    }

    ownProcess(child: DisposableProcess): DisposableProcess {
        if (this.resources) {
            child.dispose = this.resources.own(child.dispose.bind(child));
        }
        return child;
    }

    ownSocket(socket: Socket): void {
        this.resources?.own(() => socket.destroy());
    }

    cancelStartup(): void {
        this.resources?.dispose();
    }

    protected override async createMessageTransports(encoding: string) {
        const transports = await super.createMessageTransports(encoding);
        // Executable-based stdio starts inside LanguageClient. Its public process
        // handle is available once transports exist, before initialize is sent.
        const child = this.serverProcess;
        if (child) {
            this.resources?.own(() => {
                child.stdout?.destroy();
                child.stdin?.destroy();
                child.kill('SIGKILL');
            });
        }
        this.resources?.throwIfCancelled();
        return transports;
    }

    override async stop(timeout?: number): Promise<void> {
        const resources = this.resources;
        if (this.state === State.Starting || this.state === State.StartFailed) {
            // LanguageClient's initialization failure handler also calls stop().
            // Its base implementation rejects in these states; closing owned
            // transports instead lets the pending initialize request reject.
            resources?.dispose();
            return;
        }
        try {
            await super.stop(timeout);
        } finally {
            resources?.dispose();
        }
    }
}
