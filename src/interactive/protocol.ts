/** Wire types shared by the extension and the independently running session agent. */
export const AGENT_PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_CODE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_ASSET_BYTES = 1024 * 1024 * 1024;

export type ProviderKind = 'r' | 'arf' | 'arf-existing';
export type ExecutionState =
    | 'queued'
    | 'running'
    | 'success'
    | 'error'
    | 'interrupted'
    | 'cancelled'
    | 'unknown';

export interface SessionIdentity {
    id: string;
    generation: string;
}

export interface SessionManifest extends SessionIdentity {
    protocol: number;
    label: string;
    host: string;
    directory: string;
    endpoint: string;
    token: string;
    agentPid: number;
    backend?: string;
    ownership?: 'managed' | 'adopted';
    rPid?: number;
    rVersion?: string;
    provider: ProviderKind;
    created: number;
    ended?: number;
    status: 'starting' | 'idle' | 'busy' | 'input' | 'stopping' | 'exited' | 'unknown';
    capabilities: Record<string, boolean>;
    supervision: string;
    assetBase?: string;
    runtimeSessionId?: string;
    rPath?: string;
    libraryPaths?: string[];
}

export interface SourceLocation {
    uri: string;
    line: number;
    version?: number;
}

export interface Submission {
    id: string;
    code: string;
    source?: SourceLocation;
}

export interface ExecutionRecord extends Submission {
    hash: string;
    state: ExecutionState;
    order: number;
    accepted: number;
    started?: number;
    ended?: number;
}

export interface SessionEvent {
    seq: number;
    generation: string;
    executionId?: string;
    type: string;
    time: number;
    data: Record<string, unknown>;
}

export interface AgentSnapshot {
    manifest: SessionManifest;
    seq: number;
    executions: ExecutionRecord[];
    events: SessionEvent[];
    workspace?: Record<string, unknown>;
    input?: Record<string, unknown>;
    truncated?: string[];
}

export interface AgentSettings extends SessionIdentity {
    /** Completed processes whose transcripts precede this generation in the same window. */
    previousGenerations?: string[];
    label: string;
    directory: string;
    storage: string;
    provider: ProviderKind;
    supervision: string;
    historyLimit: number;
    maxOutputBytes: number;
    maxJournalBytes: number;
    maxAssetBytes?: number;
}

/** Persisted backend descriptor. Its definition validates and owns its options. */
export interface BackendDescriptor {
    kind: string;
    options: Record<string, unknown>;
}

export interface AgentConfig extends AgentSettings {
    backend?: BackendDescriptor;
    /** Legacy sess projection, derived from backend.options when writing new configs. */
    rPath?: string;
    library?: string;
    resources?: string;
    arfPath?: string;
    arfEndpoint?: string;
    plotBackend?: 'auto' | 'jgd' | 'standard';
}

export interface Request {
    id: number;
    method: string;
    params: Record<string, unknown>;
}

export function sessionLabel(value: unknown): string {
    const label = typeof value === 'string' ? value.trim() : '';
    if (
        !label ||
        label.length > 80 ||
        label.split('').some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
        throw new Error('Use a session name of 1–80 characters without control characters');
    }
    return label;
}

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected an object');
    }
    return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
        throw new Error('Invalid identifier');
    }
    return value;
}

export function submission(value: unknown): Submission {
    const data = object(value);
    const id = identifier(data.id);
    if (
        typeof data.code !== 'string' ||
        !data.code.trim() ||
        Buffer.byteLength(data.code) > MAX_CODE_BYTES
    ) {
        throw new Error('Code must be nonempty and no larger than 1 MiB');
    }
    let source: SourceLocation | undefined;
    if (data.source) {
        const location = object(data.source);
        if (
            typeof location.uri !== 'string' ||
            typeof location.line !== 'number' ||
            location.line < 0
        ) {
            throw new Error('Invalid source location');
        }
        source = {
            uri: location.uri,
            line: location.line,
            version: typeof location.version === 'number' ? location.version : undefined,
        };
    }
    return { id, code: data.code, source };
}
