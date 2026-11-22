import { execFile } from 'child_process';
import * as http from 'http';
import {
    ARF_REGISTRY_VARIABLES,
    ArfRegistryEnvironment,
    object,
    MAX_MESSAGE_BYTES,
} from './protocol';
import { resolveArfExecutable } from './arfExecutable';

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

/** Runs a file without a shell and resolves with its standard output. */
export type ArfCommandRunner = (
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<string>;

/** Rejects with `timedOut` once the deadline passes, whether or not the child has exited. */
const runFile: ArfCommandRunner = (file, args, { timeout, ...options }) =>
    new Promise((resolve, reject) => {
        let timedOut = false;
        const child = execFile(
            file,
            args,
            { ...options, windowsHide: true, encoding: 'utf8' },
            (error, stdout, stderr) => {
                clearTimeout(timer);
                if (timedOut) {
                    return;
                }
                if (error) {
                    reject(Object.assign(error, { stderr }));
                } else {
                    resolve(stdout);
                }
            },
        );
        // execFile's own timeout waits for the child to exit after its signal,
        // which a wrapper that handles SIGTERM can delay indefinitely.
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            // A subprocess of a wrapper can keep the pipes open after the
            // wrapper is killed.
            child.stdout?.destroy();
            child.stderr?.destroy();
            reject(Object.assign(new Error('arf ipc list timed out'), { timedOut: true }));
        }, timeout);
    });

/**
 * Sessions that `arf ipc list` reported, or why they could not be listed.
 * Listed sessions are only candidates until {@link probeArfSession} confirms them.
 */
export type ArfDiscovery =
    | { available: true; command: string; sessions: ArfSession[] }
    | { available: false; command?: string; reason: string };

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_BYTES = 1024 * 1024;

function listedSession(value: unknown): ArfSession | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const item = value as Record<string, unknown>;
    if (
        typeof item.pid !== 'number' ||
        !Number.isSafeInteger(item.pid) ||
        item.pid <= 0 ||
        typeof item.socket_path !== 'string' ||
        !item.socket_path
    ) {
        return undefined;
    }
    const session: ArfSession = { pid: item.pid, socket_path: item.socket_path };
    for (const key of ['cwd', 'r_version', 'started_at', 'session_type'] as const) {
        const field = item[key];
        if (field === undefined || field === null) {
            continue;
        }
        if (typeof field !== 'string') {
            return undefined;
        }
        session[key] = field;
    }
    return session;
}

/**
 * How `arf ipc list` listed a session: the CLI it resolved to, the directory
 * it ran in, and the variables that selected the registry it read. Listing
 * again with the same values reads the same registry.
 */
export interface ArfListing {
    command: string;
    directory: string;
    registry: ArfRegistryEnvironment;
}

/** The variables of `env` that select the arf session registry. */
export function registryEnvironmentOf(env: NodeJS.ProcessEnv): ArfRegistryEnvironment {
    const registry: ArfRegistryEnvironment = {};
    for (const name of ARF_REGISTRY_VARIABLES) {
        const value = env[name];
        if (value) {
            registry[name] = value;
        }
    }
    return registry;
}

/**
 * `env` with the registry variables of `registry`, a variable absent there
 * removed, so that a listing reads the recorded registry rather than one that
 * `env` happens to select.
 */
export function withRegistryEnvironment(
    env: NodeJS.ProcessEnv,
    registry: ArfRegistryEnvironment,
): NodeJS.ProcessEnv {
    const names = new Set<string>(ARF_REGISTRY_VARIABLES);
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        // Windows environment variable names are case-insensitive.
        if (!names.has(key.toUpperCase())) {
            result[key] = value;
        }
    }
    return { ...result, ...registry };
}

/**
 * Lists running arf sessions with the arf CLI, which knows where its version
 * stores them on each platform. The CLI runs with the extension host's
 * environment, so a custom `ARF_IPC_SESSIONS_DIR` must be set for both.
 */
export async function discoverArf(
    command: string,
    directory: string,
    env: NodeJS.ProcessEnv = process.env,
    run: ArfCommandRunner = runFile,
    timeout = DISCOVERY_TIMEOUT_MS,
): Promise<ArfDiscovery> {
    const file = resolveArfExecutable(command, directory, env.PATH);
    if (!file) {
        return { available: false, reason: `arf was not found (checked: ${command})` };
    }
    let stdout: string;
    try {
        stdout = await run(file, ['ipc', 'list'], {
            cwd: directory,
            env,
            timeout,
            maxBuffer: DISCOVERY_MAX_BYTES,
        });
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { timedOut?: boolean; stderr?: string };
        const reason = failure.timedOut
            ? `it did not finish within ${Math.round(timeout / 100) / 10} seconds`
            : failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'its output exceeded 1 MiB'
              : `it failed: ${(failure.stderr?.trim() || failure.message).slice(0, 500)}`;
        return { available: false, command: file, reason: `arf ipc list ${reason}` };
    }
    let sessions: unknown;
    try {
        sessions = object(JSON.parse(stdout)).sessions;
    } catch {
        sessions = undefined;
    }
    if (!Array.isArray(sessions)) {
        return {
            available: false,
            command: file,
            reason: 'arf ipc list returned malformed output',
        };
    }
    return {
        available: true,
        command: file,
        // A malformed entry is skipped without hiding the others.
        sessions: sessions.map(listedSession).filter((session) => session !== undefined),
    };
}

/** An arf session whose endpoint answered for the PID that listed it. */
export interface ProbedArfSession extends ArfSession {
    session_id: string;
}

/**
 * Reading frontend metadata does not evaluate R or request execution
 * permission. The deadline covers the whole request. An endpoint that
 * answers for another process, or for one that started at another time, is
 * not the listed session.
 */
export async function probeArfSession(
    session: ArfSession,
    timeout = 1000,
): Promise<ProbedArfSession | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const result = (await arfRequest(
            session.socket_path,
            'session',
            {},
            timeout,
            controller.signal,
        )) as Record<string, unknown> | null;
        if (
            result?.pid !== session.pid ||
            typeof result.session_id !== 'string' ||
            !result.session_id ||
            // A restarted arf, such as after `:switch`, keeps its PID and socket
            // path; the listed details then describe the previous R.
            (session.started_at !== undefined && result.started_at !== session.started_at)
        ) {
            return undefined;
        }
        return { ...session, session_id: result.session_id };
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}
