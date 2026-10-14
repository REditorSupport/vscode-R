import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes, randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import { JsonLines } from './framing';
import { SessionJournal, atomicJson, retainedAssetIds } from './journal';
import { AssetStore } from './assets';
import { BackendEvent, BackendFactory, SessionBackend, inspectionMethod } from './backend';
import { AGENT_PROTOCOL, AgentConfig, AgentSnapshot, ExecutionRecord, SessionEvent,
    SessionManifest, object, submission, identifier, sessionLabel } from './protocol';
import { searchHistory } from './history';

interface Client { socket: net.Socket; authenticated: boolean; subscribed: boolean; id: string }
/** This process never imports vscode and is supervised independently of the editor. */
export class SessionAgent {
    private journal: SessionJournal;
    private assets: AssetStore;
    private clients = new Set<Client>();
    private lease?: { client: string; until: number };
    private manifest: SessionManifest;
    private backend: SessionBackend;
    private unsubscribe: () => void;
    private servers: net.Server[] = [];
    private frontendRequests = new Map<number, string>();
    private nextRequest = 1;
    private queue: string[] = [];
    private current?: string;
    private input?: Record<string, unknown>;
    private workspace?: Record<string, unknown>;
    private outputBytes = new Map<string, number>();
    private truncated = new Set<string>();
    private retentionWarnings = new Set<string>();
    private backendReady = false;
    private runtime: string;
    private closing?: Promise<void>;
    private stopped = false;
    private stopping = false;
    private dispatching = false;
    private externalOutput: Record<string, unknown>[] = [];
    private externalBytes = 0;
    private externalTimer?: NodeJS.Timeout;

    constructor(private config: AgentConfig, factory: BackendFactory) {
        identifier(config.id); identifier(config.generation);
        this.runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'r-i-'));
        fs.chmodSync(this.runtime, 0o700);
        fs.mkdirSync(config.storage, { recursive: true, mode: 0o700 });
        this.journal = new SessionJournal(path.join(config.storage, config.generation), config.generation, config.maxJournalBytes);
        this.assets = new AssetStore(path.join(config.storage, 'assets'), config.maxAssetBytes, () => retainedAssetIds(config.storage));
        this.backend = factory(config);
        this.manifest = {
            protocol: AGENT_PROTOCOL, id: config.id, generation: config.generation,
            label: config.label, host: os.hostname(), directory: config.directory,
            endpoint: path.join(this.runtime, 'control.sock'), token: randomBytes(32).toString('hex'),
            agentPid: process.pid, provider: config.provider, backend: config.backend?.kind, ownership: this.backend.ownership, created: Date.now(), status: 'starting',
            capabilities: { ...this.backend.capabilities, persistent: true,
                history: true, rename: true, cancelQueued: true, assetStorage: true },
            supervision: config.supervision,
        };
        // A previous agent's accepted/running work must never be replayed automatically.
        for (const entry of this.journal.executions.values()) {
            if (entry.state === 'running' || entry.state === 'queued') {
                this.journal.update({ ...entry, state: 'unknown', ended: Date.now() });
            }
        }
        this.unsubscribe = this.backend.onEvent(event => this.backendEvent(event));
    }

    async start(): Promise<SessionManifest> {
        try {
            await this.assets.start();
            if (this.stopped) { this.assets.close(); throw new Error('Agent stopped during startup'); }
            this.manifest.assetBase = this.assets.base;
            await this.listen(this.manifest.endpoint, socket => this.connectClient(socket));
            this.saveManifest();
            await this.backend.start();
            if (this.stopped) { throw new Error('Agent stopped during startup'); }
            Object.assign(this.manifest.capabilities, this.backend.capabilities);
            this.saveManifest();
        } catch (error) { await this.close(); throw error; }
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

    private event(type: string, data: Record<string, unknown> = {}, executionId?: string, durable = false): SessionEvent {
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
            this.cancelQueued(); this.input = undefined;
        }
        this.saveManifest();
        this.event('state', { status, rPid: this.manifest.rPid, rVersion: this.manifest.rVersion, ended: this.manifest.ended,
            rPath: this.manifest.rPath, libraryPaths: this.manifest.libraryPaths, runtimeSessionId: this.manifest.runtimeSessionId,
            capabilities: this.manifest.capabilities });
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
            if (this.manifest.status === 'exited' && !this.clients.size && !this.stopped) { void this.close(); }
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
                if (this.backend.capabilities.interrupt === false) { throw new Error('This runtime does not support interruption'); }
                if (params.id && params.id !== this.current) { throw new Error('Execution is no longer running'); }
                // Inspection can still be running after its request timed out,
                // without a submitted execution in `current`.
                await this.backend.interrupt();
                break;
            case 'input':
                this.requireControl(client);
                if (!this.input || params.id !== this.input.inputId || params.executionId !== this.input.executionId) {
                    throw new Error('Input request is no longer active');
                }
                if (typeof params.value !== 'string' || /[\r\n\0]/.test(params.value) || Buffer.byteLength(params.value) > Number(this.input.maxLength ?? 4094)) {
                    throw new Error('Input must be a single line');
                }
                await this.backend.replyInput({ value: params.value });
                this.input = undefined;
                this.state('busy');
                break;
            case 'inspect':
                if (this.backend.capabilities.inspection === false) { throw new Error('This runtime does not support inspection'); }
                if (this.current) {
                    if (params.method === 'workspace') { result = this.workspace ?? {}; break; }
                    throw new Error('R is busy; cached data remains available. Retry when idle.');
                }
                result = await this.backend.inspect({ method: inspectionMethod(params.method), params: object(params.params ?? {}), timeout: 5000 });
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
                if (!this.backend.resizePlot || !this.backend.capabilities.plotResize) { throw new Error('Live plot resizing is unavailable'); }
                await this.backend.resizePlot({ device: params.device, plot: params.plot,
                    width: Math.max(100, Math.min(4096, Number(params.width) || 800)),
                    height: Math.max(100, Math.min(4096, Number(params.height) || 600)) });
                break;
            case 'clientReply': {
                this.requireControl(client);
                const pending = this.frontendRequests.get(Number(params.id));
                if (pending) {
                    this.frontendRequests.delete(Number(params.id));
                    await this.backend.replyClientRequest(pending, { error: params.error ? (typeof params.error === 'string' ? params.error : JSON.stringify(params.error)) : undefined, result: params.result });
                }
                break;
            }
            case 'detach':
                client.subscribed = false;
                if (this.lease?.client === client.id) { this.lease = undefined; }
                break;
            case 'stop':
                this.requireControl(client);
                await this.stopWorker();
                break;
            case 'shutdown':
                this.requireControl(client);
                if (this.manifest.status !== 'exited') { throw new Error('Stop R before shutting down its agent'); }
                this.send(client.socket, { id: request.id, result: true });
                setTimeout(() => { void this.close(); }, 100);
                return;
            default: throw new Error(`Unknown agent method: ${request.method}`);
        }
        this.send(client.socket, { id: request.id, result });
    }

    private backendEvent(event: BackendEvent): void {
        if (this.stopped) { return; }
        try { this.handleBackendEvent(event); }
        catch (error) {
            // Storage failures must never stop draining runtime output.
            if (event.type === 'display') {
                const key = event.executionId ?? 'session';
                if (this.retentionWarnings.has(key)) { return; }
                this.retentionWarnings.add(key);
                if (this.retentionWarnings.size > 1000) { this.retentionWarnings.delete(this.retentionWarnings.values().next().value as string); }
            }
            process.stderr.write(`Interactive event error: ${String(error)}\n`);
            try { this.event('truncated', { message: `Output could not be retained: ${String(error)}` }, event.executionId); }
            catch { this.manifest.status = 'unknown'; }
        }
    }

    private handleBackendEvent(event: BackendEvent): void {
        const executionId = event.executionId;
        switch (event.type) {
            case 'metadata': Object.assign(this.manifest, event.metadata); this.saveManifest(); break;
            case 'ready':
                if (this.manifest.status === 'exited') { break; }
                this.backendReady = true;
                Object.assign(this.manifest, event.metadata);
                Object.assign(this.manifest.capabilities, event.capabilities);
                this.state('idle'); void this.refreshWorkspace(); void this.pump(); break;
            case 'started': {
                const record = executionId && this.journal.executions.get(executionId);
                if (!record || this.current !== executionId || record.started) { break; }
                this.journal.update({ ...record, state: 'running', started: Date.now() });
                this.event('started', { order: record.order }, executionId, true); this.state('busy'); break;
            }
            case 'stream':
                if (event.external) {
                    if (this.externalBytes < this.config.maxOutputBytes) {
                        this.externalOutput.push({ text: event.text, channel: event.channel }); this.externalBytes += Buffer.byteLength(event.text);
                    }
                    this.externalTimer ??= setTimeout(() => this.flushExternal(), 100);
                } else { this.stream(event.text, event.channel, executionId); }
                break;
            case 'condition': this.event('condition', event.data, executionId); break;
            case 'truncated': this.event('truncated', { message: event.message }, executionId); break;
            case 'input':
                this.input = { ...event.data, executionId: executionId ?? this.current };
                this.event('input', this.input, executionId); this.state('input'); break;
            case 'display': this.display(event.data, executionId); break;
            case 'notification': case 'viewer': this.event(event.type, { method: event.method, params: event.params }, executionId); break;
            case 'workspaceChanged': if (!this.current) { void this.refreshWorkspace(); } break;
            case 'clientRequest': {
                const id = this.nextRequest++;
                this.frontendRequests.set(id, event.id);
                this.event('clientRequest', { id, method: event.method, params: event.params }, executionId); break;
            }
            case 'clientRequestExpired':
                for (const [id, backendId] of this.frontendRequests) { if (backendId === event.id) { this.frontendRequests.delete(id); } }
                break;
            case 'finished': {
                const record = executionId && this.journal.executions.get(executionId);
                if (!record || this.current !== executionId) { break; }
                this.finish(record, event.state); this.state(this.backendReady ? 'idle' : 'unknown');
                void this.refreshWorkspace().finally(() => { void this.pump(); }); break;
            }
            case 'external': this.flushExternal(event.code, event.success); void this.refreshWorkspace(); break;
            case 'warning': case 'error': this.event(event.type === 'warning' ? 'agentWarning' : 'agentError', { message: event.message }); break;
            case 'provider': this.event('provider', event.data); break;
            case 'unavailable':
                if (this.manifest.status === 'exited') { break; }
                this.backendReady = false;
                if (this.current) { this.uncertain(this.current, event.message); }
                this.state('unknown'); break;
            case 'exit':
                this.backendReady = false;
                this.event('exit', { code: event.code, signal: event.signal });
                if (this.current) { this.finish(this.journal.executions.get(this.current)!, 'unknown'); }
                this.state('exited'); break;
        }
    }

    private flushExternal(code?: string, success = true): void {
        clearTimeout(this.externalTimer); this.externalTimer = undefined;
        if (this.stopped || (!code && !this.externalOutput.length)) { return; }
        // Some frontends cannot report terminal execution boundaries. Preserve their
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
        // Bound event sizes even for a single very large console write.
        const decoder = new StringDecoder('utf8');
        for (let start = 0; start < Math.min(bytes.length, remaining); start += 32768) {
            this.event('stream', { text: decoder.write(bytes.subarray(start, Math.min(start + 32768, remaining))), channel }, executionId);
        }
        if (bytes.length > remaining) { this.event('truncated', { message: 'Output exceeded the configured per-execution limit.' }, executionId); this.truncated.add(key); }
    }

    private display(data: Record<string, unknown>, executionId?: string): void {
        const display: Record<string, unknown> = { ...data, displayId: typeof data.displayId === 'string' ? data.displayId : randomUUID() };
        if (data.kind === 'plot' && typeof data.svg === 'string') { display.svg = this.assets.put(data.svg, '.svg'); }
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

    private async refreshWorkspace(): Promise<void> {
        if (this.stopped || !this.backendReady || this.current || this.manifest.capabilities.inspection === false) { return; }
        try {
            const workspace = object(await this.backend.inspect({ method: 'workspace', params: {}, timeout: 2000 }));
            if (this.stopped) { return; }
            this.workspace = workspace;
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
        const final = { ...record, state, ended: Date.now() };
        this.journal.update(final);
        this.event('finished', { state, record: final }, record.id, true);
        if (this.current === record.id) { this.current = undefined; this.input = undefined; }
    }

    private async pump(): Promise<void> {
        if (this.stopped || this.stopping || !this.backendReady || this.dispatching || this.current || !this.queue.length ||
            this.manifest.status === 'exited' || this.manifest.status === 'unknown') { return; }
        const id = this.queue.shift()!;
        const record = this.journal.executions.get(id)!;
        if (record.state !== 'queued') { void this.pump(); return; }
        this.current = id;
        this.dispatching = true;
        try {
            await this.backend.dispatch(record);
        } catch (error) {
            if (this.stopped || this.current !== id) { return; }
            this.uncertain(id, String(error));
            this.state('unknown');
            // Keep current until completion or confirmed process exit establishes the outcome.
        } finally {
            this.dispatching = false;
            if (!this.current) { void this.pump(); }
        }
    }

    private uncertain(id: string, message: string): void {
        this.event('condition', { kind: 'error', message }, id);
        this.journal.update({ ...this.journal.executions.get(id)!, state: 'unknown' });
        this.event('uncertain', { record: this.journal.executions.get(id) }, id, true);
    }

    private async stopWorker(): Promise<void> {
        if (this.stopping || this.manifest.status === 'exited') { return; }
        this.stopping = true; this.cancelQueued(); this.state('stopping');
        await this.backend.stop();
    }

    close(): Promise<void> {
        if (this.closing) { return this.closing; }
        this.stopped = true; this.unsubscribe();
        clearTimeout(this.externalTimer);
        this.assets.close();
        for (const client of this.clients) { client.socket.destroy(); }
        for (const server of this.servers) { server.close(); }
        this.frontendRequests.clear();
        this.journal.close();
        fs.rmSync(this.runtime, { recursive: true, force: true });
        return this.closing = this.backend.dispose();
    }
}
