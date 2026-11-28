import { WebRConsole, WebRConsoleEvent } from '../../webr/console';
import { BackendEvent, DispatchNotSentError, SessionBackend } from '../backend';
import type { AgentSettings, Submission } from '../protocol';

/** An R runtime managed by the session agent's Node process. */
export class WebRBackend implements SessionBackend {
    readonly ownership = 'managed' as const;
    readonly capabilities = {
        streaming: true,
        stdin: true,
        debugger: false,
        tables: false,
        html: false,
        inspection: false,
        inspectionDeadline: false,
        interrupt: true,
        jgd: false,
        plotResize: false,
        restart: true,
    };
    private readonly listeners = new Set<(event: BackendEvent) => void>();
    private console?: WebRConsole;
    private current?: string;
    private inputId = 0;
    private stopped = false;

    constructor(
        private readonly settings: AgentSettings,
        private readonly baseUrl: string,
    ) {}

    onEvent(listener: (event: BackendEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: BackendEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    async start(): Promise<void> {
        const { ChannelType, WebR } = await import('webr');
        const runtime = new WebR({
            baseUrl: this.baseUrl,
            channelType: ChannelType.SharedArrayBuffer,
            interactive: true,
        });
        const console = new WebRConsole(
            runtime,
            (event) => this.receive(event),
            true,
            (error) => {
                if (error) {
                    this.emit({ type: 'error', message: error.message });
                }
                this.exit();
            },
        );
        this.console = console;
        try {
            await console.start();
            await runtime.FS.mkdir('/project');
            await runtime.FS.mount('NODEFS', { root: this.settings.directory }, '/project');
            await runtime.evalRVoid('base::setwd("/project")');
            const rVersion = await runtime.evalRString('R.version.string');
            if (!this.stopped) {
                this.emit({
                    type: 'ready',
                    capabilities: this.capabilities,
                    metadata: { rVersion },
                });
            }
        } catch (error) {
            console.close();
            throw error;
        }
    }

    private receive(event: WebRConsoleEvent): void {
        if (this.stopped) {
            return;
        }
        const executionId = this.current;
        switch (event.type) {
            case 'started':
            case 'stream':
                this.emit({ ...event, executionId });
                break;
            case 'input':
                this.emit({
                    type: 'input',
                    executionId,
                    data: { inputId: ++this.inputId, prompt: event.prompt },
                });
                break;
            case 'plot':
                this.emit({
                    type: 'display',
                    executionId,
                    data: {
                        kind: 'image',
                        mime: 'image/png',
                        data: Buffer.from(event.png).toString('base64'),
                    },
                });
                break;
        }
    }

    dispatch(submission: Submission, options?: { signal?: AbortSignal }): Promise<void> {
        const console = this.console;
        if (this.stopped || !console) {
            return Promise.reject(new DispatchNotSentError('webR session is closed.'));
        }
        if (this.current) {
            return Promise.reject(
                new DispatchNotSentError('webR is already evaluating a submission.'),
            );
        }
        this.current = submission.id;
        return new Promise((resolve, reject) => {
            let submitted = false;
            void console
                .execute(submission.code, options?.signal, () => {
                    submitted = true;
                    resolve();
                })
                .then(
                    (state) => {
                        this.current = undefined;
                        if (!this.stopped) {
                            this.emit({ type: 'finished', executionId: submission.id, state });
                        }
                    },
                    (error: unknown) => {
                        this.current = undefined;
                        if (!submitted) {
                            reject(new DispatchNotSentError(String(error)));
                        } else if (!this.stopped) {
                            this.emit({
                                type: 'unavailable',
                                executionId: submission.id,
                                message: String(error),
                            });
                        }
                    },
                );
        });
    }

    inspect(): Promise<never> {
        return Promise.reject(new Error('Object inspection is unavailable for webR Interactive.'));
    }

    replyInput(reply: { value: string }): Promise<void> {
        return Promise.resolve().then(() => {
            if (!this.console) {
                throw new Error('webR session is closed.');
            }
            this.console.replyInput(reply.value);
        });
    }

    replyClientRequest(): Promise<never> {
        return Promise.reject(new Error('webR has no pending editor request.'));
    }

    async interrupt(): Promise<void> {
        await this.console?.interrupt();
    }

    private exit(): void {
        if (!this.stopped) {
            this.stopped = true;
            this.emit({ type: 'exit' });
        }
    }

    stop(): Promise<void> {
        this.console?.close();
        this.exit();
        return Promise.resolve();
    }

    async dispose(): Promise<void> {
        this.listeners.clear();
        await this.stop();
    }
}
