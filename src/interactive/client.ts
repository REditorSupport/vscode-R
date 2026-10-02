import * as net from 'net';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { JsonLines } from './framing';
import { AGENT_PROTOCOL, AgentSnapshot, SessionEvent, SessionManifest } from './protocol';

export class AgentClient extends EventEmitter {
    private socket?: net.Socket;
    private counter = 0;
    private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    private heartbeat?: NodeJS.Timeout;
    private replaying?: SessionEvent[];
    private closing = false;
    private ready = false;
    control = false;
    get connected(): boolean { return this.ready && this.socket !== undefined && !this.socket.destroyed; }

    constructor(public manifest: SessionManifest, readonly clientId: string = randomUUID()) { super(); }

    async connect(options: { claim?: boolean; timeout?: number } = {}): Promise<void> {
        this.close();
        this.closing = false;
        const socket = net.createConnection(this.manifest.endpoint);
        this.socket = socket;
        const parser = new JsonLines(message => {
            if (message.event) {
                if (this.replaying) { this.replaying.push(message.event as SessionEvent); }
                else { this.emit('event', message.event as SessionEvent); }
                return;
            }
            const id = Number(message.id);
            const pending = this.pending.get(id);
            if (!pending) { return; }
            clearTimeout(pending.timer); this.pending.delete(id);
            if (message.error) { pending.reject(new Error(String(message.error))); }
            else { pending.resolve(message.result); }
        });
        socket.on('data', (chunk: Buffer) => {
            try { parser.push(chunk); } catch (error) { socket.destroy(error instanceof Error ? error : undefined); }
        });
        socket.on('error', () => { /* close rejects every outstanding request. */ });
        socket.on('close', () => {
            if (this.socket !== socket) { return; }
            this.ready = false; this.control = false;
            clearInterval(this.heartbeat);
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timer); pending.reject(new Error('Session agent disconnected'));
            }
            this.pending.clear();
            if (!this.closing) { this.emit('disconnect'); }
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('Agent connection timed out')); }, options.timeout ?? 5000);
            socket.once('connect', () => { clearTimeout(timer); resolve(); });
            socket.once('error', error => { clearTimeout(timer); reject(error); });
        });
        const manifest = await this.request<SessionManifest>('hello', {
            protocol: AGENT_PROTOCOL, token: this.manifest.token, clientId: this.clientId,
        }, options.timeout);
        if (manifest.id !== this.manifest.id || manifest.generation !== this.manifest.generation) {
            throw new Error('R session identity changed; refresh the session list before connecting');
        }
        this.manifest = manifest;
        this.control = options.claim === false ? false : await this.request<boolean>('claim', {}, options.timeout);
        this.ready = true; this.emit('activity');
        this.heartbeat = setInterval(() => {
            void this.request<{ control: boolean; status: SessionManifest['status'] }>('heartbeat').then(value => {
                this.control = value.control; this.manifest.status = value.status; this.emit('activity');
            }).catch(() => socket.destroy());
        }, 20000);
        this.heartbeat.unref();
    }

    async subscribe(after: number): Promise<boolean> {
        let cursor = after;
        const live: SessionEvent[] = [];
        this.replaying = live;
        try {
            for (;;) {
                const replay = await this.request<{ events: SessionEvent[]; reset: boolean; seq: number }>('subscribe', { after: cursor });
                if (replay.reset) { return false; }
                for (const event of replay.events) { this.emit('event', event); cursor = event.seq; }
                if (cursor >= replay.seq) {
                    // A socket read can contain both the response and newer events.
                    // Deliver replay first, before the transcript advances its cursor.
                    for (const event of live) {
                        if (event.seq > cursor) { this.emit('event', event); cursor = event.seq; }
                    }
                    return true;
                }
            }
        } finally { if (this.replaying === live) { this.replaying = undefined; } }
    }

    snapshot(limit = 50): Promise<AgentSnapshot> { return this.request('snapshot', { limit }); }

    request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
        const socket = this.socket;
        if (!socket || socket.destroyed) { return Promise.reject(new Error('Session agent is disconnected')); }
        return new Promise<T>((resolve, reject) => {
            const id = ++this.counter;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Session request '${method}' timed out; submitted code may still be running`));
            }, timeout);
            this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
            socket.write(JSON.stringify({ id, method, params: { generation: this.manifest.generation, ...params } }) + '\n');
        });
    }

    close(): void {
        this.closing = true;
        this.replaying = undefined;
        this.ready = false; this.control = false;
        clearInterval(this.heartbeat);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Session agent disconnected')); }
        this.pending.clear();
        this.socket?.destroy();
    }
}

/** Read live status without claiming control or subscribing to output. */
export async function probeSession(manifest: SessionManifest, timeout = 1000): Promise<SessionManifest | undefined> {
    const client = new AgentClient(manifest);
    try {
        await client.connect({ claim: false, timeout });
        return client.manifest;
    } catch { return undefined; }
    finally { client.close(); }
}
