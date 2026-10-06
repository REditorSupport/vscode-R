
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
     * Replaces any previous binding for this session or terminal. The binding
     * lasts until terminal close, session disconnect, or connection replacement;
     * call activate with the terminal again after reconnecting.
     * Superseded native PID associations require a fresh native attach to resume.
     */
    terminal?: vscode.Terminal;
}

export interface RSessionApi {
    /** Returns connection details, or undefined when the session watcher is disabled. */
    getConnectionInfo(): Promise<RSessionConnectionInfo | undefined>;
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
