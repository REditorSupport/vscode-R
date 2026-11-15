import * as net from 'net';
import { JsonLines } from './framing';
import { object } from './protocol';
import { ArfTransportTimeoutError, rpcError } from './arf';

/** One event notification from an attached arf connection. */
export interface ArfEvent {
    seq: number;
    topic: string;
    data: unknown;
    /** arf's execution ID, or null when the event belongs to no execution. */
    execution: number | null;
}

export interface ArfAttachResult {
    connectionId: number;
    apiVersion: number;
    capabilities: string[];
    sessionId: string;
    session: Record<string, unknown>;
}

export interface ArfAttachOptions {
    subscribe?: string[];
    client?: { name: string; version?: string };
    /** Bounds connecting and the attach response, not later requests. */
    timeout?: number;
    /** Registered before attaching, so no event after the response is missed. */
    onEvent?: (event: ArfEvent) => void;
    onClose?: (reason: Error) => void;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer?: NodeJS.Timeout;
}

/**
 * A long-lived arf IPC connection (newline-delimited JSON-RPC).
 *
 * Responses are matched by ID because they arrive in completion order. A
 * request whose wait ends locally (timeout or abort) may still run in R; its
 * late response is ignored and its ID is never reused. The connection closes
 * once, rejecting every pending request with the same reason, and is never
 * reopened: callers attach again and reconcile their own state.
 */
export class ArfAttachConnection {
    private pending = new Map<number, Pending>();
    private nextId = 1;
    private closeReason?: Error;

    private constructor(
        private socket: net.Socket,
        private onClose?: (reason: Error) => void,
    ) {}

    static open(
        endpoint: string,
        options: ArfAttachOptions = {},
    ): Promise<{ connection: ArfAttachConnection; result: ArfAttachResult }> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(endpoint);
            const connection = new ArfAttachConnection(socket, options.onClose);
            const attachId = connection.nextId++;
            let attached = false;
            const timer = setTimeout(
                () => connection.close(new ArfTransportTimeoutError()),
                options.timeout ?? 30000,
            );
            connection.pending.set(attachId, {
                resolve: (value) => {
                    clearTimeout(timer);
                    try {
                        const result = object(value);
                        attached = true;
                        resolve({
                            connection,
                            result: {
                                connectionId: Number(result.connection_id),
                                apiVersion: Number(result.api_version),
                                capabilities: Array.isArray(result.capabilities)
                                    ? result.capabilities.map(String)
                                    : [],
                                sessionId:
                                    typeof result.session_id === 'string' ? result.session_id : '',
                                session: object(result.session),
                            },
                        });
                    } catch (error) {
                        connection.close(error as Error);
                        reject(error);
                    }
                },
                reject: (error) => {
                    clearTimeout(timer);
                    // arf closes the connection after refusing attach.
                    connection.close(error);
                    reject(error);
                },
            });
            const parser = new JsonLines((message) => {
                // No event is sent before the attach response.
                if (message.method === 'event' && attached) {
                    options.onEvent?.(event(message.params));
                } else if (message.id !== undefined) {
                    connection.response(message);
                }
            });
            socket.on('data', (chunk: Buffer) => {
                try {
                    parser.push(chunk);
                } catch (error) {
                    connection.close(error as Error);
                }
            });
            socket.on('error', (error) => connection.close(error));
            socket.on('close', () => connection.close(new Error('arf closed the IPC connection')));
            socket.write(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: attachId,
                    method: 'attach',
                    params: {
                        protocol: 1,
                        subscribe: options.subscribe ?? [],
                        client: options.client ?? { name: 'vscode-R' },
                    },
                }) + '\n',
            );
        });
    }

    get closed(): Error | undefined {
        return this.closeReason;
    }

    request(
        method: string,
        params: Record<string, unknown> = {},
        options: { timeout?: number; signal?: AbortSignal } = {},
    ): Promise<unknown> {
        if (this.closeReason) {
            return Promise.reject(this.closeReason);
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const settle = (): void => {
                clearTimeout(entry.timer);
                options.signal?.removeEventListener('abort', abort);
                this.pending.delete(id);
            };
            const abort = (): void => {
                settle();
                reject(new Error('arf request was aborted; it may still be running'));
            };
            const entry: Pending = {
                resolve: (value) => {
                    settle();
                    resolve(value);
                },
                reject: (error) => {
                    settle();
                    reject(error);
                },
            };
            if (options.timeout && options.timeout > 0) {
                entry.timer = setTimeout(() => {
                    settle();
                    reject(new ArfTransportTimeoutError());
                }, options.timeout);
            }
            if (options.signal?.aborted) {
                abort();
                return;
            }
            options.signal?.addEventListener('abort', abort, { once: true });
            this.pending.set(id, entry);
            this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    close(reason: Error = new Error('arf IPC connection was closed')): void {
        if (this.closeReason) {
            return;
        }
        this.closeReason = reason;
        for (const entry of this.pending.values()) {
            entry.reject(reason);
        }
        this.pending.clear();
        this.socket.destroy();
        this.onClose?.(reason);
    }

    private response(message: Record<string, unknown>): void {
        const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!entry) {
            // A request that timed out or was aborted locally.
            return;
        }
        this.pending.delete(Number(message.id));
        if (message.error !== undefined) {
            entry.reject(rpcError(message.error));
        } else {
            entry.resolve(message.result);
        }
    }
}

function event(params: unknown): ArfEvent {
    const value = object(params);
    return {
        seq: Number(value.seq),
        topic: String(value.topic),
        data: value.data,
        execution: Number.isSafeInteger(value.execution) ? Number(value.execution) : null,
    };
}
