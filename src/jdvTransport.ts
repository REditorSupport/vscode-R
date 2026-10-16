'use strict';

// Extension-host side of the jdv local transport (see `?jdv_spec`). R connects
// to a listener owned by one vscode-R session and exchanges JSON Lines, with
// Arrow IPC bodies following `stream/next` response headers.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { JdvChannel, JdvRequestError, JsonObject } from './jdvAdapter';

const PROTOCOL_MAJOR = 1;
const MAX_LIVE_REQUESTS = 32;
const WAKE_INTERVAL_MS = 50;
const MAX_JSON_LINE_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_HEADER_BYTES = 64 * 1024;
const MAX_BINARY_FRAME_BYTES = 10 * 1024 * 1024;
const BINARY_BODY_TIMEOUT_MS = 30_000;

export interface JdvResponse {
    result: unknown;
    /** Arrow IPC body for responses carrying `result.transfer`. */
    body?: Uint8Array;
}

interface RLimits {
    maxReceiveFrames: number;
    maxReceiveBytes: number;
    maxRequestBytes: number;
}

interface OutboundFrame {
    bytes: Buffer;
    wake?: boolean;
}

interface PendingRequest {
    resolve(response: JdvResponse): void;
    reject(error: Error): void;
    view?: unknown;
    generation?: unknown;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** One R connection. Implements the host obligations of the jdv transport. */
export class JdvPeer implements JdvChannel {
    private buffer: Buffer = Buffer.alloc(0);
    private body?: { header: JsonObject; length: number; timer: NodeJS.Timeout };
    private limits?: RLimits;
    private readonly outbound: OutboundFrame[] = [];
    /** Bytes of frames written but not yet acknowledged, in send order. */
    private readonly unconfirmed: number[] = [];
    private unconfirmedBytes = 0;
    private sentFrames = 0;
    private ackedFrames = 0;
    private readonly pending = new Map<string, PendingRequest>();
    private wakeTimer?: NodeJS.Timeout;
    private sequence = 0;
    private closed = false;
    session?: string;
    pid?: number;

    constructor(
        private readonly socket: net.Socket,
        private readonly handlers: {
            hello(peer: JdvPeer, params: JsonObject): boolean;
            notification(peer: JdvPeer, method: string, params: JsonObject): void;
            closed(peer: JdvPeer, reason: string): void;
        },
    ) {
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', error => this.close(`jdv connection error: ${error.message}`));
        socket.on('close', () => this.close('The R session closed the jdv connection.'));
    }

    get isClosed(): boolean {
        return this.closed;
    }

    async request(method: string, params: JsonObject): Promise<unknown> {
        return (await this.requestWithBody(method, params)).result;
    }

    requestWithBody(method: string, params: JsonObject): Promise<JdvResponse> {
        if (this.closed) {
            return Promise.reject(new JdvRequestError('view_not_found', 'The jdv connection is closed.'));
        }
        if (this.pending.size >= MAX_LIVE_REQUESTS) {
            return Promise.reject(new JdvRequestError('limit_exceeded', 'Too many pending jdv requests.'));
        }
        const id = `vscode-r-${++this.sequence}`;
        const bytes = Buffer.from(JSON.stringify({ id, method, params }) + '\n', 'utf8');
        if (this.limits && bytes.length > this.limits.maxRequestBytes) {
            return Promise.reject(new JdvRequestError('limit_exceeded', 'The jdv request is too large.'));
        }
        return new Promise<JdvResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, view: params.view, generation: params.generation });
            this.outbound.push({ bytes });
            this.flush();
            this.updateWake();
        });
    }

    close(reason: string): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.body) {
            clearTimeout(this.body.timer);
            this.body = undefined;
        }
        this.stopWake();
        for (const pending of this.pending.values()) {
            pending.reject(new JdvRequestError('view_not_found', reason));
        }
        this.pending.clear();
        this.socket.destroy();
        this.handlers.closed(this, reason);
    }

    private receive(chunk: Buffer): void {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        try {
            while (!this.closed) {
                if (this.body) {
                    if (this.buffer.length < this.body.length) {
                        return;
                    }
                    const { header, length, timer } = this.body;
                    clearTimeout(timer);
                    this.body = undefined;
                    // Copy so a retained page does not keep the receive buffer alive.
                    const body = new Uint8Array(this.buffer.subarray(0, length));
                    this.buffer = this.buffer.subarray(length);
                    this.dispatch(header, body);
                    continue;
                }
                const newline = this.buffer.indexOf(0x0a);
                if (newline < 0) {
                    if (this.buffer.length > MAX_JSON_LINE_BYTES) {
                        throw new Error('A jdv message exceeds the size limit.');
                    }
                    return;
                }
                const line = this.buffer.subarray(0, newline);
                this.buffer = this.buffer.subarray(newline + 1);
                const message = JSON.parse(line.toString('utf8')) as unknown;
                if (!isObject(message)) {
                    throw new Error('Invalid jdv message.');
                }
                const transfer = isObject(message.result) ? message.result.transfer : undefined;
                if (isObject(transfer) && transfer.encoding === 'arrow-ipc') {
                    const length = transfer.byte_length;
                    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 ||
                        typeof message.id !== 'string' || line.length > MAX_BINARY_HEADER_BYTES ||
                        line.length + 1 + length > MAX_BINARY_FRAME_BYTES) {
                        throw new Error('Invalid jdv binary frame.');
                    }
                    const timer = setTimeout(() => this.close('Timed out receiving a jdv Arrow page.'),
                        BINARY_BODY_TIMEOUT_MS);
                    this.body = { header: message, length, timer };
                    continue;
                }
                this.dispatch(message);
            }
        } catch (e) {
            this.close(e instanceof Error ? e.message : String(e));
        }
    }

    private dispatch(message: JsonObject, body?: Uint8Array): void {
        if (typeof message.method === 'string') {
            const params = isObject(message.params) ? message.params : {};
            if (message.method === 'hello') {
                this.acceptHello(params);
            } else if (message.method === 'ack') {
                this.acknowledge(params);
            } else if (this.limits) {
                this.handlers.notification(this, message.method, params);
            }
            return;
        }
        if (typeof message.id !== 'string') {
            // Best-effort errors for malformed requests carry a null id.
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        this.updateWake();
        if (isObject(message.error)) {
            const { code, message: text } = message.error;
            pending.reject(new JdvRequestError(typeof code === 'string' ? code : 'unknown',
                typeof text === 'string' ? text : 'jdv request failed'));
            return;
        }
        const result = message.result;
        if (body && isObject(result) && (result.view !== pending.view || result.generation !== pending.generation)) {
            pending.reject(new JdvRequestError('stale_generation', 'The Arrow page belongs to another view generation.'));
            return;
        }
        pending.resolve({ result, body });
    }

    private acceptHello(params: JsonObject): void {
        if (this.limits) {
            throw new Error('Duplicate jdv hello.');
        }
        const version = typeof params.protocol === 'number' ? Math.trunc(params.protocol) : NaN;
        if (version !== PROTOCOL_MAJOR) {
            throw new Error(`Unsupported jdv protocol: ${String(params.protocol)}`);
        }
        const limits = isObject(params.limits) ? params.limits : {};
        this.limits = {
            maxReceiveFrames: positiveInteger(limits.max_receive_frames, 264),
            maxReceiveBytes: positiveInteger(limits.max_receive_bytes, 64 * 1024),
            maxRequestBytes: positiveInteger(limits.max_request_bytes, 1024 * 1024),
        };
        this.session = typeof params.session === 'string' ? params.session : undefined;
        this.pid = typeof params.pid === 'number' ? params.pid : undefined;
        if (!this.handlers.hello(this, params)) {
            throw new Error('The jdv connection does not belong to this R session.');
        }
        this.flush();
    }

    private acknowledge(params: JsonObject): void {
        const frames = params.frames;
        if (typeof frames !== 'number' || !Number.isSafeInteger(frames) || frames < this.ackedFrames ||
            frames > this.sentFrames) {
            throw new Error('Invalid jdv acknowledgement.');
        }
        while (this.ackedFrames < frames) {
            this.unconfirmedBytes -= this.unconfirmed.shift() ?? 0;
            this.ackedFrames++;
        }
        this.flush();
    }

    /** Write queued frames while the cumulative unconfirmed output fits R's receive quota. */
    private flush(): void {
        const limits = this.limits;
        if (!limits || this.closed) {
            return;
        }
        while (this.outbound.length > 0) {
            const frame = this.outbound[0];
            if (this.unconfirmed.length + 1 > limits.maxReceiveFrames ||
                this.unconfirmedBytes + frame.bytes.length > limits.maxReceiveBytes) {
                return;
            }
            this.outbound.shift();
            this.unconfirmed.push(frame.bytes.length);
            this.unconfirmedBytes += frame.bytes.length;
            this.sentFrames++;
            this.socket.write(frame.bytes);
        }
    }

    /** R dispatches queued requests only when woken; wake while any request is pending. */
    private updateWake(): void {
        if (this.pending.size === 0) {
            this.stopWake();
        } else if (!this.wakeTimer) {
            this.wakeTimer = setInterval(() => {
                // At most one queued wake; skip while frames are waiting for credit.
                if (this.outbound.length === 0) {
                    this.outbound.push({ bytes: Buffer.from('{"method":"wake"}\n'), wake: true });
                    this.flush();
                }
            }, WAKE_INTERVAL_MS);
        }
    }

    private stopWake(): void {
        if (this.wakeTimer) {
            clearInterval(this.wakeTimer);
            this.wakeTimer = undefined;
        }
        for (let i = this.outbound.length - 1; i >= 0; i--) {
            if (this.outbound[i].wake) {
                this.outbound.splice(i, 1);
            }
        }
    }
}

export interface JdvHostEvents {
    /** `view/open` received from R. */
    viewOpen(peer: JdvPeer, params: JsonObject): void;
    /** `view/closed` received from R. */
    viewClosed(peer: JdvPeer, view: string, generation: number): void;
    /** The R connection closed; its views are gone. */
    disconnected(peer: JdvPeer, reason: string): void;
}

/**
 * A listener owned by one vscode-R session. Its address is handed to that R
 * session only, so jdv never connects through a shared discovery file.
 */
export class JdvHost {
    private peer?: JdvPeer;

    private constructor(
        private readonly server: net.Server,
        /** Address in jdv's syntax, for `options(jdv.address = ...)`. */
        readonly address: string,
        private readonly socketPath: string,
        private readonly expectedPid: number | undefined,
        private readonly events: JdvHostEvents,
    ) {
        server.on('connection', socket => this.accept(socket));
    }

    static async create(expectedPid: number | undefined, events: JdvHostEvents): Promise<JdvHost> {
        const id = crypto.randomBytes(8).toString('hex');
        // Unix socket paths are limited to about 104-108 bytes; keep the name short.
        const socketPath = process.platform === 'win32'
            ? `\\\\.\\pipe\\vscode-r-jdv-${id}`
            : path.join(os.tmpdir(), `vscr-jdv-${id}.sock`);
        const address = process.platform === 'win32' ? `npipe:////./pipe/vscode-r-jdv-${id}` : socketPath;
        const server = net.createServer();
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => {
                server.off('error', reject);
                resolve();
            });
        });
        if (process.platform !== 'win32') {
            fs.chmodSync(socketPath, 0o600);
        }
        return new JdvHost(server, address, socketPath, expectedPid, events);
    }

    get connection(): JdvPeer | undefined {
        return this.peer && !this.peer.isClosed ? this.peer : undefined;
    }

    dispose(): void {
        this.peer?.close('The R session ended.');
        this.server.close();
        if (process.platform !== 'win32') {
            fs.rmSync(this.socketPath, { force: true });
        }
    }

    private accept(socket: net.Socket): void {
        // jdv opens a new connection after a disconnect; only one is active.
        this.peer?.close('The R session opened a new jdv connection.');
        this.peer = new JdvPeer(socket, {
            hello: (_peer, params) => this.expectedPid === undefined || params.pid === this.expectedPid,
            notification: (peer, method, params) => {
                if (method === 'view/open') {
                    this.events.viewOpen(peer, params);
                } else if (method === 'view/closed' && typeof params.view === 'string' &&
                    typeof params.generation === 'number') {
                    this.events.viewClosed(peer, params.view, params.generation);
                }
            },
            closed: (peer, reason) => this.events.disconnected(peer, reason),
        });
    }
}
