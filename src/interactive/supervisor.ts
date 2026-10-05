import { resolveExecutable } from './executable';

export type SessionSupervisor =
    | { kind: 'detached'; notice?: string }
    | { kind: 'tmux' | 'systemd'; executable: string };

/** Resolve before installing a runtime or stopping R for restart. Never start a supervisor here. */
export function prepareSupervisor(
    requested: string,
    directory: string,
    platform = process.platform,
    pathValue = process.env.PATH,
): SessionSupervisor {
    if (platform === 'win32') {
        throw new Error(
            'Persistent Interactive native console support currently requires Linux or macOS',
        );
    }
    if (requested === 'detached' || (requested === 'auto' && platform !== 'linux')) {
        return { kind: 'detached' };
    }
    if (!['auto', 'tmux', 'systemd'].includes(requested)) {
        throw new Error(
            `Unknown session supervisor “${requested}”. Set r.interactive.supervision to auto, tmux, systemd, or detached.`,
        );
    }
    const kind = requested === 'systemd' ? 'systemd' : 'tmux';
    const command = kind === 'systemd' ? 'systemd-run' : 'tmux';
    const executable = resolveExecutable(command, directory, pathValue);
    if (executable) {
        return { kind, executable };
    }
    if (requested === 'auto') {
        return {
            kind: 'detached',
            notice:
                'tmux is unavailable on this host; using an independent process. ' +
                'The session survives VS Code reload/exit. Host logout policies may still stop it.',
        };
    }
    throw new Error(
        `Cannot find an executable ${command} on this host. Install ${command} on the R host ` +
            '(the remote server when using Remote SSH), or set r.interactive.supervision to "auto" or "detached".',
    );
}
