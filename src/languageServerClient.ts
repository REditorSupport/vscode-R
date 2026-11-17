import { ErrorAction, LanguageClient, State } from 'vscode-languageclient/node';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import type { Socket } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { DisposableProcess } from './util';

/** Transport errors that mean the peer closed or reset the connection. */
const DISCONNECTS = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_DESTROYED']);

function disconnectCode(error: unknown): string | undefined {
    const code =
        error && typeof error === 'object' && 'code' in error
            ? (error as { code: unknown }).code
            : undefined;
    return typeof code === 'string' && DISCONNECTS.has(code) ? code : undefined;
}

function cancelledStartup(): Error {
    const error = new Error('R language server startup was cancelled.');
    error.name = 'AbortError';
    return error;
}

/** Own R and its transport until initialization finishes, and during shutdown. */
class StartupResources {
    readonly cancellation = new AbortController();
    private readonly releases: Array<() => void> = [];
    private readonly exits: Promise<void>[] = [];
    /** Owned server processes and whether each has closed. */
    private readonly processes = new Map<ChildProcess, boolean>();
    private disposed = false;
    /** Set when stop() begins for the connection these resources belong to. */
    stopRequested = false;
    /** The exit notification is written only after shutdown was answered. */
    exitSent = false;
    stopping?: Promise<void>;

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

    watchProcess(child: ChildProcess): void {
        if (this.disposed || this.processes.has(child)) {
            return;
        }
        const exited = child.exitCode !== null || child.signalCode !== null;
        this.processes.set(child, exited);
        if (exited) {
            return;
        }
        this.exits.push(
            new Promise<void>((resolve) => {
                const closed = () => {
                    this.processes.set(child, true);
                    resolve();
                };
                child.once('close', closed);
                this.own(() => child.removeListener('close', closed));
            }),
        );
    }

    /** Waits briefly for owned processes; true if there is one and all of them closed. */
    async waitForExit(): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        try {
            // shutdown()/exit() acknowledge transport writes, not process exit.
            // Let cooperative R servers clean up their workers before forcing
            // transport/process disposal, matching the node client's grace.
            await Promise.race([
                Promise.all(this.exits),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 2000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        return this.processes.size > 0 && [...this.processes.values()].every(Boolean);
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
        const handler = this.clientOptions.errorHandler!;
        this.clientOptions.errorHandler = {
            error: (error, message, count) => {
                // A server can close its end once it has answered shutdown.
                // That is the requested outcome, not a failure to report.
                const code = disconnectCode(error);
                if (code && this.resources?.stopRequested) {
                    this.outputChannel.appendLine(
                        `The R language server connection closed while stopping (${code}).`,
                    );
                    return { action: ErrorAction.Continue, handled: true };
                }
                return handler.error(error, message, count);
            },
            closed: () => handler.closed(),
        };
    }

    override start(): Promise<void> {
        if (this.starting || this.isRunning()) {
            return this.starting ?? super.start();
        }
        if (this.state === State.Starting && this.resources?.cancellation.signal.aborted) {
            return Promise.reject(cancelledStartup());
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
        let aborted!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => {
            aborted = () => reject(cancelledStartup());
            resources.cancellation.signal.addEventListener('abort', aborted, { once: true });
        });
        const operation = super.start();
        const initialized = super.start();
        const starting = Promise.race([Promise.all([operation, initialized]), cancelled])
            .then(
                () => resources.finishStartup(),
                (error: unknown) => {
                    resources.dispose();
                    throw error;
                },
            )
            .finally(() => {
                resources.cancellation.signal.removeEventListener('abort', aborted);
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
            this.resources.watchProcess(child);
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
        const resources = this.resources;
        const transports = await super.createMessageTransports(encoding);
        const write = transports.writer.write.bind(transports.writer);
        transports.writer.write = (message) => {
            if (resources && 'method' in message && message.method === 'exit') {
                resources.exitSent = true;
            }
            return write(message);
        };
        // Executable-based stdio starts inside LanguageClient. Its public process
        // handle is available once transports exist, before initialize is sent.
        const child = this.serverProcess;
        if (child) {
            resources?.watchProcess(child);
            resources?.own(() => {
                child.stdout?.destroy();
                child.stdin?.destroy();
                child.kill('SIGKILL');
            });
        }
        resources?.throwIfCancelled();
        return transports;
    }

    override stop(timeout?: number): Promise<void> {
        const resources = this.resources;
        if (this.state === State.Starting || this.state === State.StartFailed) {
            // LanguageClient's initialization failure handler also calls stop().
            // Its base implementation rejects in these states; closing owned
            // transports instead lets the pending initialize request reject.
            resources?.dispose();
            return Promise.resolve();
        }
        if (!resources) {
            return super.stop(timeout);
        }
        return (resources.stopping ??= this.stopRunning(resources, timeout));
    }

    private async stopRunning(resources: StartupResources, timeout?: number): Promise<void> {
        resources.stopRequested = true;
        try {
            try {
                await super.stop(timeout);
            } catch (error) {
                // R's languageserver exits once it answers shutdown, so writing
                // the exit notification can fail. That still stopped the server
                // if it answered shutdown and its process closed by itself.
                const code = disconnectCode(error);
                if (!code || !resources.exitSent || !(await resources.waitForExit())) {
                    throw error;
                }
                this.outputChannel.appendLine(
                    `The R language server exited after answering shutdown, before the exit notification (${code}).`,
                );
                return;
            }
            await resources.waitForExit();
        } finally {
            resources.dispose();
        }
    }
}
