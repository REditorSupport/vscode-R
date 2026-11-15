import {
    ARF_METHOD_NOT_FOUND,
    ARF_TIMEOUT,
    ArfRpcError,
    arfRequest,
    checkArfSession,
} from '../arf';
import { ArfAttachConnection, ArfEvent } from '../arfAttach';
import { BackendEvent } from '../backend';
import { object, Submission } from '../protocol';
import { RuntimeProcess } from './process';
import { rString } from './rCode';
import { ArfOutput } from './arfOutput';

/** Topic that sess publishes before running submitted code under arf. */
const STARTED_TOPIC = 'vscode-r.interactive.started';

/** The submission sent to arf, and arf's execution ID once known. */
interface Execution {
    submission: string;
    id?: number;
    interruptRequested: boolean;
}

export class Arf {
    readonly process: RuntimeProcess;
    ready = false;
    private abort = new AbortController();
    private started = false;
    private attach?: ArfAttachConnection;
    private sessionId?: string;
    private execution?: Execution;
    private failure?: Error;
    private stopping?: Promise<void>;
    constructor(
        private command: string,
        private directory: string,
        private endpoint: string | undefined,
        adopted: boolean,
        private emit: (event: BackendEvent) => void,
        private token: string,
        private event: (message: Record<string, unknown>, channel: string) => void,
    ) {
        this.process = new RuntimeProcess(adopted, emit);
    }
    markStarted(): void {
        this.started = true;
    }
    async start(bootstrap: string, env: NodeJS.ProcessEnv): Promise<void> {
        if (!this.process.adopted) {
            const output = new Map(
                ['stdout', 'stderr'].map((channel) => [
                    channel,
                    new ArfOutput(
                        this.token,
                        (text) => {
                            if (text) {
                                this.emit({ type: 'stream', text, channel });
                            }
                        },
                        (message) => this.event(message, channel),
                    ),
                ]),
            );
            this.endpoint = await new Promise<string>((resolve, reject) => {
                let readiness = '';
                const timer = setTimeout(
                    () => reject(new Error('arf did not report its IPC endpoint')),
                    30000,
                );
                const child = this.process.launch(
                    this.command,
                    ['headless', '--json'],
                    this.directory,
                    env,
                    (text, channel) => {
                        if (channel === 'stdout' && !this.endpoint) {
                            readiness += text;
                            let newline: number;
                            while (!this.endpoint && (newline = readiness.indexOf('\n')) >= 0) {
                                const line = readiness.slice(0, newline);
                                readiness = readiness.slice(newline + 1);
                                let info: Record<string, unknown> | undefined;
                                try {
                                    info = object(JSON.parse(line));
                                } catch {
                                    /* Profiles can print before readiness. */
                                }
                                if (typeof info?.socket_path === 'string') {
                                    this.endpoint = info.socket_path;
                                    clearTimeout(timer);
                                    resolve(this.endpoint);
                                } else {
                                    this.emit({ type: 'stream', text: line + '\n', channel });
                                }
                            }
                            if (this.endpoint || readiness.length > 65536) {
                                if (readiness) {
                                    output.get(channel)!.push(readiness);
                                }
                                readiness = '';
                            }
                        } else {
                            try {
                                output.get(channel)!.push(text);
                            } catch (error) {
                                this.emit({ type: 'unavailable', message: String(error) });
                            }
                        }
                    },
                );
                child.once('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once('exit', () => {
                    clearTimeout(timer);
                    reject(new Error('arf exited during startup'));
                });
            });
        }
        if (!this.endpoint) {
            throw new Error('Missing arf endpoint');
        }
        // Subscribe before submitting anything so that no started event is missed.
        // EXPERIMENT: no attach, to isolate a macOS fork failure.
        const metadata = object(
            await arfRequest(this.endpoint, 'session', {}, 30000, this.abort.signal),
        );
        checkArfSession(metadata);
        this.emit({
            type: 'provider',
            data: {
                provider: this.process.adopted ? 'arf-existing' : 'arf',
                policy: metadata.ipc_policy,
            },
        });
        // Visible evaluation respects arf's advertised IPC policy, including bootstrap.
        const result = object(
            await arfRequest(
                this.endpoint,
                'evaluate',
                { code: bootstrap, visible: true },
                30000,
                this.abort.signal,
            ),
        );
        // A missing or unknown status is not a successful bootstrap.
        if (result.status !== 'ok') {
            const detail =
                typeof result.error === 'string' && result.error
                    ? result.error
                    : typeof result.stderr === 'string' && result.stderr.trim()
                      ? result.stderr.trim()
                      : `status ${JSON.stringify(result.status ?? null)}`;
            throw new Error(`Interactive bootstrap failed in arf: ${detail}`);
        }
    }
    private async connect(): Promise<Record<string, unknown>> {
        const { connection, result } = await ArfAttachConnection.open(this.endpoint!, {
            subscribe: [STARTED_TOPIC],
            client: { name: 'vscode-R Interactive' },
            onEvent: (event) => this.arfEvent(event),
        });
        if (this.sessionId !== undefined && result.sessionId !== this.sessionId) {
            connection.close();
            throw new Error('The arf endpoint now belongs to a different session');
        }
        this.sessionId = result.sessionId;
        this.attach = connection;
        return result.session;
    }
    dispose(): void {
        this.abort.abort();
        this.attach?.close();
        this.process.dispose();
    }
    /** Called once sess reports that a submission finished. */
    finished(submission: string): void {
        if (this.execution?.submission === submission) {
            this.execution = undefined;
        }
    }
    async interrupt(): Promise<void> {
        const execution = this.execution;
        if (!execution) {
            // TODO: Interrupt slow inspection through execution deadlines of
            // handler calls; sess runs it where arf does not deliver interrupts.
            throw new Error('No submitted code is running');
        }
        execution.interruptRequested = true;
        if (execution.id !== undefined) {
            await this.sendInterrupt(execution);
        } else if (this.attach?.closed) {
            throw new Error(
                'Cannot interrupt: the connection to arf was lost before the execution started',
            );
        }
        // Otherwise the request is sent once arf reports the execution ID.
    }
    private async sendInterrupt(execution: Execution): Promise<void> {
        if (this.execution !== execution || execution.id === undefined) {
            return;
        }
        // Acceptance only registers the request; sess reports the outcome. A
        // rejection means the execution already ended, which races with Stop.
        await arfRequest(this.endpoint!, 'interrupt', { execution_id: execution.id }, 5000);
    }
    /** Records arf's execution ID for a submission, from its reply or its started event. */
    private register(submission: unknown, id: unknown): void {
        const execution = this.execution;
        if (!execution || execution.submission !== submission) {
            return;
        }
        if (!Number.isSafeInteger(id) || (id as number) < 0) {
            this.fail(new Error('arf reported an invalid execution ID'));
            return;
        }
        if (execution.id === undefined) {
            execution.id = id as number;
            if (execution.interruptRequested) {
                void this.sendInterrupt(execution).catch((error: Error) =>
                    this.emit({ type: 'error', message: error.message }),
                );
            }
        } else if (execution.id !== id) {
            this.fail(new Error('arf reported conflicting execution IDs for one submission'));
        }
    }
    private arfEvent(event: ArfEvent): void {
        if (event.topic !== STARTED_TOPIC) {
            return;
        }
        const data = event.data;
        const submission =
            data && typeof data === 'object' ? (data as Record<string, unknown>).id : undefined;
        this.register(submission, event.execution);
    }
    private fail(error: Error): void {
        this.failure ??= error;
        this.emit({ type: 'unavailable', message: error.message });
    }
    stop(force = false): Promise<void> {
        return (this.stopping ??= this.stopRuntime(force).finally(() => {
            this.stopping = undefined;
        }));
    }
    private async stopRuntime(force: boolean): Promise<void> {
        if (!this.process.alive()) {
            this.process.markExited();
            return;
        }
        if (force) {
            await this.kill(undefined, 0);
            return;
        }
        if (!this.endpoint) {
            if (this.process.adopted) {
                throw new Error('The arf endpoint is unknown');
            }
            await this.kill('SIGTERM', 3000);
            return;
        }
        try {
            await arfRequest(this.endpoint, 'shutdown', {}, 5000);
        } catch (error) {
            if (
                this.process.adopted &&
                error instanceof ArfRpcError &&
                error.code === ARF_METHOD_NOT_FOUND
            ) {
                // An interactive arf rejects shutdown; stop it as a terminal would.
                await this.kill('SIGTERM', 3000);
                return;
            }
            if (!this.process.adopted) {
                // The managed process is ours even if its IPC no longer answers.
                await this.kill('SIGTERM', 3000);
                return;
            }
            throw error;
        }
        // Acceptance only starts shutdown, and running R code may delay it.
        await this.kill(undefined, 5000);
    }
    /** Sends `first`, waits up to `grace` ms, then kills; resolves after a confirmed exit. */
    private async kill(first: NodeJS.Signals | undefined, grace: number): Promise<void> {
        if (first) {
            this.process.send(first);
        }
        if (await this.process.waitForExit(grace)) {
            return;
        }
        this.process.send('SIGKILL');
        if (!(await this.process.waitForExit(2000))) {
            throw new Error('R has not exited after Stop');
        }
    }
    async dispatch(submission: Submission): Promise<void> {
        if (this.failure) {
            throw this.failure;
        }
        // EXPERIMENT: no attach.
        const code = `sess:::interactive_execute(${rString(submission.id)}, ${rString(submission.code)}, jsonlite::fromJSON(${rString(JSON.stringify(submission.source ?? null))}, simplifyVector=FALSE))`;
        this.started = false;
        this.execution = { submission: submission.id, interruptRequested: false };
        // Managed sessions use send to avoid arf's unbounded evaluation capture.
        // R's ordered events establish the outcome even if arf's reply times out.
        let result: Record<string, unknown>;
        try {
            result = object(
                await arfRequest(
                    this.endpoint!,
                    this.process.adopted ? 'evaluate' : 'user_input',
                    { code, visible: true, timeout_ms: 86400000 },
                    0,
                    this.abort.signal,
                ),
            );
        } catch (error) {
            // A server timeout does not cancel R. Keep accepting its event stream.
            // Other transport failures remain ambiguous and must block dispatch.
            if (
                !this.process.adopted &&
                this.started &&
                error instanceof ArfRpcError &&
                error.code === ARF_TIMEOUT
            ) {
                return;
            }
            if (!this.started) {
                this.finished(submission.id);
            }
            throw error;
        }
        this.register(submission.id, result.execution_id);
        if (this.process.adopted) {
            for (const channel of ['stdout', 'stderr']) {
                if (typeof result[channel] === 'string' && result[channel]) {
                    this.emit({ type: 'stream', text: result[channel], channel });
                }
            }
        }
        if (result.error || result.accepted === false) {
            throw new Error(
                typeof result.error === 'string'
                    ? result.error
                    : 'arf rejected Interactive execution',
            );
        }
    }
}
