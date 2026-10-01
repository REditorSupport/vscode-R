import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess, execFile } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { promisify } from 'util';
import { StringDecoder } from 'string_decoder';
import { JsonLines } from './framing';
import { SessionJournal, atomicJson, retainedAssetIds } from './journal';
import { AssetStore } from './assets';
import { arfRequest } from './arf';
import { AGENT_PROTOCOL, AgentConfig, AgentSnapshot, ExecutionRecord, SessionEvent,
    SessionManifest, object, submission, identifier, sessionLabel } from './protocol';
import { JgdSocketServer, JgdMessage } from '../plotViewer/jgdSocketServer';
import { PlotHistory, PlotFrame } from '../plotViewer/jgdPlotHistory';
import { plotToSvg } from './plotSvg';
import { searchHistory } from './history';

interface Client { socket: net.Socket; authenticated: boolean; subscribed: boolean; id: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; socket: net.Socket }

const run = promisify(execFile);

/** This process never imports vscode and is supervised independently of the editor. */
export class SessionAgent {
    private journal: SessionJournal;
    private assets: AssetStore;
    private clients = new Set<Client>();
    private lease?: { client: string; until: number };
    private manifest: SessionManifest;
    private worker?: ChildProcess;
    private metrics?: ChildProcess;
    private console?: net.Socket;
    private sess?: net.Socket;
    private servers: net.Server[] = [];
    private pending = new Map<number, Pending>();
    private frontendRequests = new Map<number, { socket: net.Socket; id: unknown; timer: NodeJS.Timeout }>();
    private nextRequest = 1;
    private queue: string[] = [];
    private current?: string;
    private input?: Record<string, unknown>;
    private workspace?: Record<string, unknown>;
    private outputBytes = new Map<string, number>();
    private truncated = new Set<string>();
    private nativeReady = false;
    private plotContexts = new Map<string, string>();
    private arfEndpoint?: string;
    private runtime: string;
    private bootstrap: string;
    private jgd: JgdSocketServer;
    private history: PlotHistory;
    private metricPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    private metricCounter = 0;
    private stopped = false;
    private stopping = false;
    private shutdownTimers: NodeJS.Timeout[] = [];
    private dispatching = false;
    private decoders = new Map<string, StringDecoder>();
    private externalOutput: Record<string, unknown>[] = [];
    private externalBytes = 0;
    private externalTimer?: NodeJS.Timeout;
    private pendingPlots = new Map<string, { frame: PlotFrame; count: number; device: string; plot: number; executionId?: string }>();
    private plotTimer?: NodeJS.Timeout;
    private retentionWarnings = new Set<string>();

    constructor(private config: AgentConfig) {
        identifier(config.id); identifier(config.generation);
        this.runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'r-i-'));
        fs.chmodSync(this.runtime, 0o700);
        this.bootstrap = path.join(this.runtime, 'bootstrap.json');
        fs.mkdirSync(config.storage, { recursive: true, mode: 0o700 });
        this.journal = new SessionJournal(path.join(config.storage, config.generation), config.generation, config.maxJournalBytes);
        this.assets = new AssetStore(path.join(config.storage, 'assets'), config.maxAssetBytes, () => retainedAssetIds(config.storage));
        this.history = new PlotHistory(config.historyLimit);
        this.jgd = new JgdSocketServer(this.history);
        this.manifest = {
            protocol: AGENT_PROTOCOL, id: config.id, generation: config.generation,
            label: config.label, host: os.hostname(), directory: config.directory,
            endpoint: path.join(this.runtime, 'control.sock'), token: randomBytes(32).toString('hex'),
            agentPid: process.pid, provider: config.provider, created: Date.now(), status: 'starting',
            capabilities: { persistent: true, streaming: true, stdin: true, debugger: true,
                tables: true, html: true, interrupt: process.platform !== 'win32', jgd: false,
                history: true, rename: true, cancelQueued: true, assetStorage: true },
            supervision: config.supervision,
        };
        // A previous agent's accepted/running work must never be replayed automatically.
        for (const entry of this.journal.executions.values()) {
            if (entry.state === 'running' || entry.state === 'queued') {
                this.journal.update({ ...entry, state: 'unknown', ended: Date.now() });
            }
        }
    }

    async start(): Promise<SessionManifest> {
        await this.assets.start();
        this.manifest.assetBase = this.assets.base;
        await this.listen(this.manifest.endpoint, socket => this.connectClient(socket));
        await this.listen(path.join(this.runtime, 'sess.sock'), socket => this.connectSess(socket));
        await this.listen(path.join(this.runtime, 'console.sock'), socket => this.connectConsole(socket));
        await this.startGraphics();
        atomicJson(this.bootstrap, {
            sess: path.join(this.runtime, 'sess.sock'), console: path.join(this.runtime, 'console.sock'),
            jgd: this.jgd.getSocketPath(), token: this.manifest.token, useJgd: this.manifest.capabilities.jgd,
        });
        this.saveManifest();
        await this.launch();
        return this.manifest;
    }

    private async listen(endpoint: string, connect: (socket: net.Socket) => void): Promise<void> {
        const server = net.createServer(connect);
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(endpoint, resolve);
        });
        fs.chmodSync(endpoint, 0o600);
    }

    private saveManifest(): void { atomicJson(path.join(this.config.storage, 'manifest.json'), this.manifest); }

    private event(type: string, data: Record<string, unknown> = {}, executionId = this.current, durable = false): SessionEvent {
        if (this.stopped) { return { seq: this.journal.seq, generation: this.config.generation, type, data, executionId, time: Date.now() }; }
        const event = this.journal.append(type, data, executionId, durable);
        for (const client of this.clients) {
            if (client.subscribed) { this.send(client.socket, { event }); }
        }
        return event;
    }

    private state(status: SessionManifest['status']): void {
        if (this.stopped) { return; }
        if (this.stopping && status !== 'exited') { status = 'stopping'; }
        this.manifest.status = status;
        if (status === 'exited') {
            this.manifest.ended ??= Date.now();
            this.shutdownTimers.forEach(clearTimeout); this.shutdownTimers = [];
            this.cancelQueued(); this.input = undefined;
            this.metrics?.kill(); this.jgd.stop();
        }
        this.saveManifest();
        this.event('state', { status, rPid: this.manifest.rPid, rVersion: this.manifest.rVersion, ended: this.manifest.ended });
    }

    private send(socket: net.Socket, message: unknown): void {
        if (!socket.destroyed) {
            if (socket.writableLength > 8 * 1024 * 1024) { socket.destroy(); return; }
            socket.write(JSON.stringify(message) + '\n');
        }
    }

    private connectClient(socket: net.Socket): void {
        const client: Client = { socket, authenticated: false, subscribed: false, id: '' };
        this.clients.add(client);
        const authTimer = setTimeout(() => { if (!client.authenticated) { socket.destroy(); } }, 5000);
        const parser = new JsonLines(message => {
            void this.handleClient(client, message).catch(error => {
                this.send(socket, { id: message.id, error: error instanceof Error ? error.message : String(error) });
            });
        });
        socket.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { socket.destroy(); } });
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
            clearTimeout(authTimer);
            this.clients.delete(client);
            if (this.manifest.status === 'exited' && !this.clients.size && !this.stopped) { this.close(); }
            // Keep the lease briefly for reconnect; accepted executions keep running.
        });
    }

    private requireControl(client: Client): void {
        if (!this.lease || this.lease.client !== client.id || this.lease.until < Date.now()) {
            throw new Error('This window is observing the session. Take control before changing it.');
        }
        this.lease.until = Date.now() + 60000;
    }

    private async handleClient(client: Client, request: Record<string, unknown>): Promise<void> {
        if (typeof request.id !== 'number' || typeof request.method !== 'string') { throw new Error('Invalid request'); }
        const params = object(request.params ?? {});
        if (!client.authenticated) {
            if (request.method !== 'hello' || params.token !== this.manifest.token || params.protocol !== AGENT_PROTOCOL) {
                client.socket.destroy(); return;
            }
            client.id = identifier(params.clientId);
            client.authenticated = true;
            this.send(client.socket, { id: request.id, result: this.manifest });
            return;
        }
        if (params.generation !== this.manifest.generation) { throw new Error('R session generation changed; reconnect before executing'); }
        let result: unknown = true;
        switch (request.method) {
            case 'claim':
                if (!this.lease || this.lease.until < Date.now() || this.lease.client === client.id || params.force === true ||
                    ![...this.clients].some(other => other.authenticated && other.id === this.lease?.client && !other.socket.destroyed)) {
                    this.lease = { client: client.id, until: Date.now() + 60000 };
                    result = true;
                } else { result = false; }
                break;
            case 'heartbeat':
                if (this.lease?.client === client.id) { this.lease.until = Date.now() + 60000; }
                result = { status: this.manifest.status, control: this.lease?.client === client.id, queued: this.queue.length };
                break;
            case 'history': {
                const query = typeof params.query === 'string' ? params.query.slice(0, 1000) : '';
                const before = params.before ?? Number.MAX_SAFE_INTEGER;
                if (!Number.isSafeInteger(before) || Number(before) < 1) { throw new Error('Invalid history cursor'); }
                result = searchHistory(this.journal.executions.values(), query, Number(before));
                break;
            }
            case 'rename': {
                this.requireControl(client);
                const label = sessionLabel(params.label);
                const config = { ...this.config, label };
                atomicJson(path.join(config.storage, 'config.json'), config);
                this.config = config; this.manifest.label = label; this.saveManifest();
                this.event('session', { label });
                result = label;
                break;
            }
            case 'cancelQueued':
                this.requireControl(client);
                result = this.cancelQueued();
                break;
            case 'snapshot': {
                const recent = this.journal.recent(Math.max(1, Math.min(Number(params.limit) || 50, this.config.historyLimit)));
                // Bound one protocol response. Older/full output remains in the journal.
                let size = 0;
                const executions: ExecutionRecord[] = [];
                for (const record of recent.executions.slice().reverse()) {
                    const bytes = Buffer.byteLength(JSON.stringify(record));
                    if (size + bytes > 1400 * 1024) { break; }
                    size += bytes; executions.unshift(record);
                }
                const ids = new Set(executions.map(record => record.id));
                const events: SessionEvent[] = [];
                for (const event of recent.events.slice().reverse()) {
                    if (!event.executionId || !ids.has(event.executionId)) { continue; }
                    size += Buffer.byteLength(JSON.stringify(event));
                    if (size > 3 * 1024 * 1024) { break; }
                    events.unshift(event);
                }
                result = { manifest: this.manifest, seq: this.journal.seq,
                    executions, events, workspace: this.workspace, input: this.input,
                    truncated: executions.filter(record => !events.some(event => event.type === 'accepted' && event.executionId === record.id)).map(record => record.id) } satisfies AgentSnapshot;
                break;
            }
            case 'subscribe': {
                const after = Number(params.after ?? 0);
                if (!Number.isSafeInteger(after) || after < 0) { throw new Error('Invalid event cursor'); }
                const replay = this.journal.replay(after, 500);
                replay.events = replay.events.map(event => {
                    if ((event.type === 'clientRequest' && !this.frontendRequests.has(Number(event.data.id))) ||
                        (event.type === 'input' && event.data.inputId !== this.input?.inputId)) {
                        return { ...event, type: 'noop', data: {} };
                    }
                    return event;
                });
                this.send(client.socket, { id: request.id, result: replay });
                client.subscribed = !replay.reset && (replay.events.at(-1)?.seq ?? after) >= replay.seq;
                return;
            }
            case 'submit': {
                this.requireControl(client);
                if (this.stopping || this.manifest.status === 'exited' || this.manifest.status === 'unknown') { throw new Error('R is not available'); }
                const accepted = this.journal.accept(submission(params.submission));
                result = accepted.record;
                if (!accepted.duplicate) {
                    this.event('accepted', { record: accepted.record }, accepted.record.id, true);
                    this.queue.push(accepted.record.id);
                    void this.pump();
                }
                break;
            }
            case 'execution': result = this.journal.executions.get(identifier(params.id)) ?? null; break;
            case 'cancel': {
                this.requireControl(client);
                const id = identifier(params.id);
                const record = this.journal.executions.get(id);
                if (record?.state !== 'queued' || this.current === id) { throw new Error('Only undispatched queued executions can be cancelled'); }
                this.queue = this.queue.filter(entry => entry !== id);
                this.finish(record, 'cancelled');
                break;
            }
            case 'interrupt':
                this.requireControl(client);
                if (params.id && params.id !== this.current) { throw new Error('Execution is no longer running'); }
                if (this.current && this.manifest.rPid && this.console && !this.console.destroyed) {
                    process.kill(this.manifest.rPid, 'SIGINT');
                }
                break;
            case 'input':
                this.requireControl(client);
                if (!this.input || params.id !== this.input.inputId || params.executionId !== this.input.executionId) {
                    throw new Error('Input request is no longer active');
                }
                if (typeof params.value !== 'string' || /[\r\n\0]/.test(params.value) || Buffer.byteLength(params.value) > Number(this.input.maxLength ?? 4094)) {
                    throw new Error('Input must be a single line');
                }
                this.console?.write(params.value + '\n');
                this.input = undefined;
                this.state('busy');
                break;
            case 'inspect':
                if (this.current) {
                    if (params.method === 'workspace') { result = this.workspace ?? {}; break; }
                    throw new Error('R is busy; cached data remains available. Retry when idle.');
                }
                if (!['workspace', 'workspace_children', 'hover', 'completion', 'dataview_init', 'dataview_page', 'dataview_dispose'].includes(String(params.method))) {
                    throw new Error('Unsupported inspection method');
                }
                result = await this.sessRequest(String(params.method), object(params.params ?? {}), 5000);
                break;
            case 'asset': {
                result = this.assets.read(String(params.id), 2 * 1024 * 1024).toString('base64');
                break;
            }
            case 'assetStorage':
                if (params.limitBytes !== undefined) {
                    this.requireControl(client);
                    this.assets.setLimit(Number(params.limitBytes));
                    this.config.maxAssetBytes = this.assets.stats().limitBytes;
                    atomicJson(path.join(this.config.storage, 'config.json'), this.config);
                }
                if (params.compact === true) { this.requireControl(client); result = this.assets.compact(); }
                else { result = this.assets.stats(); }
                break;
            case 'resize':
                this.requireControl(client);
                if (this.current) { throw new Error('R is busy; the retained plot can be scaled locally'); }
                if (typeof params.device !== 'string' || typeof params.plot !== 'number') { throw new Error('Invalid plot'); }
                this.jgd.sendToSession(params.device, { type: 'resize', plotIndex: params.plot,
                    width: Math.max(100, Math.min(4096, Number(params.width) || 800)),
                    height: Math.max(100, Math.min(4096, Number(params.height) || 600)) });
                break;
            case 'clientReply': {
                this.requireControl(client);
                const pending = this.frontendRequests.get(Number(params.id));
                if (pending) {
                    clearTimeout(pending.timer); this.frontendRequests.delete(Number(params.id));
                    this.send(pending.socket, { jsonrpc: '2.0', id: pending.id,
                        ...(params.error ? { error: { code: -32000, message: String(params.error) } } : { result: params.result ?? null }) });
                }
                break;
            }
            case 'detach':
                client.subscribed = false;
                if (this.lease?.client === client.id) { this.lease = undefined; }
                break;
            case 'stop':
                this.requireControl(client);
                this.stopWorker();
                break;
            case 'shutdown':
                this.requireControl(client);
                if (this.manifest.status !== 'exited') { throw new Error('Stop R before shutting down its agent'); }
                this.send(client.socket, { id: request.id, result: true });
                setTimeout(() => this.close(), 100);
                return;
            default: throw new Error(`Unknown agent method: ${request.method}`);
        }
        this.send(client.socket, { id: request.id, result });
    }

    private connectSess(socket: net.Socket): void {
        let attached = false;
        const parser = new JsonLines(message => {
            if (message.method === 'attach') {
                const params = object(message.params);
                if (params.protocol_version !== 1 || params.interactive_token !== this.manifest.token ||
                    (this.sess && this.sess !== socket)) { socket.destroy(); return; }
                if (this.sess && this.sess !== socket) { this.sess.destroy(); }
                this.sess = socket; attached = true;
                this.manifest.rPid = Number(params.pid);
                this.manifest.rVersion = String(params.version);
                this.manifest.runtimeSessionId = String(params.session_id);
                this.saveManifest();
                return;
            }
            if (!attached || this.sess !== socket) { return; }
            if (typeof message.id === 'number' && !message.method) {
                const pending = this.pending.get(message.id);
                if (pending?.socket !== socket) { return; }
                clearTimeout(pending.timer); this.pending.delete(message.id);
                if (message.error) { pending.reject(new Error(JSON.stringify(message.error))); }
                else { pending.resolve(message.result); }
            } else if (message.method && message.id !== undefined) {
                const id = this.nextRequest++;
                const timer = setTimeout(() => {
                    this.frontendRequests.delete(id);
                    this.send(socket, { jsonrpc: '2.0', id: message.id,
                        error: { code: -32000, message: 'No controlling editor replied within 30 seconds' } });
                }, 30000);
                this.frontendRequests.set(id, { socket, id: message.id, timer });
                this.event('clientRequest', { id, method: message.method, params: message.params });
            } else if (message.method) {
                this.notification(String(message.method), object(message.params ?? {}));
            }
        });
        socket.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { socket.destroy(); } });
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
            if (this.sess === socket) { this.sess = undefined; }
            for (const [id, pending] of this.pending) {
                if (pending.socket === socket) {
                    clearTimeout(pending.timer); pending.reject(new Error('R disconnected')); this.pending.delete(id);
                }
            }
        });
    }

    private sessRequest(method: string, params: Record<string, unknown>, timeout = 10000): Promise<unknown> {
        const socket = this.sess;
        if (!socket || socket.destroyed) { return Promise.reject(new Error('R session is disconnected')); }
        return new Promise((resolve, reject) => {
            const id = this.nextRequest++;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('R request timed out')); }, timeout);
            this.pending.set(id, { resolve, reject, timer, socket });
            this.send(socket, { jsonrpc: '2.0', id, method, params });
        });
    }

    private connectConsole(socket: net.Socket): void {
        let authenticated = false;
        const parser = new JsonLines(message => {
            if (!authenticated) {
                if (message.type !== 'hello' || message.token !== this.manifest.token || this.console) { socket.destroy(); return; }
                authenticated = true; this.console = socket; return;
            }
            if (this.console !== socket) { return; }
            try { this.nativeEvent(message); }
            catch (error) {
                // A disk/asset error must not stop draining the R console.
                process.stderr.write(`Interactive event error: ${String(error)}\n`);
                try { this.event('truncated', { message: `Output could not be retained: ${String(error)}` }, this.current); }
                catch { this.manifest.status = 'unknown'; }
            }
        });
        socket.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { socket.destroy(); } });
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
            if (this.console !== socket) { return; }
            this.console = undefined; this.nativeReady = false;
            if (!this.stopped) {
                if (this.current) { this.finish(this.journal.executions.get(this.current)!, 'unknown'); }
                this.state('exited');
            }
        });
    }

    private nativeEvent(message: Record<string, unknown>): void {
        if (this.stopped) { return; }
        const executionId = typeof message.executionId === 'string' && message.executionId ? message.executionId : undefined;
        switch (message.type) {
            case 'ready':
                this.nativeReady = true;
                this.manifest.rPid = Number(message.pid);
                this.manifest.rVersion = String(message.version);
                this.manifest.runtimeSessionId = String(message.sessionId);
                this.manifest.rPath = typeof message.rPath === 'string' ? message.rPath : this.config.rPath;
                this.manifest.libraryPaths = Array.isArray(message.libraryPaths) ? message.libraryPaths.map(String) : [];
                this.state('idle'); void this.refreshWorkspace(); void this.pump(); break;
            case 'started': {
                const record = executionId && this.journal.executions.get(executionId);
                if (!record || this.current !== executionId) { throw new Error('Unexpected execution start'); }
                this.journal.update({ ...record, state: 'running', started: Date.now() });
                this.event('started', { order: record.order }, executionId, true); this.state('busy'); break;
            }
            case 'stream': {
                const channel = String(message.channel ?? 'stdout');
                const key = `${executionId ?? 'external'}:${channel}`;
                let decoder = this.decoders.get(key);
                if (!decoder) { decoder = new StringDecoder('utf8'); this.decoders.set(key, decoder); }
                const text = typeof message.bytes === 'string' ? decoder.write(Buffer.from(message.bytes, 'base64')) : String(message.text ?? '');
                if (!executionId && this.config.provider !== 'r') {
                    if (this.externalBytes < this.config.maxOutputBytes) {
                        this.externalOutput.push({ text, channel }); this.externalBytes += Buffer.byteLength(text);
                    }
                    if (!this.externalTimer) {
                        this.externalTimer = setTimeout(() => this.flushExternal(), 100);
                    }
                } else { this.stream(text, channel, executionId); }
                break;
            }
            case 'condition': this.event('condition', message, executionId); break;
            case 'input':
                this.input = { ...message, executionId: executionId ?? this.current };
                this.event('input', this.input, executionId); this.state('input'); break;
            case 'display': this.display(message, executionId); break;
            case 'notification': this.notification(String(message.method), object(message.params ?? {}), executionId); break;
            case 'finished': {
                const record = executionId && this.journal.executions.get(executionId);
                if (!record || this.current !== executionId) { break; }
                const state = message.state === 'success' || message.state === 'interrupted' ? message.state : 'error';
                this.finish(record, state); this.state('idle');
                void this.refreshWorkspace().finally(() => { void this.pump(); }); break;
            }
            case 'external': {
                this.flushExternal(String(message.code ?? '# Terminal output'), Boolean(message.success));
                void this.refreshWorkspace(); break;
            }
        }
    }

    private flushExternal(code?: string, success = true): void {
        clearTimeout(this.externalTimer); this.externalTimer = undefined;
        if (this.stopped || (!code && !this.externalOutput.length)) { return; }
        // Some arf evaluation paths do not run R task callbacks. Preserve their
        // output without claiming to know the source or execution boundary.
        const record = this.journal.accept({ id: randomUUID(), code: code ?? '# Output from attached R terminal (source unavailable)' }).record;
        this.event('accepted', { record, origin: 'terminal' }, record.id, true);
        for (const output of this.externalOutput) { this.stream(String(output.text), String(output.channel), record.id); }
        this.externalOutput = []; this.externalBytes = 0;
        this.finish(record, success ? 'success' : 'error');
    }

    private stream(text: string, channel: string, executionId?: string): void {
        const key = executionId ?? 'session';
        const previous = this.outputBytes.get(key) ?? 0;
        const remaining = this.config.maxOutputBytes - previous;
        if (remaining <= 0) {
            if (!this.truncated.has(key)) {
                this.truncated.add(key);
                this.event('truncated', { message: 'Output exceeded the configured per-execution limit.' }, executionId);
            }
            return;
        }
        const bytes = Buffer.from(text);
        this.outputBytes.set(key, previous + bytes.length);
        // Bound event sizes even for a single very large native console write.
        const decoder = new StringDecoder('utf8');
        for (let start = 0; start < Math.min(bytes.length, remaining); start += 32768) {
            this.event('stream', { text: decoder.write(bytes.subarray(start, Math.min(start + 32768, remaining))), channel }, executionId);
        }
        if (bytes.length > remaining) { this.event('truncated', { message: 'Output exceeded the configured per-execution limit.' }, executionId); this.truncated.add(key); }
    }

    private display(data: Record<string, unknown>, executionId?: string): void {
        const display: Record<string, unknown> = { ...data, displayId: typeof data.displayId === 'string' ? data.displayId : randomUUID() };
        if (data.kind === 'html' && typeof data.file === 'string') {
            display.asset = this.assets.importHtml(data.file);
            delete display.file;
        }
        if (data.kind === 'image' && typeof data.data === 'string') {
            display.asset = this.assets.put(Buffer.from(data.data, 'base64'), data.mime === 'image/png' ? '.png' : '.svg');
            delete display.data;
        }
        if (Buffer.byteLength(JSON.stringify(display)) > 2 * 1024 * 1024) {
            this.event('truncated', { message: 'Rich output exceeds 2 MiB; display a smaller preview or save it to a file.' }, executionId);
            return;
        }
        this.event('display', display, executionId);
    }

    private notification(method: string, params: Record<string, unknown>, executionId = this.current): void {
        if (['webview', 'page_viewer', 'browser'].includes(method) && typeof params.url === 'string') {
            if (/^https?:\/\//.test(params.url)) { this.display({ kind: 'url', url: params.url }, executionId); }
            else { this.display({ kind: 'html', file: params.url }, executionId); }
        } else if (method === 'workspace_updated') {
            if (!this.current) { void this.refreshWorkspace(); }
        } else if (method === 'dataview') {
            this.event('viewer', { method, params }, executionId);
        } else {
            this.event('notification', { method, params }, executionId);
        }
    }

    private async refreshWorkspace(): Promise<void> {
        if (!this.sess || this.current) { return; }
        try {
            this.workspace = object(await this.sessRequest('workspace', {}, 2000));
            this.event('workspace', this.workspace, undefined);
        } catch { /* A busy or disconnected process retains the last workspace snapshot. */ }
    }

    private cancelQueued(): number {
        const queued = this.queue.splice(0);
        for (const id of queued) {
            const record = this.journal.executions.get(id);
            if (record?.state === 'queued') { this.finish(record, 'cancelled'); }
        }
        return queued.length;
    }

    private finish(record: ExecutionRecord, state: ExecutionRecord['state']): void {
        if (this.stopped) { return; }
        this.flushPlots(record.id);
        const final = { ...record, state, ended: Date.now() };
        this.journal.update(final);
        this.event('finished', { state, record: final }, record.id, true);
        if (this.current === record.id) { this.current = undefined; this.input = undefined; }
        for (const channel of ['stdout', 'stderr']) { this.decoders.delete(`${record.id}:${channel}`); }
    }

    private async pump(): Promise<void> {
        if (this.stopped || this.stopping || !this.nativeReady || this.dispatching || this.current || !this.queue.length ||
            this.manifest.status === 'exited' || this.manifest.status === 'unknown') { return; }
        const id = this.queue.shift()!;
        const record = this.journal.executions.get(id)!;
        if (record.state !== 'queued') { void this.pump(); return; }
        this.current = id;
        this.dispatching = true;
        try {
            if (this.config.provider === 'r') {
                await this.sessRequest('interactive_execute', { id, code: record.code, source: record.source });
            } else {
                // Visible eval respects arf's advertised policy. No silent-eval bypass.
                const code = `sess::interactive_execute(${rString(id)}, ${rString(record.code)}, jsonlite::fromJSON(${rString(JSON.stringify(record.source ?? null))}, simplifyVector=FALSE))`;
                const result = object(await arfRequest(this.arfEndpoint!, 'evaluate', { code, visible: true }, 0));
                if (result.error && this.current === id) { throw new Error(String(result.error)); }
            }
        } catch (error) {
            if (this.stopped || this.current !== id) { return; }
            this.event('condition', { kind: 'error', message: String(error) }, id);
            // Transport failures are ambiguous: never automatically retry submitted R code.
            this.journal.update({ ...this.journal.executions.get(id)!, state: 'unknown' });
            this.event('uncertain', { record: this.journal.executions.get(id) }, id, true);
            this.state('unknown');
            // Keep current until native completion or process exit establishes the outcome.
        } finally {
            this.dispatching = false;
            if (!this.current) { void this.pump(); }
        }
    }

    private async launch(): Promise<void> {
        const env = { ...process.env, R_LIBS: [this.config.library, process.env.R_LIBS].filter(Boolean).join(path.delimiter),
            SESS_ENDPOINT: path.join(this.runtime, 'sess.sock'), JGD_SOCKET: this.jgd.getSocketPath() };
        if (this.config.provider === 'arf-existing') {
            this.arfEndpoint = this.config.arfEndpoint;
            if (!this.arfEndpoint) { throw new Error('Missing arf endpoint'); }
            await this.bootstrapArf(); return;
        }
        const command = this.config.provider === 'r' ? this.config.rPath : this.config.arfPath ?? 'arf';
        const args = this.config.provider === 'r'
            ? ['--quiet', '--no-save', '--no-restore', '--interactive', '--args', this.config.library, this.bootstrap]
            : ['headless', '--json'];
        this.worker = spawn(command, args, { cwd: this.config.directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
        if (this.config.provider === 'r') {
            // --interactive intentionally reads the console rather than -f/-e input.
            this.worker.stdin!.write(`base::source(${rString(path.join(this.config.resources, 'interactive-worker.R'))}, local=new.env(parent=baseenv()))\n`);
        }
        this.worker.on('error', error => { if (!this.stopped) { this.event('agentError', { message: error.message }); this.state('exited'); } });
        this.worker.on('exit', (code, signal) => {
            if (this.stopped) { return; }
            this.event('exit', { code, signal });
            if (this.current) { this.finish(this.journal.executions.get(this.current)!, 'unknown'); }
            this.nativeReady = false; this.state('exited');
        });
        let readiness = '';
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        this.worker.stdout!.on('data', (chunk: Buffer) => {
            if (this.config.provider === 'arf' && !this.arfEndpoint) {
                readiness += chunk.toString('utf8');
                const newline = readiness.indexOf('\n');
                if (newline >= 0) {
                    try {
                        const info = object(JSON.parse(readiness.slice(0, newline)));
                        if (typeof info.socket_path !== 'string') { throw new Error('arf did not publish its endpoint'); }
                        this.arfEndpoint = info.socket_path;
                        void this.bootstrapArf().catch(error => {
                            this.event('agentError', { message: String(error) }); this.state('unknown');
                        });
                    } catch (error) { this.event('agentError', { message: String(error) }); }
                }
            } else if (!this.nativeReady || this.config.provider === 'r') {
                this.stream(stdoutDecoder.write(chunk), 'stdout', this.current);
            }
        });
        this.worker.stderr!.on('data', (chunk: Buffer) => {
            if (!this.nativeReady || this.config.provider === 'r') { this.stream(stderrDecoder.write(chunk), 'stderr', this.current); }
        });
    }

    private async bootstrapArf(): Promise<void> {
        this.dispatching = true;
        try {
            const metadata = object(await arfRequest(this.arfEndpoint!, 'session'));
            this.event('provider', { provider: this.config.provider, policy: metadata.ipc_policy });
            const code = `local({
            if ("sess" %in% loadedNamespaces() && normalizePath(getNamespaceInfo("sess", "path")) != normalizePath(${rString(path.join(this.config.library, 'sess'))})) {
                ns <- asNamespace("sess")
                if (exists("interactive_stop", ns, inherits=FALSE)) get("interactive_stop", ns)()
                else if (exists(".transport_disconnect", ns, inherits=FALSE)) get(".transport_disconnect", ns)(silent=TRUE)
                if ("package:sess" %in% search()) detach("package:sess", unload=FALSE)
                unloadNamespace("sess")
            }
            .libPaths(c(${rString(this.config.library)}, .libPaths()))
            sess::interactive_start(${rString(this.bootstrap)}, mirror=TRUE)
        })`;
            const result = object(await arfRequest(this.arfEndpoint!, 'evaluate', { code, visible: true }, 0));
            if (result.error) { throw new Error(String(result.error)); }
        } finally { this.dispatching = false; void this.pump(); }
    }

    private async startGraphics(): Promise<void> {
        if (this.config.plotBackend === 'standard') { return; }
        try {
            const probe = await run(this.config.rPath, ['--vanilla', '--slave', '-e',
                'cat(requireNamespace("jgd",quietly=TRUE) && requireNamespace("systemfonts",quietly=TRUE))'], { timeout: 15000 });
            if (probe.stdout.trim() !== 'TRUE') {
                if (this.config.plotBackend === 'jgd') { throw new Error('JGD requires the jgd and systemfonts R packages'); }
                return;
            }
            this.metrics = spawn(this.config.rPath, ['--vanilla', '--slave', '-f', path.join(this.config.resources, 'interactive-metrics.R')], { stdio: ['pipe', 'pipe', 'pipe'] });
            const parser = new JsonLines(message => {
                const pending = this.metricPending.get(Number(message.id));
                if (!pending) { return; }
                clearTimeout(pending.timer); this.metricPending.delete(Number(message.id));
                if (message.type === 'metrics_error') { pending.reject(new Error(String(message.message))); }
                else { pending.resolve(message); }
            });
            this.metrics.stdout!.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { this.metrics?.kill(); } });
            this.metrics.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
            this.metrics.on('error', error => process.stderr.write(error.message + '\n'));
            this.jgd.setGetDimensions(() => ({ width: 800, height: 600 }));
            this.jgd.setMeasureText(request => this.measure(request));
            this.jgd.setOnFrame((device, message) => {
                try { this.plot(device, message); }
                catch (error) { this.retentionWarning(error, this.current); }
            });
            await new Promise<void>(resolve => { this.jgd.onReady(resolve); this.jgd.start(); });
            this.manifest.capabilities.jgd = true;
        } catch (error) {
            if (this.config.plotBackend === 'jgd') { throw error; }
            this.event('agentWarning', { message: `JGD unavailable: ${String(error)}. Using static graphics.` });
        }
    }

    private measure(request: JgdMessage): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this.metricCounter++;
            const timer = setTimeout(() => { this.metricPending.delete(id); reject(new Error('Font metrics timed out')); }, 2000);
            this.metricPending.set(id, { resolve: value => {
                resolve({ ...object(value), id: request.id });
            }, reject, timer });
            this.metrics?.stdin?.write(JSON.stringify({ ...request, id }) + '\n');
        });
    }

    private plot(device: string, message: JgdMessage): void {
        // A historical resize is a complete frame for that plot, not the device's
        // latest plot. Its context must not replace the live drawing context.
        const replay = message.resizeReplay === true;
        const frame = replay ? message.plot : this.history.latestPlot(device);
        if (!frame) { return; }
        const operations = (message.plot?.ops ?? []) as { op: string; ext?: { executionId?: string } }[];
        if (message.newPage && !replay) { this.plotContexts.delete(device); }
        let context = replay ? frame.frameExt?.executionId : this.plotContexts.get(device) ?? frame.frameExt?.executionId;
        let drawing = false;
        let drawingContext = context;
        for (const operation of operations) {
            if (operation.op === 'beginGroup' && operation.ext?.executionId) {
                context = operation.ext.executionId;
                if (!replay) { this.plotContexts.set(device, operation.ext.executionId); }
            } else if (!['clip', 'beginGroup', 'endGroup'].includes(operation.op)) { drawing = true; drawingContext = context; }
        }
        if (!drawing) { return; }
        const executionId = typeof drawingContext === 'string' && drawingContext ? drawingContext : undefined;
        const plot = frame.rIndex ?? message.plotNumber ?? 0;
        const displayId = `plot-${executionId ?? 'session'}-${device}-${plot}`;
        // JGD may emit hundreds of incremental frames for one ggplot. Keep only
        // the latest pending frame, preserving its operation boundary if another
        // cell later appends to the same device before this batch is flushed.
        this.pendingPlots.set(displayId, { frame: { ...frame }, count: frame.ops.length, device, plot, executionId });
        if (!this.plotTimer) { this.plotTimer = setTimeout(() => this.flushPlots(), 200); }
    }

    private flushPlots(executionId?: string): void {
        if (this.stopped) { return; }
        if (!executionId) { clearTimeout(this.plotTimer); this.plotTimer = undefined; }
        for (const [displayId, pending] of this.pendingPlots) {
            if (executionId && pending.executionId !== executionId) { continue; }
            this.pendingPlots.delete(displayId);
            try {
                const { frame, count, device, plot } = pending;
                const svg = this.assets.put(plotToSvg({ ...frame, ops: frame.ops.slice(0, count) }), '.svg');
                this.display({ kind: 'plot', displayId, svg, device, plot,
                    width: frame.device.width, height: frame.device.height }, pending.executionId);
            } catch (error) { this.retentionWarning(error, pending.executionId); }
        }
    }

    private retentionWarning(error: unknown, executionId?: string): void {
        const key = executionId ?? 'session';
        if (this.retentionWarnings.has(key)) { return; }
        this.retentionWarnings.add(key);
        if (this.retentionWarnings.size > 1000) { this.retentionWarnings.delete(this.retentionWarnings.values().next().value as string); }
        this.event('truncated', { message: `Plot could not be retained: ${String(error)}` }, executionId);
    }

    private stopWorker(): void {
        if (this.stopping || this.manifest.status === 'exited') { return; }
        this.stopping = true; this.cancelQueued(); this.state('stopping');
        const worker = this.worker, console = this.console;
        const pid = this.manifest.rPid ?? worker?.pid;
        const alive = (): boolean => !this.stopped && (worker
            ? worker.exitCode === null && worker.signalCode === null
            : !!console && this.console === console && !console.destroyed);
        const signal = (signal: NodeJS.Signals): void => {
            if (!pid || !alive()) { return; }
            try { process.kill(pid, signal); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { this.event('agentWarning', { message: String(error) }); } }
        };
        // Embedded frontends can defer SIGTERM while R is evaluating. Interrupt first,
        // then bound shutdown; the Stop command has explicitly authorized process exit.
        signal('SIGINT');
        this.shutdownTimers.push(setTimeout(() => signal('SIGTERM'), 100), setTimeout(() => signal('SIGKILL'), 3000));
    }

    close(): void {
        if (this.stopped) { return; }
        this.stopped = true;
        this.shutdownTimers.forEach(clearTimeout); this.shutdownTimers = [];
        clearTimeout(this.externalTimer);
        clearTimeout(this.plotTimer); this.pendingPlots.clear();
        this.worker?.kill('SIGKILL'); this.metrics?.kill();
        this.jgd.stop(); this.assets.close();
        this.console?.destroy(); this.sess?.destroy();
        for (const client of this.clients) { client.socket.destroy(); }
        for (const server of this.servers) { server.close(); }
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Agent stopped')); }
        for (const pending of this.frontendRequests.values()) { clearTimeout(pending.timer); }
        for (const pending of this.metricPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Agent stopped')); }
        this.journal.close();
        fs.rmSync(this.runtime, { recursive: true, force: true });
    }
}

export function rString(value: string): string {
    return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

if (require.main === module) {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as AgentConfig;
    const agent = new SessionAgent(config);
    process.once('SIGTERM', () => { agent.close(); process.exit(0); });
    process.once('SIGINT', () => { agent.close(); process.exit(0); });
    void agent.start().catch(error => {
        process.stderr.write(String(error) + '\n'); agent.close(); process.exit(1);
    });
}
