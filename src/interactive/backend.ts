import type { AgentSettings, Submission } from './protocol';

export type BackendOwnership = 'managed' | 'adopted';
export type BackendCapabilities = Record<string, boolean>;
export interface RuntimeMetadata {
    rPid?: number;
    rVersion?: string;
    runtimeSessionId?: string;
    rPath?: string;
    libraryPaths?: string[];
}
export type InspectionMethod = 'workspace' | 'workspace_children' | 'hover' | 'completion' |
    'dataview_init' | 'dataview_page' | 'dataview_dispose';
export interface InspectionRequest { method: InspectionMethod; params: Record<string, unknown>; timeout?: number }
export interface InputReply { value: string }
export interface ClientReply { result?: unknown; error?: string }
export interface ResizePlotRequest { device: string; plot: number; width: number; height: number }

/** Decoded application events; no provider sockets, wire packets or RPC identifiers. */
export type BackendEvent = (
    { type: 'ready'; metadata: RuntimeMetadata; capabilities: BackendCapabilities } |
    { type: 'metadata'; metadata: RuntimeMetadata } |
    { type: 'started' } |
    { type: 'finished'; state: 'success' | 'error' | 'interrupted' } |
    { type: 'stream'; text: string; channel: string; external?: boolean } |
    { type: 'condition' | 'input' | 'display'; data: Record<string, unknown> } |
    { type: 'workspaceChanged' } |
    { type: 'notification' | 'viewer'; method: string; params: Record<string, unknown> } |
    { type: 'clientRequest'; id: string; method: string; params: unknown } |
    { type: 'clientRequestExpired'; id: string } |
    { type: 'external'; code: string; success: boolean } |
    { type: 'warning' | 'error' | 'truncated'; message: string } |
    { type: 'provider'; data: Record<string, unknown> } |
    { type: 'unavailable'; message: string } |
    { type: 'exit'; code?: number | null; signal?: string | null }
) & { executionId?: string };

export interface SessionBackend {
    readonly ownership: BackendOwnership;
    readonly capabilities: BackendCapabilities;
    onEvent(listener: (event: BackendEvent) => void): () => void;
    start(): Promise<void>;
    /** Acknowledges transport only. Started/finished events establish evaluation outcome. */
    dispatch(submission: Submission): Promise<void>;
    inspect(request: InspectionRequest): Promise<unknown>;
    replyInput(reply: InputReply): Promise<void>;
    replyClientRequest(id: string, reply: ClientReply): Promise<void>;
    interrupt(): Promise<void>;
    /** Explicit user Stop, including for an adopted runtime. Resolves after confirmed exit. */
    stop(options?: { force?: boolean }): Promise<void>;
    resizePlot?(request: ResizePlotRequest): Promise<void>;
    /** Bounded, idempotent cleanup. Must not kill an adopted runtime. */
    dispose(): Promise<void>;
}

export type BackendFactory = (settings: AgentSettings) => SessionBackend;

export function inspectionMethod(value: unknown): InspectionMethod {
    if (!['workspace', 'workspace_children', 'hover', 'completion', 'dataview_init', 'dataview_page', 'dataview_dispose'].includes(String(value))) {
        throw new Error('Unsupported inspection method');
    }
    return value as InspectionMethod;
}
