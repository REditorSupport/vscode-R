import type { Socket } from 'node:net';

export interface RpcRequestOptions {
    signal?: AbortSignal;
    timeout?: number;
}

interface PendingRequest {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
    timer: NodeJS.Timeout;
    removeAbortListener?: () => void;
}

function cancelledRequest(): Error {
    const error = new Error('Request cancelled');
    error.name = 'AbortError';
    return error;
}

/** Cancel an editor's wait without treating cancellation as an R interruption. */
export function withRpcCancellation<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) {
        return operation();
    }
    if (signal.aborted) {
        return Promise.reject(cancelledRequest());
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(cancelledRequest());
        };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
            .then(() => {
                if (signal.aborted) {
                    throw cancelledRequest();
                }
                return operation();
            })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Native sess request state belongs to one socket incarnation. */
export class NativeRpcConnection {
    private sequence = 0;
    private pending = new Map<number, PendingRequest>();
    private closed = false;

    constructor(private readonly socket: Pick<Socket, 'write' | 'destroyed'>) {}

    request(data: Record<string, unknown>, options: RpcRequestOptions = {}): Promise<unknown> {
        if (this.closed || this.socket.destroyed) {
            return Promise.reject(new Error('IPC socket is not connected'));
        }
        if (options.signal?.aborted) {
            return Promise.reject(cancelledRequest());
        }
        if (this.sequence >= Number.MAX_SAFE_INTEGER) {
            return Promise.reject(new Error('IPC request IDs exhausted; reconnect the session'));
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const finish = (error?: unknown, value?: unknown): void => {
                if (this.pending.get(id) !== pending) {
                    return;
                }
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.removeAbortListener?.();
                if (error !== undefined) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };
            const pending: PendingRequest = {
                resolve: (value) => finish(undefined, value),
                reject: (error) => finish(error),
                timer: setTimeout(
                    () => finish(new Error('Request timed out')),
                    options.timeout ?? 5000,
                ),
            };
            this.pending.set(id, pending);
            const signal = options.signal;
            if (signal) {
                const abort = () => finish(cancelledRequest());
                signal.addEventListener('abort', abort, { once: true });
                pending.removeAbortListener = () => signal.removeEventListener('abort', abort);
            }
            try {
                // Transport IDs always belong to this connection, even when a
                // caller supplies a complete JSON-RPC object with its own ID.
                this.socket.write(JSON.stringify({ jsonrpc: '2.0', ...data, id }) + '\n');
            } catch (error) {
                finish(error);
            }
        });
    }

    response(message: Record<string, unknown>): void {
        const pending = this.pending.get(Number(message.id));
        if (!pending) {
            return;
        }
        if (message.error) {
            pending.reject(message.error);
        } else {
            pending.resolve(message.result);
        }
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(new Error('IPC socket disconnected'));
        }
    }
}

// Native responses can contain full workspace metadata and rendered plot data.
// Keep the ceiling well above Interactive's paged 4 MiB protocol frames.
export const MAX_NATIVE_RPC_FRAME_BYTES = 64 * 1024 * 1024;

/** Buffer split UTF-8 frames once, with a ceiling before concatenation/decoding. */
export class NativeRpcFrames {
    private chunks: Buffer[] = [];
    private length = 0;

    constructor(
        private readonly receive: (frame: Buffer) => void,
        private readonly limit = MAX_NATIVE_RPC_FRAME_BYTES,
    ) {}

    push(data: Buffer): void {
        let start = 0;
        while (start < data.length) {
            const newline = data.indexOf(0x0a, start);
            const end = newline < 0 ? data.length : newline;
            const incoming = data.subarray(start, end);
            if (this.length + incoming.length > this.limit) {
                this.clear();
                throw new Error('Native IPC frame exceeds size limit');
            }
            if (newline < 0) {
                if (incoming.length) {
                    this.chunks.push(incoming);
                    this.length += incoming.length;
                }
                return;
            }
            let frame = incoming;
            if (this.chunks.length) {
                if (incoming.length) {
                    this.chunks.push(incoming);
                }
                frame = Buffer.concat(this.chunks, this.length + incoming.length);
                this.clear();
            }
            if (frame.length) {
                this.receive(frame);
            }
            start = end + 1;
        }
    }

    clear(): void {
        this.chunks = [];
        this.length = 0;
    }
}
