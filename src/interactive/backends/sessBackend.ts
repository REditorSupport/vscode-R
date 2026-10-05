import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import { atomicJson } from '../journal';
import { AgentSettings, object, Submission } from '../protocol';
import { BackendCapabilities, BackendEvent, ClientReply, InputReply, InspectionRequest, ResizePlotRequest, SessionBackend } from '../backend';
import { SessBridge } from './sessBridge';
import { SessGraphics } from './sessGraphics';
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
    private frontend: Arf;
    private completion?: Record<string, unknown>;
    private outputDrained = false;
    private stderrFlushed = false;
    private orderedEvents = new Map<number, { event: Record<string, unknown>; bytes: number }>();
    private orderedOutput: ({ eventId: number } | { text: string })[] = [];
    private bufferedBytes = 0;
    private bufferedEventBytes = 0;
    private outputFailed = false;
    private runtime: string;
    private token = randomBytes(32).toString('hex');
    private current?: string;
    private closed = false;
    private disposing?: Promise<void>;
    private startup?: Promise<void>;
    constructor(private settings: AgentSettings, private options: SessOptions) {
        if (options.frontend !== 'arf') { throw new Error('R Interactive now requires arf. Start an arf session or use an ordinary R terminal.'); }
        this.ownership = options.ownership;
        this.capabilities = { streaming: options.ownership === 'managed', stdin: false, debugger: false, tables: true, html: true,
            inspection: true, interrupt: process.platform !== 'win32', jgd: false, plotResize: false, restart: options.ownership === 'managed' };
        this.runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'r-b-'));
        fs.chmodSync(this.runtime, 0o700);
        this.bridge = new SessBridge(this.runtime, this.token, event => this.emit(event),
            message => this.receive(message), (method, params) => this.notification(method, params, this.current));
        this.graphics = new SessGraphics({ ...options, historyLimit: settings.historyLimit }, event => this.emit(event));
        const output = (event: BackendEvent): void => {
            if (this.closed || this.outputFailed && event.type === 'stream') { return; }
            if (event.type === 'stream' && event.channel === 'stdout' && this.ownership === 'managed') {
                this.orderedOutput.push({ text: event.text }); this.bufferedBytes += Buffer.byteLength(event.text);
                this.drainEvents();
            } else { this.emit(event.type === 'stream' ? { ...event, executionId: this.current } : event); }
        };
        this.frontend = new Arf(options.arfPath ?? 'arf', settings.directory, options.arfEndpoint, this.ownership === 'adopted', output,
            this.token, (message, channel) => this.runtimeEvent(message, channel));
    }
    onEvent(listener: (event: BackendEvent) => void): () => void {
        this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
    private emit(event: BackendEvent): void {
        if (this.closed) { return; }
        if ((event.type === 'metadata' || event.type === 'ready') && event.metadata.rPid) { this.frontend.process.setPid(event.metadata.rPid); }
        if (event.type === 'clientRequest' && !event.executionId) { event = { ...event, executionId: this.current }; }
        if (event.type === 'exit') { this.graphics.flush(); this.graphics.dispose(); }
        for (const listener of this.listeners) { listener(event); }
    }
    start(): Promise<void> { return this.startup ??= this.startRuntime(); }
    private async startRuntime(): Promise<void> {
        const libraries = await run(this.options.rPath, ['--vanilla', '--slave', '-e', 'cat(.libPaths(), sep="\\n")'], { timeout: 15000 });
        if (this.closed) { throw new Error('Backend disposed during startup'); }
        const support = libraries.stdout.trim().split(/\r?\n/).filter(Boolean);
        await this.bridge.start();
        if (this.closed) { throw new Error('Backend disposed during startup'); }
        await this.graphics.start();
        if (this.closed) { this.graphics.dispose(); throw new Error('Backend disposed during startup'); }
        this.capabilities.jgd = this.graphics.enabled; this.capabilities.plotResize = this.graphics.enabled;
        const bootstrap = path.join(this.runtime, 'bootstrap.json');
        atomicJson(bootstrap, { sess: path.join(this.runtime, 'sess.sock'),
            jgd: this.graphics.endpoint, token: this.token, useJgd: this.graphics.enabled });
        const code = `base::source(${rString(path.join(this.options.resources, 'interactive-worker.R'))}, local=base::new.env(parent=base::baseenv()))$value(` +
            `${rString(this.options.library)}, ${rString(bootstrap)}, c(${support.map(rString).join(',')}), managed=${this.ownership === 'managed' ? 'TRUE' : 'FALSE'})`;
        await this.frontend.start(code, { ...process.env, SESS_ENDPOINT: path.join(this.runtime, 'sess.sock'), JGD_SOCKET: this.graphics.endpoint });
    }
    async dispatch(submission: Submission): Promise<void> {
        await this.startup;
        if (this.closed) { throw new Error('Backend is disposed'); }
        this.current = submission.id;
        this.completion = undefined; this.stderrFlushed = false; this.outputDrained = false;
        await this.frontend.dispatch(submission);
        this.outputDrained = true;
        if (this.ownership === 'adopted' && this.completion) { this.finish(this.completion); }
    }
    inspect(request: InspectionRequest): Promise<unknown> { return this.bridge.request(request.method, request.params, request.timeout ?? 5000); }
    replyInput(_reply: InputReply): Promise<void> { return Promise.reject(new Error('Notebook console input is not supported by arf IPC. Use an ordinary R terminal.')); }
    replyClientRequest(id: string, reply: ClientReply): Promise<void> { this.bridge.reply(id, reply); return Promise.resolve(); }
    interrupt(): Promise<void> { this.frontend.process.interrupt(); return Promise.resolve(); }
    async stop(options?: { force?: boolean }): Promise<void> {
        // Stop may arrive after the control endpoint opens but before R is spawned.
        await this.startup;
        await this.frontend.process.stop(options?.force);
    }
    resizePlot(request: ResizePlotRequest): Promise<void> { this.graphics.resize(request); return Promise.resolve(); }
    dispose(): Promise<void> { return this.disposing ??= this.disposeRuntime(); }
    private async disposeRuntime(): Promise<void> {
        this.closed = true; this.listeners.clear();
        this.orderedOutput = []; this.orderedEvents.clear(); this.bufferedBytes = 0; this.bufferedEventBytes = 0;
        try {
            if (this.ownership === 'adopted') {
                // Best effort through the existing bridge, without evaluating user code or interrupting R.
                await this.bridge.request('interactive_stop', {}, 500).catch(() => undefined);
            }
        } finally {
            this.frontend.dispose(); this.graphics.dispose(); this.bridge.dispose();
            fs.rmSync(this.runtime, { recursive: true, force: true });
        }
    }
    private runtimeEvent(message: Record<string, unknown>, channel?: string): void {
        if (this.closed || this.outputFailed) { return; }
        const executionId = typeof message.executionId === 'string' && message.executionId ? message.executionId : undefined;
        switch (message.type) {
            case 'event':
                if (channel === 'stdout' && Number.isSafeInteger(message.eventId)) {
                    this.orderedOutput.push({ eventId: Number(message.eventId) }); this.drainEvents();
                }
                break;
            case 'ready':
                this.frontend.ready = true;
                this.emit({ type: 'ready', capabilities: { ...this.capabilities }, metadata: {
                    rPid: Number(message.pid), rVersion: String(message.version), runtimeSessionId: String(message.sessionId),
                    rPath: typeof message.rPath === 'string' ? message.rPath : this.options.rPath,
                    libraryPaths: Array.isArray(message.libraryPaths) ? message.libraryPaths.map(String) : [] } });
                break;
            case 'started': this.frontend.markStarted(); this.emit({ type: 'started', executionId }); break;
            case 'flush':
                if (channel === 'stderr') {
                    this.stderrFlushed = true;
                    if (this.completion) { this.finish(this.completion); }
                }
                break;
            case 'finished':
                this.completion = message;
                if (this.ownership === 'managed' ? this.stderrFlushed : this.outputDrained) { this.finish(message); }
                break;
            case 'stream': this.emit({ type: 'stream', executionId, text: typeof message.text === 'string' ? message.text : '',
                channel: typeof message.channel === 'string' ? message.channel : 'stdout', external: !executionId && this.options.frontend === 'arf' }); break;
            case 'condition': case 'input': case 'display': this.emit({ type: message.type, data: message, executionId }); break;
            case 'truncated': this.emit({ type: 'truncated', message: String(message.message), executionId }); break;
            case 'notification': this.notification(String(message.method), object(message.params ?? {}), executionId); break;
            case 'external': this.emit({ type: 'external', code: typeof message.code === 'string' ? message.code : '# Terminal output', success: Boolean(message.success) }); break;
        }
    }
    private receive(message: Record<string, unknown>): void {
        if (this.closed || this.outputFailed) { return; }
        if (this.ownership === 'adopted') { this.runtimeEvent(message); return; }
        if (Number.isSafeInteger(message.eventId)) {
            const eventId = Number(message.eventId), event = object(message.event);
            const previous = this.orderedEvents.get(eventId);
            const bytes = Buffer.byteLength(JSON.stringify(event));
            this.bufferedEventBytes += bytes - (previous?.bytes ?? 0);
            this.orderedEvents.set(eventId, { event, bytes }); this.drainEvents();
        }
    }
    private drainEvents(): void {
        while (this.orderedOutput.length) {
            const item = this.orderedOutput[0];
            if ('eventId' in item) {
                const event = this.orderedEvents.get(item.eventId);
                if (!event) { break; }
                this.orderedOutput.shift(); this.orderedEvents.delete(item.eventId);
                this.bufferedEventBytes -= event.bytes; this.runtimeEvent(event.event);
            } else {
                this.orderedOutput.shift(); this.bufferedBytes -= Buffer.byteLength(item.text);
                this.emit({ type: 'stream', text: item.text, channel: 'stdout', executionId: this.current });
            }
        }
        if (this.bufferedBytes > 4 * 1024 * 1024 || this.bufferedEventBytes > 16 * 1024 * 1024 ||
            this.orderedOutput.length > 1024 || this.orderedEvents.size > 1024) {
            this.outputFailed = true;
            this.orderedOutput = []; this.orderedEvents.clear(); this.bufferedBytes = 0; this.bufferedEventBytes = 0;
            this.emit({ type: 'unavailable', message: 'R output references missing Interactive events; restart the session before submitting more code.' });
        }
    }
    private finish(message: Record<string, unknown>): void {
        const executionId = String(message.executionId);
        if (this.current !== executionId) { return; }
        this.graphics.flush(executionId);
        this.current = undefined; this.completion = undefined;
        this.emit({ type: 'finished', executionId,
            state: message.state === 'success' || message.state === 'interrupted' ? message.state : 'error' });
    }
    private notification(method: string, params: Record<string, unknown>, executionId?: string): void {
        if (['webview', 'page_viewer', 'browser'].includes(method) && typeof params.url === 'string') {
            this.emit({ type: 'display', executionId, data: /^https?:\/\//.test(params.url)
                ? { kind: 'url', url: params.url } : { kind: 'html', file: params.url } });
        } else if (method === 'workspace_updated') { this.emit({ type: 'workspaceChanged' }); }
        else { this.emit({ type: method === 'dataview' ? 'viewer' : 'notification', method, params, executionId }); }
    }
}
