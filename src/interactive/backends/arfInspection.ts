import * as path from 'path';
import {
    ARF_HANDLER_EXECUTION_TIMEOUT,
    ARF_HANDLER_INTERRUPTED,
    ARF_HANDLER_NOT_FOUND,
    ARF_HANDLER_QUEUE_FULL,
    ARF_HANDLER_QUEUE_TIMEOUT,
    ARF_HANDLER_R_ERROR,
    ArfRpcError,
    ArfTransportTimeoutError,
} from '../arf';
import { INSPECTION_METHODS, InspectionMethod, InspectionRequest } from '../backend';
import { object } from '../protocol';
import { rString } from './rCode';

/**
 * Namespace of the handlers that sess publishes to arf. The `.json` marks the
 * contract: a handler takes the request parameters as one JSON string and
 * returns one JSON string. A strict-JSON variant would use another namespace.
 */
export const INSPECTION_NAMESPACE = 'vscode-r.inspect.json';

export function inspectionSelector(method: InspectionMethod): string {
    return `${INSPECTION_NAMESPACE}/${method}`;
}

export const INSPECTION_SELECTORS: readonly string[] = INSPECTION_METHODS.map(inspectionSelector);

/**
 * The R expression for arf's `--ipc-expose`. It reads the handler table from
 * the installed private sess without loading sess, which arf could not load
 * from the private library yet, and without picking up a sess of the user's.
 */
export function exposeInspectionExpression(library: string): string {
    const file = path.join(library, 'sess', 'arf', 'expose-inspection.R');
    return (
        `base::source(${rString(file)}, local=base::new.env(parent=base::baseenv()))$value(` +
        `${rString(library)})`
    );
}

/** The handler table that arf reports for a session. */
export interface ArfHandlerApi {
    state: string;
    handlers: string[];
}

export function parseHandlerApi(session: Record<string, unknown>): ArfHandlerApi | undefined {
    const api = session.handler_api;
    if (!api || typeof api !== 'object' || Array.isArray(api)) {
        return undefined;
    }
    const { state, handlers } = api as Record<string, unknown>;
    return typeof state === 'string' && Array.isArray(handlers)
        ? { state, handlers: handlers.filter((name): name is string => typeof name === 'string') }
        : undefined;
}

/**
 * Whether inspection can use handler calls and their execution deadlines: the
 * session's handler list is locked and has every selector. A session started
 * by Interactive must publish them; an adopted one without them keeps
 * inspection on the sess socket, where it cannot be interrupted.
 */
export function inspectionCallsAvailable(api: ArfHandlerApi | undefined): boolean {
    return (
        api?.state === 'locked' &&
        INSPECTION_SELECTORS.every((selector) => api.handlers.includes(selector))
    );
}

export type InspectionFailure =
    /** R did not start the request in time, so it did not run. */
    | 'queue_timeout'
    /** The request started and was interrupted when its execution deadline passed. */
    | 'deadline'
    /** The client stopped waiting; the request may still be running. */
    | 'transport_timeout'
    /** The handler raised an R error. */
    | 'r_error'
    /** The handler was interrupted without a deadline. */
    | 'interrupted'
    /** The handler is not published, or has been revoked. */
    | 'unpublished'
    /** arf refused the call for another reason, such as a full queue. */
    | 'rejected'
    /** More requests are waiting than the client allows. */
    | 'overloaded'
    | 'closed';

export class InspectionError extends Error {
    constructor(
        readonly kind: InspectionFailure,
        message: string,
        /** The R condition classes of an R error. */
        readonly rClass: string[] = [],
    ) {
        super(message);
        this.name = 'InspectionError';
    }
}

/** Limits of one call, in milliseconds. */
export interface CallLimits {
    queue: number;
    execution: number;
    /** How long to wait for arf's reply, which follows the handler's stop. */
    transport: number;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

/** Names the failure of a call, keeping the cause apart from the others. */
export function inspectionFailure(error: unknown, method: string, limits: CallLimits): unknown {
    if (error instanceof ArfTransportTimeoutError) {
        return new InspectionError(
            'transport_timeout',
            `R inspection '${method}' received no reply within ${limits.transport} ms; it may still be running in R`,
        );
    }
    if (!(error instanceof ArfRpcError)) {
        return error;
    }
    const data =
        error.data && typeof error.data === 'object' && !Array.isArray(error.data)
            ? (error.data as Record<string, unknown>)
            : {};
    switch (error.code) {
        case ARF_HANDLER_EXECUTION_TIMEOUT:
            return new InspectionError(
                'deadline',
                `R inspection '${method}' exceeded its execution deadline of ${limits.execution} ms and was interrupted`,
                strings(data.class),
            );
        case ARF_HANDLER_QUEUE_TIMEOUT:
            return new InspectionError(
                'queue_timeout',
                `R inspection '${method}' did not start within ${limits.queue} ms; R was busy`,
            );
        case ARF_HANDLER_R_ERROR:
            return new InspectionError(
                'r_error',
                `R inspection '${method}' failed: ${typeof data.message === 'string' ? data.message : error.rpcMessage}`,
                strings(data.class),
            );
        case ARF_HANDLER_INTERRUPTED:
            return new InspectionError(
                'interrupted',
                `R inspection '${method}' was interrupted`,
                strings(data.class),
            );
        case ARF_HANDLER_NOT_FOUND:
            return new InspectionError(
                'unpublished',
                `R inspection '${method}' is not published by this arf session, or its handlers were revoked`,
            );
        case ARF_HANDLER_QUEUE_FULL:
        default:
            return new InspectionError(
                'rejected',
                `arf rejected R inspection '${method}': ${error.rpcMessage || error.message}`,
            );
    }
}

/**
 * Decodes a handler call's result: its `value` is a JSON string holding an
 * object with a version and, unless R returned NULL, a `result`. A missing
 * result decodes to `undefined`, as an omitted result does on the sess socket.
 */
export function decodeInspectionResult(reply: unknown): unknown {
    const value = object(reply).value;
    if (typeof value !== 'string') {
        throw new Error('arf returned an inspection result that is not a JSON string');
    }
    let message: Record<string, unknown>;
    try {
        message = object(JSON.parse(value));
    } catch {
        throw new Error('arf returned an inspection result that is not valid JSON');
    }
    if (message.version !== 1) {
        throw new Error('sess returned an inspection result of an unsupported version');
    }
    return message.result;
}

/** The most requests that wait for R at once. */
const MAX_PENDING = 32;
/** The longest arf accepts for either of its call timeouts. */
const MAX_CALL_TIMEOUT = 300000;
/** Added to the transport wait so that arf's reply can arrive after a deadline. */
const TRANSPORT_MARGIN = 5000;
/** Requests that only read, so identical ones in flight can share an answer. */
const COALESCED: ReadonlySet<InspectionMethod> = new Set([
    'workspace',
    'workspace_children',
    'hover',
    'completion',
    'dataview_page',
]);

interface Job {
    request: InspectionRequest;
    key?: string;
    limits: CallLimits;
    promise: Promise<unknown>;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer?: NodeJS.Timeout;
}

export type CallTransport = (
    selector: string,
    args: string,
    limits: CallLimits,
) => Promise<unknown>;

/**
 * Sends inspection requests to arf one at a time.
 *
 * arf serializes calls anyway, so waiting here costs no time while keeping
 * its queue (64 calls, shared by all clients) from filling up. Requests that
 * wait are bounded: identical read-only ones share one call, a request that
 * has waited as long as its own timeout fails as a queue timeout, and there is
 * a hard limit on how many wait. Requests that differ are never dropped for
 * one another, since they can come from different clients.
 *
 * Each request's timeout is its execution deadline. A request stopped by its
 * deadline is an error, as is an interrupt or a failure to reach arf. An R
 * error in hover or completion means that nothing was found and is `null`.
 *
 * After a transport timeout the next request is sent although the previous
 * handler may still be running, for example in native code that ignores the
 * interrupt. It cannot run alongside: arf runs calls one at a time, so it
 * waits in arf's queue and is dropped unrun when its queue timeout passes. The
 * connection is not closed to cancel it, because it also carries the events
 * that track submitted code. A late reply is ignored by its request ID.
 */
export class InspectionCalls {
    private waiting: Job[] = [];
    private running?: Job;
    private closed?: Error;

    constructor(private readonly transport: CallTransport) {}

    request(request: InspectionRequest): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(this.closed);
        }
        const timeout = Math.min(
            MAX_CALL_TIMEOUT,
            Math.max(1, Math.trunc(Number(request.timeout ?? 5000)) || 1),
        );
        const key = COALESCED.has(request.method)
            ? `${request.method}\0${timeout}\0${JSON.stringify(request.params)}`
            : undefined;
        if (key) {
            for (const job of [this.running, ...this.waiting]) {
                if (job?.key === key) {
                    return job.promise;
                }
            }
        }
        if (this.waiting.length >= MAX_PENDING) {
            return Promise.reject(
                new InspectionError('overloaded', 'Too many R inspection requests are waiting'),
            );
        }
        const limits = {
            queue: timeout,
            execution: timeout,
            transport: 2 * timeout + TRANSPORT_MARGIN,
        };
        const job = { request, key, limits } as Job;
        job.promise = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        job.timer = setTimeout(() => {
            this.drop(job);
            job.reject(
                new InspectionError(
                    'queue_timeout',
                    `R inspection '${request.method}' waited ${timeout} ms for earlier requests`,
                ),
            );
        }, timeout);
        this.waiting.push(job);
        this.pump();
        return job.promise;
    }

    /** Fails the waiting requests; one that already runs ends with its call. */
    close(reason: Error = new Error('R inspection was closed')): void {
        this.closed ??= reason;
        for (const job of this.waiting.splice(0)) {
            clearTimeout(job.timer);
            job.reject(reason);
        }
    }

    private drop(job: Job): void {
        clearTimeout(job.timer);
        const index = this.waiting.indexOf(job);
        if (index >= 0) {
            this.waiting.splice(index, 1);
        }
    }

    private pump(): void {
        if (this.running || this.closed) {
            return;
        }
        const job = this.waiting.shift();
        if (!job) {
            return;
        }
        clearTimeout(job.timer);
        this.running = job;
        const { method, params } = job.request;
        void Promise.resolve()
            .then(() =>
                this.transport(inspectionSelector(method), JSON.stringify(params), job.limits),
            )
            .then(decodeInspectionResult, (error: unknown) => {
                const failure = inspectionFailure(error, method, job.limits);
                if (
                    failure instanceof InspectionError &&
                    failure.kind === 'r_error' &&
                    (method === 'hover' || method === 'completion')
                ) {
                    return null;
                }
                throw failure;
            })
            .then(
                (value) => job.resolve(value),
                (error: unknown) => job.reject(error),
            )
            .finally(() => {
                this.running = undefined;
                this.pump();
            });
    }
}
