import { SessionManifest } from './protocol';

/** Public session details; never include connection credentials. */
export function sessionPresentation(manifest: SessionManifest, connected: boolean | undefined, control: boolean, restarting = false,
    directory = manifest.directory): { state: string; label: string; description: string; detail: string; tooltip: string } {
    const state = restarting ? 'restarting' : manifest.status === 'exited' ? 'stopped' : connected === false ? 'disconnected'
        : manifest.status === 'input' ? 'waiting for input' : manifest.status;
    const provider = manifest.provider === 'r' ? 'plain' : manifest.provider === 'arf-existing' ? 'arf (attached)' : 'arf';
    const version = manifest.rVersion?.match(/^R version (\S+)/)?.[1];
    const supervision = manifest.supervision === 'detached' ? 'Independent process' : manifest.supervision;
    return {
        state,
        label: `R: ${manifest.label} · ${state}`,
        // Description is inline (and doubles as the native button tooltip); detail
        // gets a second picker row. Neither supports arbitrary multiline content.
        description: `${version ? `R ${version}` : 'R'} · ${provider} · PID ${manifest.rPid ?? 'pending'}${connected && !control ? ' · observing' : ''}`,
        detail: `${directory} · ${manifest.host} · ${supervision}`,
        // The full details remain available in the status bar hover and Session Details.
        tooltip: [
            manifest.label,
            `State: ${state}`,
            `Connection: ${connected === undefined ? 'Not open in this VS Code window' : connected
                ? `Connected · ${control ? 'controlling' : 'observing'}` : 'Disconnected'}`,
            `Provider: ${manifest.provider === 'r' ? 'Plain R' : manifest.provider === 'arf-existing' ? 'Attached arf' : 'Headless arf'}`,
            manifest.rVersion ?? 'R version: pending',
            `PID: ${manifest.rPid ?? 'pending'}`,
            `Working directory: ${directory}`,
            `Host: ${manifest.host}`,
            `Process supervision: ${supervision}${manifest.supervision === 'detached' ? ' (survives VS Code reload/exit)' : ''}`,
            ...(manifest.rPath ? [`R executable: ${manifest.rPath}`] : []),
            `Session: ${manifest.id.slice(0, 8)}`,
        ].join('\n'),
    };
}
