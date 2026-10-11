
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
}

/** Opaque R code and script resource for preparing sess in a consumer-owned R process. */
export interface RSessionPreparation extends vscode.Disposable {
    /** Source this file in the target R process; its contents are private to vscode-R. */
    readonly scriptPath: string;
    /** R source(...) expression for scriptPath. This is R code, not a shell command. */
    readonly command: string;
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
     * During script execution, R may wait up to 180 seconds for install consent or 300 seconds
     * for another setup's lock. These are R-side waits, not a total startup timeout.
     */
    prepareAttachment(options?: RSessionPreparationOptions): Promise<RSessionPreparation | undefined>;
    /**
     * Activates a connected session, optionally binding its execution terminal.
     * Omitting terminal preserves any existing binding. Returns false for unknown
     * or disconnected sessions, or a terminal that is closed or no longer open.
     */
    activate(sessionId: string, options?: RSessionActivationOptions): Promise<boolean>;
}

export type HelpSubMenu = 'doc' | 'pkgList' | 'refresh' | '?' | '??';

export interface HelpPanel {
    showHelpForPath(requestPath?: string): void;
    dispose(): void;
    refresh(): void;
}
