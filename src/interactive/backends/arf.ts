import { setTimeout as delay } from 'timers/promises';
import {
    ARF_METHOD_NOT_FOUND,
    ARF_TIMEOUT,
    ArfRpcError,
    arfRequest,
    checkArfSession,
} from '../arf';
import { ArfAttachConnection, ArfEvent } from '../arfAttach';
import {
    BackendEvent,
    DispatchNotSentError,
    InspectionRequest,
    StopRefusedError,
} from '../backend';
import { MAX_MESSAGE_BYTES, object, Submission } from '../protocol';
import { RuntimeProcess } from './process';
import { rString } from './rCode';
import { ArfOutput } from './arfOutput';
import {
    ArfHandlerApi,
    CallLimits,
    InspectionCalls,
    inspectionCallsAvailable,
    parseHandlerApi,
} from './arfInspection';

/** Topic that sess publishes before running submitted code under arf. */
const STARTED_TOPIC = 'vscode-r.interactive.started';

/**
 * Longest line accepted on the attach connection. A handler's result is
 * limited to MAX_MESSAGE_BYTES before it is sent as a JSON string, which can
 * escape every character once more.
 */
const MAX_ATTACH_LINE_BYTES = 8 * MAX_MESSAGE_BYTES;

/** The submission sent to arf, and arf's execution ID once known. */
interface Execution {
    submission: string;
    id?: number;
    interruptRequested: boolean;
    /** For an adopted session, the attach connection that sent the code. */
    connection?: ArfAttachConnection;
}

export class Arf {
    readonly process: RuntimeProcess;
    ready = false;
    private abort = new AbortController();
    private started = false;
    private attach?: ArfAttachConnection;
    private attaching?: Promise<Record<string, unknown>>;
    private handlerApi?: ArfHandlerApi;
    private inspections = new InspectionCalls((selector, args, limits) =>
        this.callHandler(selector, args, limits),
    );
    private sessionId?: string;
    private execution?: Execution;
    private failure?: Error;
    private stopping?: Promise<void>;
    /**
     * Set when a Stop found that the endpoint no longer reaches this session:
     * code is then sent only after a new connection reaches it again.
     */
    private reverify = false;
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
    /**
     * `expose` is the R expression that arf evaluates, after the R profiles,
     * to publish handlers. It applies only when this adapter starts arf.
     */
    async start(env: NodeJS.ProcessEnv, expose?: string): Promise<void> {
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
                    ['headless', '--json', ...(expose ? ['--ipc-expose', expose] : [])],
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
        const metadata = await this.connect();
        checkArfSession(metadata);
        // The published table must match the selectors that inspection calls.
        if (!this.process.adopted && !this.callsInspection()) {
            throw new Error('arf did not publish the R Interactive inspection handlers');
        }
        this.emit({
            type: 'provider',
            data: {
                provider: this.process.adopted ? 'arf-existing' : 'arf',
                policy: metadata.ipc_policy,
            },
        });
    }
    /** Read the running R installation and its current library order, including changes before adoption. */
    async rEnvironment(): Promise<{ libraryPaths: string[]; rHome?: string }> {
        const deadline = Date.now() + 30000;
        for (;;) {
            const timeout = Math.max(1, Math.min(15000, deadline - Date.now()));
            // The attach connection reached the verified session; a new
            // connection to its socket path could reach another arf.
            const attach = await this.attached();
            const session = object(
                await attach.request('session', {}, { timeout, signal: this.abort.signal }),
            );
            const libraries = session.r && object(session.r).lib_paths;
            if (
                Array.isArray(libraries) &&
                libraries.length &&
                libraries.every((p: unknown): p is string => typeof p === 'string' && p.length > 0)
            ) {
                return {
                    libraryPaths: libraries,
                    rHome: typeof session.r_home === 'string' ? session.r_home : undefined,
                };
            }
            const reason =
                typeof session.r_unavailable_reason === 'string'
                    ? session.r_unavailable_reason
                    : 'arf returned no library paths';
            // An adopted R may still be evaluating the user's previous command.
            // arf then returns a successful response containing only its own metadata.
            if (
                !this.process.adopted ||
                session.r !== null ||
                !/busy evaluating|pending|timed out collecting R session information/i.test(
                    reason,
                ) ||
                Date.now() + 250 >= deadline
            ) {
                throw new Error(`Could not read R library paths for jgd: ${reason}`);
            }
            await delay(250, undefined, { signal: this.abort.signal });
        }
    }
    async bootstrap(code: string): Promise<void> {
        // Visible evaluation respects arf's advertised IPC policy, including
        // bootstrap. It goes over the attach connection, which reached the
        // verified arf, rather than a new connection to its socket path.
        const attach = await this.attached();
        const result = object(
            await attach.request(
                'evaluate',
                { code, visible: true },
                { timeout: 30000, signal: this.abort.signal },
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
    /** Attaches, or joins an attach that is already in progress. */
    private connect(): Promise<Record<string, unknown>> {
        return (this.attaching ??= this.attachOnce().finally(() => {
            this.attaching = undefined;
        }));
    }
    private async attachOnce(): Promise<Record<string, unknown>> {
        const { connection, result } = await ArfAttachConnection.open(this.endpoint!, {
            subscribe: [STARTED_TOPIC],
            client: { name: 'vscode-R Interactive' },
            maxLineBytes: MAX_ATTACH_LINE_BYTES,
            onEvent: (event) => this.arfEvent(event),
        });
        if (this.sessionId !== undefined && result.sessionId !== this.sessionId) {
            connection.close();
            throw new Error('The arf endpoint now belongs to a different session');
        }
        if (this.abort.signal.aborted) {
            connection.close();
            throw new Error('arf adapter was disposed');
        }
        this.sessionId = result.sessionId;
        this.attach = connection;
        this.handlerApi = parseHandlerApi(result.session);
        return result.session;
    }
    /** A separate attach connection that reaches the same arf session as before. */
    private async verifiedConnection(): Promise<ArfAttachConnection> {
        const { connection, result } = await ArfAttachConnection.open(this.endpoint!, {
            subscribe: [],
            client: { name: 'vscode-R Interactive' },
            timeout: 5000,
            maxLineBytes: MAX_ATTACH_LINE_BYTES,
            onEvent: () => undefined,
        });
        if (result.sessionId !== this.sessionId) {
            connection.close();
            throw new Error('The arf endpoint now belongs to a different session');
        }
        return connection;
    }
    /** The attach connection, reattaching to the same session if it was lost. */
    private async attached(): Promise<ArfAttachConnection> {
        if (!this.attach || this.attach.closed) {
            await this.connect();
        }
        return this.attach!;
    }
    /**
     * Whether inspection uses handler calls, which stop at their execution
     * deadline, rather than the sess socket, which cannot be interrupted.
     */
    callsInspection(): boolean {
        return inspectionCallsAvailable(this.handlerApi);
    }
    /** Runs an inspection as a handler call with the request's execution deadline. */
    inspect(request: InspectionRequest): Promise<unknown> {
        return this.inspections.request(request);
    }
    private async callHandler(
        selector: string,
        args: string,
        limits: CallLimits,
    ): Promise<unknown> {
        // A long-lived connection drops a call that has not started when it
        // closes, so disposal does not leave inspections queued in R.
        const connection = await this.attached();
        return connection.request(
            'call',
            {
                handler: selector,
                args,
                queue_timeout_ms: limits.queue,
                execution_timeout_ms: limits.execution,
            },
            { timeout: limits.transport, signal: this.abort.signal },
        );
    }
    dispose(): void {
        this.abort.abort();
        this.inspections.close(new Error('R session was disposed'));
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
            // Inspection is stopped by its execution deadline, not by this request.
            throw new Error('No submitted code is running');
        }
        execution.interruptRequested = true;
        if (execution.id !== undefined) {
            await this.sendInterrupt(execution);
        } else if ((execution.connection ?? this.attach)?.closed) {
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
        // An adopted execution is interrupted on the connection that started
        // it: its ID belongs to that arf, which the socket path may no longer
        // reach.
        const params = { execution_id: execution.id };
        if (!execution.connection) {
            await arfRequest(this.endpoint!, 'interrupt', params, 5000);
            return;
        }
        if (execution.connection.closed) {
            throw new Error('Cannot interrupt: the connection to arf that runs the code was lost');
        }
        await execution.connection.request('interrupt', params, { timeout: 5000 });
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
        if (this.process.adopted) {
            await this.stopAdopted(force);
            return;
        }
        if (force) {
            await this.kill(undefined, 0);
            return;
        }
        if (!this.endpoint) {
            await this.kill('SIGTERM', 3000);
            return;
        }
        try {
            await arfRequest(this.endpoint, 'shutdown', {}, 5000);
        } catch {
            // The managed process is ours even if its IPC no longer answers.
            await this.kill('SIGTERM', 3000);
            return;
        }
        // Acceptance only starts shutdown, and running R code may delay it.
        await this.kill(undefined, 5000);
    }
    /**
     * An adopted arf is only asked to shut down. Its process is never
     * terminated: an interactive arf would not restore its terminal or finish
     * R's exit, and its PID may have been reused.
     */
    private async stopAdopted(force: boolean): Promise<void> {
        if (force) {
            throw new StopRefusedError('An attached arf session cannot be stopped forcibly');
        }
        if (!this.endpoint) {
            throw new StopRefusedError('The arf endpoint is unknown');
        }
        // Shut down only the adopted arf: a socket path can be bound by another
        // session while the adopted R is still alive. A new connection is
        // verified first, so that a failure to reach arf is known to have
        // sent nothing, as when IPC is stopped while R keeps running.
        let connection: ArfAttachConnection;
        try {
            connection = await this.verifiedConnection();
        } catch (error) {
            this.reverify = true;
            throw new StopRefusedError(
                `arf could not receive the shutdown request: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        try {
            await connection.request('shutdown', {}, { timeout: 5000 });
        } catch (error) {
            if (error instanceof ArfRpcError && error.code === ARF_METHOD_NOT_FOUND) {
                throw new StopRefusedError(
                    'This arf session runs in a terminal and cannot be stopped from VS Code. End R in the terminal that started arf.',
                );
            }
            if (error instanceof ArfRpcError) {
                throw new StopRefusedError(
                    `arf did not accept the shutdown request: ${error.message}`,
                );
            }
            // Without an answer, arf may or may not have accepted it.
            throw error;
        } finally {
            connection.close();
        }
        // Acceptance only starts shutdown, and running R code may delay it.
        // The process monitor reports a later exit.
        if (!(await this.process.waitForExit(5000))) {
            throw new Error('arf accepted the shutdown request but has not exited yet');
        }
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
    async dispatch(submission: Submission, signal?: AbortSignal): Promise<void> {
        if (this.failure) {
            throw this.failure;
        }
        // The previous execution has finished, so attaching again loses no
        // state; the session must still be the same arf process.
        let connection: ArfAttachConnection;
        try {
            if (this.reverify) {
                // The next attach verifies the session again.
                this.attach?.close();
            }
            connection = await this.attached();
            this.reverify = false;
        } catch (error) {
            throw new DispatchNotSentError(
                `arf could not be reached: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (this.process.adopted && connection.closed) {
            // The request would be rejected before it is written.
            throw new DispatchNotSentError(
                `arf could not be reached: ${connection.closed.message}`,
            );
        }
        const code = `sess:::interactive_execute(${rString(submission.id)}, ${rString(submission.code)}, jsonlite::fromJSON(${rString(JSON.stringify(submission.source ?? null))}, simplifyVector=FALSE))`;
        // Nothing awaits from here until the request is written.
        if (signal?.aborted) {
            throw new DispatchNotSentError('The code was cancelled before it was sent');
        }
        this.started = false;
        this.execution = {
            submission: submission.id,
            interruptRequested: false,
            connection: this.process.adopted ? connection : undefined,
        };
        // Managed sessions use send to avoid arf's unbounded evaluation capture.
        // R's ordered events establish the outcome even if arf's reply times out.
        // An adopted session is evaluated on the attach connection that reached
        // it, as a new connection to its socket path can reach another arf.
        const params = { code, visible: true, timeout_ms: 86400000 };
        let result: Record<string, unknown>;
        try {
            result = object(
                this.process.adopted
                    ? await connection.request('evaluate', params, { signal: this.abort.signal })
                    : await arfRequest(this.endpoint!, 'user_input', params, 0, this.abort.signal),
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
            const errno = (error as NodeJS.ErrnoException).code;
            if (errno === 'ENOENT' || errno === 'ECONNREFUSED') {
                // The connection was never opened, so nothing was sent. The
                // endpoint was gone, so another session may serve it next.
                this.reverify = true;
                throw new DispatchNotSentError(`arf could not be reached: ${String(error)}`);
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
