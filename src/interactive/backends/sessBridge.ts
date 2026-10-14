import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JsonLines } from '../framing';
import { object } from '../protocol';
import { BackendEvent, ClientReply } from '../backend';

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/** Pure R sess transport for inspection, editor requests, and adopted events. */
export class SessBridge {
    private sess?: net.Socket;
    private sockets = new Set<net.Socket>();
    private servers: net.Server[] = [];
    private pending = new Map<number, Pending>();
    private requests = new Map<string, { socket: net.Socket; id: unknown; timer: NodeJS.Timeout }>();
    private counter = 0;
    private closed = false;
    constructor(private directory: string, private token: string,
        private emit: (event: BackendEvent) => void,
        private interactiveEvent: (message: Record<string, unknown>) => void,
        private notification: (method: string, params: Record<string, unknown>) => void) { }

    async start(): Promise<void> {
        await this.listen('sess.sock', socket => this.connectSess(socket));
    }
    private async listen(name: string, connect: (socket: net.Socket) => void): Promise<void> {
        if (this.closed) { throw new Error('Bridge disposed during startup'); }
        const endpoint = path.join(this.directory, name);
        const server = net.createServer(socket => {
            this.sockets.add(socket);
            const timer = setTimeout(() => { if (socket !== this.sess) { socket.destroy(); } }, 5000);
            socket.on('close', () => { this.sockets.delete(socket); clearTimeout(timer); });
            socket.on('error', () => socket.destroy());
            connect(socket);
        });
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
        fs.chmodSync(endpoint, 0o600);
    }
    private send(socket: net.Socket, message: unknown): void {
        if (!socket.destroyed) { socket.write(JSON.stringify(message) + '\n'); }
    }
    private parse(socket: net.Socket, callback: (message: Record<string, unknown>) => void): void {
        const parser = new JsonLines(message => { if (!this.closed) { callback(message); } });
        socket.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { socket.destroy(); } });
    }
    private connectSess(socket: net.Socket): void {
        let attached = false;
        this.parse(socket, message => {
            if (message.method === 'attach') {
                const params = object(message.params);
                if (params.protocol_version !== 2 || params.interactive_token !== this.token ||
                    (this.sess && this.sess !== socket)) { socket.destroy(); return; }
                this.sess = socket; attached = true;
                this.emit({ type: 'metadata', metadata: { rPid: Number(params.pid), rVersion: String(params.version),
                    runtimeSessionId: String(params.session_id) } });
                return;
            }
            if (!attached || this.sess !== socket) { return; }
            if (typeof message.id === 'number' && !message.method) {
                const pending = this.pending.get(message.id);
                if (!pending) { return; }
                clearTimeout(pending.timer); this.pending.delete(message.id);
                if (message.error) { pending.reject(new Error(JSON.stringify(message.error))); }
                else { pending.resolve(message.result); }
            } else if (message.method === 'interactive_event' && message.id === undefined) {
                this.interactiveEvent(object(message.params));
            } else if (typeof message.method === 'string' && message.method && message.id !== undefined) {
                const id = randomUUID();
                const timer = setTimeout(() => {
                    this.requests.delete(id);
                    this.emit({ type: 'clientRequestExpired', id });
                    this.send(socket, { jsonrpc: '2.0', id: message.id,
                        error: { code: -32000, message: 'No controlling editor replied within 30 seconds' } });
                }, 30000);
                this.requests.set(id, { socket, id: message.id, timer });
                this.emit({ type: 'clientRequest', id, method: message.method, params: message.params });
            } else if (typeof message.method === 'string' && message.method) { this.notification(message.method, object(message.params ?? {})); }
        });
        socket.on('close', () => {
            if (this.sess !== socket) { return; }
            this.sess = undefined;
            this.rejectPending();
            for (const [id, request] of this.requests) {
                clearTimeout(request.timer); this.requests.delete(id);
                if (!this.closed) { this.emit({ type: 'clientRequestExpired', id }); }
            }
            if (!this.closed) { this.emit({ type: 'unavailable', message: 'R inspection transport disconnected' }); }
        });
    }
    request(method: string, params: Record<string, unknown>, timeout = 10000): Promise<unknown> {
        const socket = this.sess;
        if (this.closed || !socket || socket.destroyed) { return Promise.reject(new Error('R session is disconnected')); }
        return new Promise((resolve, reject) => {
            const id = ++this.counter;
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('R request timed out')); }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.send(socket, { jsonrpc: '2.0', id, method, params });
        });
    }
    reply(id: string, reply: ClientReply): void {
        const request = this.requests.get(id);
        if (!request) { return; }
        clearTimeout(request.timer); this.requests.delete(id);
        this.send(request.socket, { jsonrpc: '2.0', id: request.id,
            ...(reply.error ? { error: { code: -32000, message: reply.error } } : { result: reply.result ?? null }) });
    }
    private rejectPending(): void {
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('R disconnected')); }
        this.pending.clear();
    }
    dispose(): void {
        if (this.closed) { return; }
        this.closed = true; this.rejectPending();
        for (const request of this.requests.values()) { clearTimeout(request.timer); }
        this.requests.clear();
        for (const socket of this.sockets) { socket.destroy(); }
        for (const server of this.servers) { server.close(); }
    }
}
