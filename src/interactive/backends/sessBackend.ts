import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { atomicJson } from '../journal';
import { AgentSettings, object, Submission } from '../protocol';
import {
    BackendCapabilities,
    BackendEvent,
    ClientReply,
    InputReply,
    InspectionRequest,
    ResizePlotRequest,
    SessionBackend,
} from '../backend';
import { SessBridge } from './sessBridge';
import { SessGraphics } from './sessGraphics';
import { PlainR, SessFrontend } from './plainR';
import { Arf } from './arf';
import { rString } from './rCode';

const run = promisify(execFile);
export interface SessOptions {
    frontend: 'r' | 'arf';
    ownership: 'managed' | 'adopted';
    rPath: string;
    library: string;
    resources: string;
    arfPath?: string;
    arfEndpoint?: string;
    plotBackend: 'auto' | 'jgd' | 'standard';
}

export class SessBackend implements SessionBackend {
    readonly ownership: 'managed' | 'adopted';
    readonly capabilities: BackendCapabilities;
    private listeners = new Set<(event: BackendEvent) => void>();
    private bridge: SessBridge;
    private graphics: SessGraphics;
    private frontend: SessFrontend;
    private runtime: string;
    private token = randomBytes(32).toString('hex');
    private current?: string;
    private closed = false;
    private disposing?: Promise<void>;
    private startup?: Promise<void>;
    constructor(
        private settings: AgentSettings,
        private options: SessOptions,
    ) {
        this.ownership = options.ownership;
        this.capabilities = {
            streaming: true,
            stdin: true,
            debugger: true,
            tables: true,
            html: true,
            inspection: true,
            interrupt: process.platform !== 'win32',
            jgd: false,
            plotResize: false,
            restart: options.ownership === 'managed',
        };
        this.runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'r-b-'));
        fs.chmodSync(this.runtime, 0o700);
        this.bridge = new SessBridge(
            this.runtime,
            this.token,
            (event) => this.emit(event),
            (message) => this.native(message),
            (method, params) => this.notification(method, params, this.current),
        );
        this.graphics = new SessGraphics(
            { ...options, historyLimit: settings.historyLimit },
            (event) => this.emit(event),
        );
        const output = (event: BackendEvent): void =>
            this.emit(event.type === 'stream' ? { ...event, executionId: this.current } : event);
        this.frontend =
            options.frontend === 'r'
                ? new PlainR(options.rPath, settings.directory, this.bridge, output)
                : new Arf(
                      options.arfPath ?? 'arf',
                      settings.directory,
                      options.arfEndpoint,
                      this.ownership === 'adopted',
                      output,
                  );
    }
    onEvent(listener: (event: BackendEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    private emit(event: BackendEvent): void {
        if (this.closed) {
            return;
        }
        if ((event.type === 'metadata' || event.type === 'ready') && event.metadata.rPid) {
            this.frontend.process.setPid(event.metadata.rPid);
        }
        if (event.type === 'clientRequest' && !event.executionId) {
            event = { ...event, executionId: this.current };
        }
        if (event.type === 'exit') {
            this.graphics.flush();
            this.graphics.dispose();
        }
        for (const listener of this.listeners) {
            listener(event);
        }
    }
    start(): Promise<void> {
        return (this.startup ??= this.startRuntime());
    }
    private async startRuntime(): Promise<void> {
        const libraries = await run(
            this.options.rPath,
            ['--vanilla', '--slave', '-e', 'cat(.libPaths(), sep="\\n")'],
            { timeout: 15000 },
        );
        if (this.closed) {
            throw new Error('Backend disposed during startup');
        }
        const support = libraries.stdout.trim().split(/\r?\n/).filter(Boolean);
        await this.bridge.start();
        if (this.closed) {
            throw new Error('Backend disposed during startup');
        }
        await this.graphics.start();
        if (this.closed) {
            this.graphics.dispose();
            throw new Error('Backend disposed during startup');
        }
        this.capabilities.jgd = this.graphics.enabled;
        this.capabilities.plotResize = this.graphics.enabled;
        const bootstrap = path.join(this.runtime, 'bootstrap.json');
        atomicJson(bootstrap, {
            sess: path.join(this.runtime, 'sess.sock'),
            console: path.join(this.runtime, 'console.sock'),
            jgd: this.graphics.endpoint,
            token: this.token,
            useJgd: this.graphics.enabled,
        });
        const code =
            `base::source(${rString(path.join(this.options.resources, 'interactive-worker.R'))}, local=base::new.env(parent=base::baseenv()))$value(` +
            `${rString(this.options.library)}, ${rString(bootstrap)}, c(${support.map(rString).join(',')}), worker=${this.options.frontend === 'r' ? 'TRUE' : 'FALSE'})`;
        await this.frontend.start(code, {
            ...process.env,
            SESS_ENDPOINT: path.join(this.runtime, 'sess.sock'),
            JGD_SOCKET: this.graphics.endpoint,
        });
    }
    async dispatch(submission: Submission): Promise<void> {
        await this.startup;
        if (this.closed) {
            throw new Error('Backend is disposed');
        }
        this.current = submission.id;
        await this.frontend.dispatch(submission);
    }
    inspect(request: InspectionRequest): Promise<unknown> {
        return this.bridge.request(request.method, request.params, request.timeout ?? 5000);
    }
    replyInput(reply: InputReply): Promise<void> {
        this.bridge.input(reply.value);
        return Promise.resolve();
    }
    replyClientRequest(id: string, reply: ClientReply): Promise<void> {
        this.bridge.reply(id, reply);
        return Promise.resolve();
    }
    interrupt(): Promise<void> {
        this.frontend.process.interrupt();
        return Promise.resolve();
    }
    async stop(options?: { force?: boolean }): Promise<void> {
        // Stop may arrive after the control endpoint opens but before R is spawned.
        await this.startup;
        await this.frontend.process.stop(options?.force);
    }
    resizePlot(request: ResizePlotRequest): Promise<void> {
        this.graphics.resize(request);
        return Promise.resolve();
    }
    dispose(): Promise<void> {
        return (this.disposing ??= this.disposeRuntime());
    }
    private async disposeRuntime(): Promise<void> {
        this.closed = true;
        this.listeners.clear();
        try {
            if (this.ownership === 'adopted') {
                // Best effort through the existing bridge, without evaluating user code or interrupting R.
                await this.bridge.request('interactive_stop', {}, 500).catch(() => undefined);
            }
        } finally {
            this.frontend.dispose();
            this.graphics.dispose();
            this.bridge.dispose();
            fs.rmSync(this.runtime, { recursive: true, force: true });
        }
    }
    private native(message: Record<string, unknown>): void {
        if (this.closed) {
            return;
        }
        const executionId =
            typeof message.executionId === 'string' && message.executionId
                ? message.executionId
                : undefined;
        switch (message.type) {
            case 'ready':
                this.frontend.ready = true;
                this.emit({
                    type: 'ready',
                    capabilities: { ...this.capabilities },
                    metadata: {
                        rPid: Number(message.pid),
                        rVersion: String(message.version),
                        runtimeSessionId: String(message.sessionId),
                        rPath:
                            typeof message.rPath === 'string' ? message.rPath : this.options.rPath,
                        libraryPaths: Array.isArray(message.libraryPaths)
                            ? message.libraryPaths.map(String)
                            : [],
                    },
                });
                break;
            case 'started':
                this.emit({ type: 'started', executionId });
                break;
            case 'finished':
                this.graphics.flush(executionId);
                if (this.current === executionId) {
                    this.current = undefined;
                }
                this.emit({
                    type: 'finished',
                    executionId,
                    state:
                        message.state === 'success' || message.state === 'interrupted'
                            ? message.state
                            : 'error',
                });
                break;
            case 'stream':
                this.emit({
                    type: 'stream',
                    executionId,
                    text: typeof message.text === 'string' ? message.text : '',
                    channel: typeof message.channel === 'string' ? message.channel : 'stdout',
                    external: !executionId && this.options.frontend === 'arf',
                });
                break;
            case 'condition':
            case 'input':
            case 'display':
                this.emit({ type: message.type, data: message, executionId });
                break;
            case 'truncated':
                this.emit({ type: 'truncated', message: String(message.message), executionId });
                break;
            case 'notification':
                this.notification(
                    String(message.method),
                    object(message.params ?? {}),
                    executionId,
                );
                break;
            case 'external':
                this.emit({
                    type: 'external',
                    code: typeof message.code === 'string' ? message.code : '# Terminal output',
                    success: Boolean(message.success),
                });
                break;
        }
    }
    private notification(
        method: string,
        params: Record<string, unknown>,
        executionId?: string,
    ): void {
        if (
            ['webview', 'page_viewer', 'browser'].includes(method) &&
            typeof params.url === 'string'
        ) {
            this.emit({
                type: 'display',
                executionId,
                data: /^https?:\/\//.test(params.url)
                    ? { kind: 'url', url: params.url }
                    : { kind: 'html', file: params.url },
            });
        } else if (method === 'workspace_updated') {
            this.emit({ type: 'workspaceChanged' });
        } else {
            this.emit({
                type: method === 'dataview' ? 'viewer' : 'notification',
                method,
                params,
                executionId,
            });
        }
    }
}
