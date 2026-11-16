import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { object, MAX_MESSAGE_BYTES } from './protocol';

export interface ArfSession {
    pid: number;
    socket_path: string;
    cwd?: string;
    r_version?: string;
    started_at?: string;
    session_type?: string;
}

// 0.7.2-rc.1 keeps forked R workers from crashing on macOS, reports an R error
// that follows a caught interrupt as an error rather than as interrupted, and
// bounds console reads that cannot be answered.
// TODO: Require arf 0.7.2 once it is released.
export const MIN_ARF_VERSION = '0.7.2-rc.1';

/** arf JSON-RPC error codes that the Interactive client acts on. */
export const ARF_METHOD_NOT_FOUND = -32601;
export const ARF_TIMEOUT = -32007;
/** Errors of the `call` method. */
export const ARF_HANDLER_NOT_FOUND = -32010;
export const ARF_HANDLER_QUEUE_FULL = -32011;
export const ARF_HANDLER_QUEUE_TIMEOUT = -32012;
export const ARF_HANDLER_R_ERROR = -32014;
export const ARF_HANDLER_INTERRUPTED = -32016;
export const ARF_HANDLER_EXECUTION_TIMEOUT = -32019;

/** A JSON-RPC error response from arf, keeping its code and data. */
export class ArfRpcError extends Error {
    constructor(
        readonly code: number,
        readonly rpcMessage: string,
        readonly data: unknown,
        raw: unknown,
    ) {
        super(JSON.stringify(raw));
        this.name = 'ArfRpcError';
    }
}

/** The client stopped waiting for arf; the request may still be running. */
export class ArfTransportTimeoutError extends Error {
    constructor() {
        super('arf request timed out; evaluation may still be running');
        this.name = 'ArfTransportTimeoutError';
    }
}

export function rpcError(error: unknown): ArfRpcError {
    const value =
        error && typeof error === 'object' && !Array.isArray(error)
            ? (error as Record<string, unknown>)
            : {};
    return new ArfRpcError(
        typeof value.code === 'number' ? value.code : NaN,
        typeof value.message === 'string' ? value.message : '',
        value.data,
        error,
    );
}

/**
 * Whether `version` has at least the precedence of `minimum` under SemVer 2.0.0:
 * a prerelease is older than its release, and prerelease identifiers compare
 * field by field (numbers numerically and below text). Build metadata is ignored.
 */
export function arfVersionAtLeast(version: unknown, minimum: string): boolean {
    const parse = (text: string) => {
        const match =
            /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
                text,
            );
        return match
            ? {
                  core: [Number(match[1]), Number(match[2]), Number(match[3])],
                  pre: match[4]?.split('.') ?? [],
              }
            : undefined;
    };
    const actual = typeof version === 'string' ? parse(version) : undefined;
    const required = parse(minimum);
    if (!actual || !required) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (actual.core[i] !== required.core[i]) {
            return actual.core[i] > required.core[i];
        }
    }
    // A release is newer than any of its prereleases.
    if (!actual.pre.length || !required.pre.length) {
        return !actual.pre.length;
    }
    const numeric = /^\d+$/;
    for (let i = 0; i < Math.min(actual.pre.length, required.pre.length); i++) {
        const [a, b] = [actual.pre[i], required.pre[i]];
        if (a === b) {
            continue;
        }
        if (numeric.test(a) && numeric.test(b)) {
            return Number(a) > Number(b);
        }
        if (numeric.test(a) !== numeric.test(b)) {
            return !numeric.test(a);
        }
        return a > b;
    }
    // With equal leading identifiers, the longer prerelease is newer.
    return actual.pre.length >= required.pre.length;
}

/** Rejects sessions older than MIN_ARF_VERSION, or without the deadline used by inspection. */
export function checkArfSession(session: Record<string, unknown>): void {
    if (!arfVersionAtLeast(session.arf_version, MIN_ARF_VERSION)) {
        const actual =
            typeof session.arf_version === 'string' ? session.arf_version : 'an unknown version';
        throw new Error(
            `R Interactive requires arf ${MIN_ARF_VERSION} or later, but the session runs ${actual}. Update arf and start a new session.`,
        );
    }
    const capabilities = Array.isArray(session.capabilities) ? session.capabilities : [];
    if (!capabilities.includes('call_execution_timeout')) {
        throw new Error(
            'This arf session does not support execution deadlines for handler calls. Update arf and start a new session.',
        );
    }
}

/** arf speaks HTTP JSON-RPC, not sess's JSON Lines framing. */
export function arfRequest(
    endpoint: string,
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30000,
    signal?: AbortSignal,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const request = http.request(
            {
                socketPath: endpoint,
                path: '/',
                method: 'POST',
                agent: false,
                signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    Connection: 'close',
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_MESSAGE_BYTES) {
                        request.destroy(new Error('arf response exceeds size limit'));
                    } else {
                        chunks.push(chunk);
                    }
                });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                        if (result.error) {
                            reject(rpcError(result.error));
                        } else {
                            resolve(result.result);
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        if (timeout > 0) {
            request.setTimeout(timeout, () => request.destroy(new ArfTransportTimeoutError()));
        }
        request.on('error', reject);
        request.end(body);
    });
}

export function discoverArf(): ArfSession[] {
    const root =
        process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Caches')
            : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'));
    const directory = path.join(root, 'arf', 'sessions');
    if (!fs.existsSync(directory)) {
        return [];
    }
    const sessions: ArfSession[] = [];
    for (const name of fs.readdirSync(directory)) {
        if (!/^\d+\.json$/.test(name)) {
            continue;
        }
        try {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
                continue;
            }
            const value = object(JSON.parse(fs.readFileSync(file, 'utf8')));
            if (typeof value.pid !== 'number' || typeof value.socket_path !== 'string') {
                continue;
            }
            process.kill(value.pid, 0);
            sessions.push(value as unknown as ArfSession);
        } catch {
            /* A stale discovery file is not a running session. */
        }
    }
    return sessions;
}

/** Reading frontend metadata does not evaluate R or request execution permission. */
export async function probeArfSession(session: ArfSession): Promise<ArfSession | undefined> {
    try {
        await arfRequest(session.socket_path, 'session', {}, 1000);
        return session;
    } catch {
        return undefined;
    }
}
