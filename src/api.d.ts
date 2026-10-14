
// declaration of the api exported by the extension
// implemented in apiImplementation.ts
// used e.g. by vscode-r-debugger to show the help panel from within debug sessions

import * as vscode from 'vscode';

export declare class RExtension {
    helpPanel?: HelpPanel;
    session: RSessionApi;
    getRExecutablePath(resource?: vscode.Uri): Promise<string | undefined>;
}

export interface RSessionConnectionInfo {
    protocolVersion: number;
    endpoint: string;
    /** The configured, compatibility-resolved plot backend preference. */
    plotBackend: 'auto' | 'standard' | 'httpgd' | 'jgd' | 'native';
    /** Present when plotBackend is jgd or auto and the JGD socket is available. */
    jgdSocket?: string;
}

export interface RSessionActivationOptions {
    /**
     * Explicit execution terminal, including extension-owned pseudoterminals.
     * Each session and terminal has at most one association. This replaces any
     * previous association for either endpoint, including native PID routing.
     * Native attach cannot override a live explicit association. The binding
     * lasts until terminal close, session disconnect, or connection replacement;
     * call activate with the terminal again after reconnecting.
     * Superseded native PID associations require a fresh native attach to resume.
     */
    terminal?: vscode.Terminal;
    /**
     * Bind/activate only this specific live sess connection. A reference from a
     * replaced or disconnected connection is stale and returns false.
     */
    connectionId?: string;
    /** Update the active session and UI. Defaults to true; false changes only the terminal binding. */
    select?: boolean;
}

/** Consumer-owned terminal hook for restoring a sess connection without bypassing its proxy. */
export interface RExternalTerminalIntegration {
    /**
     * Reconnect through the consumer's transport and bind this terminal before resolving true.
     * A resolved false is a consumer-reported decline/busy result; a rejection is shown by
     * vscode-R. Cancellation can stop pending work, but cannot retract R code already submitted.
     */
    attach(token: vscode.CancellationToken): Promise<boolean>;
}

export interface RSessionPreparationOptions {
    /**
     * A local sess IPC endpoint on the current R host, such as a proxy socket.
     * When omitted, vscode-R's endpoint is used. Only sess IPC is supported.
     * On Windows, only a local `\\.\pipe\...` named pipe with a non-empty
     * name containing ASCII letters, digits, underscore, period, or hyphen is
     * accepted. On other platforms, an absolute local socket path is required.
     */
    connection?: {
        transport: 'sess';
        endpoint: string;
    };
    /** Whether this attachment may automatically select its session in the UI. Defaults to true. */
    autoActivate?: boolean;
}

/** Opaque R code and script resource for preparing sess in a consumer-owned R process. */
export interface RSessionPreparation extends vscode.Disposable {
    /** Opaque correlation ID carried by this attachment's sess handshake. */
    readonly attachmentId: string;
    /** Source this file in the target R process; its contents are private to vscode-R. */
    readonly scriptPath: string;
    /** R source(...) expression for scriptPath. This is R code, not a shell command. */
    readonly command: string;
}

export interface RSessionReference {
    readonly sessionId: string;
    /** Opaque identity for one accepted IPC connection; changes on reconnect. */
    readonly connectionId: string;
    /** Correlation ID supplied by a prepared external attachment, when present. */
    readonly attachmentId?: string;
}

export interface RSessionConnectionChange {
    readonly kind: 'connected' | 'disconnected';
    readonly session: RSessionReference;
}

export interface RSessionApi {
    /** Returns connection details, or undefined when the session watcher is disabled. */
    getConnectionInfo(): Promise<RSessionConnectionInfo | undefined>;
    /**
     * Prepare managed sess integration for a consumer-owned R process on the current host.
     * Source `command` in that process after its user profile. The command handles R errors
     * and interrupts itself, reports a diagnostic and returns `invisible(FALSE)`; preparation
     * failures reject this promise. Returns undefined, without starting resources, when the
     * session watcher is disabled. The returned script is valid only for this extension-host
     * lifetime. Keep the resource until source execution finishes, then dispose it. If the
     * consumer cannot observe completion, retain it for the R process lifetime. Disposing
     * removes only this script; it does not stop the R process or disconnect sess.
     *
     * Attaching follows vscode-R's current automatic-selection rules and may change the UI's
     * selected session. After connection, call `activate(sessionId, { terminal })` to register
     * the consumer's execution terminal; connection replacement clears that registration.
     * Set `autoActivate: false` to skip native-terminal PID discovery and association, register
     * the consumer-owned terminal only when you call `activate`, and avoid automatic selection.
     * Replacement of the currently selected logical session still follows its new connection.
     * The `attachmentId` correlates with `onDidChangeSessionConnection` and `getSessionReference`;
     * it is not an authentication or exclusive-ownership token, and reusing a script can share it.
     * During script execution, R may wait up to 180 seconds for install consent or 300 seconds
     * for another setup's lock. These are R-side waits, not a total startup timeout.
     */
    prepareAttachment(options?: RSessionPreparationOptions): Promise<RSessionPreparation | undefined>;
    /**
     * Sess connection history is delivered as immutable snapshots in FIFO order after each
     * transition is committed. During replacement, `disconnected(old)` is followed by
     * `connected(new)` even if a reentrant listener disconnects the new connection; query
     * `getSessionReference` for current state because it may already be undefined while a queued
     * historical event is delivered.
     */
    readonly onDidChangeSessionConnection: vscode.Event<RSessionConnectionChange>;
    /** Synchronously query the current live sess connection; requester transports return undefined. */
    getSessionReference(sessionId: string): RSessionReference | undefined;
    /**
     * Activates a connected session, optionally binding its execution terminal.
     * Omitting terminal preserves any existing binding. Returns false for unknown
     * or disconnected sessions, a stale `connectionId`, or a terminal that is closed or no
     * longer open. With `select: false`, only the terminal binding changes; selection revision,
     * active-session pointer and UI remain untouched. The result reflects whether the connection
     * is still current after activation completes; a later disconnect can still occur.
     */
    activate(sessionId: string, options?: RSessionActivationOptions): Promise<boolean>;
    /**
     * Register one attach hook for an open terminal. Duplicate or closed-terminal registrations
     * throw. The hook remains registered across session disconnects and replacements until its
     * Disposable is disposed, the terminal closes, or the extension host shuts down. It is
     * invoked before native PID discovery; false, rejection, busy, or cancellation never falls
     * back to a native attach command. On true, vscode-R requires a current live session binding
     * for this terminal, then focuses that session. Consumers should bind with
     * `activate(..., { terminal, connectionId, select: false })` before resolving true. When no
     * hook is in flight, a current live owner is focused and the hook is skipped. While a hook is
     * in flight, repeated activations report busy without selecting or focusing its bound owner,
     * and do not invoke another handler. The terminal remains busy until the handler promise
     * settles, even after cancellation is requested.
     * Registered terminals are excluded from native PID association, so consumers must bind
     * their session explicitly. Registration during host shutdown throws.
     * If the user selects another session while the hook is pending, vscode-R leaves that selection
     * in place and retains the terminal binding. Cancellation is requested when focus leaves the
     * terminal, it closes, registration is disposed, or the host shuts down. Consumers should
     * stop cancellable waits and settle the handler on cancellation. Submitted R code cannot be
     * recalled; the consumer must retain its preparation while the runtime keeps its submission
     * queue occupied until execution finishes.
     */
    registerTerminalIntegration(terminal: vscode.Terminal, integration: RExternalTerminalIntegration): vscode.Disposable;
}

export type HelpSubMenu = 'doc' | 'pkgList' | 'refresh' | '?' | '??';

export interface HelpPanel {
    showHelpForPath(requestPath?: string): void;
    dispose(): void;
    refresh(): void;
}
