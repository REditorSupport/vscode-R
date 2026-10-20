import { SessionManifest } from './protocol';

/** Time in the current process generation; never keep aging a stopped session. */
export function sessionAge(manifest: SessionManifest, now = Date.now()): string | undefined {
    const end = manifest.status === 'exited' ? manifest.ended : now;
    if (!Number.isFinite(manifest.created) || end === undefined || !Number.isFinite(end)) {
        return undefined;
    }
    const minutes = Math.floor(Math.max(0, end - manifest.created) / 60000);
    return minutes < 1
        ? '<1m'
        : minutes < 60
          ? `${minutes}m`
          : minutes < 1440
            ? `${Math.floor(minutes / 60)}h`
            : `${Math.floor(minutes / 1440)}d`;
}

/** Public session details; never include connection credentials. */
export function sessionPresentation(
    manifest: SessionManifest,
    connected: boolean | undefined,
    control: boolean,
    restarting = false,
    directory = manifest.directory,
): { state: string; label: string; description: string; detail: string; tooltip: string } {
    const state = restarting
        ? 'restarting'
        : manifest.status === 'exited'
          ? 'stopped'
          : connected === false
            ? 'disconnected'
            : manifest.status === 'input'
              ? 'waiting for input'
              : manifest.status;
    const provider =
        manifest.provider === 'r'
            ? 'plain'
            : manifest.provider === 'arf-existing'
              ? 'arf (attached)'
              : 'arf';
    const version = manifest.rVersion?.match(/^R version (\S+)/)?.[1];
    const supervision =
        manifest.supervision === 'detached' ? 'Independent process' : manifest.supervision;
    const age = sessionAge(manifest);
    return {
        state,
        label: `R: ${manifest.label} · ${state}`,
        // Description is inline (and doubles as the native button tooltip); detail
        // gets a second picker row. Neither supports arbitrary multiline content.
        description: `${version ? `R ${version}` : 'R'} · ${provider} · PID ${manifest.rPid ?? 'pending'}${age ? ` · ${age}` : ''}${connected && !control ? ' · observing' : ''}`,
        detail: `${directory} · ${manifest.host} · ${supervision}`,
        // The full details remain available in the status bar hover and Session Details.
        tooltip: [
            manifest.label,
            `State: ${state}`,
            `Connection: ${
                connected === undefined
                    ? 'Not open in this VS Code window'
                    : connected
                      ? `Connected · ${control ? 'controlling' : 'observing'}`
                      : 'Disconnected'
            }`,
            `Provider: ${manifest.provider === 'r' ? 'Plain R' : manifest.provider === 'arf-existing' ? 'Attached arf' : 'Headless arf'}`,
            manifest.rVersion ?? 'R version: pending',
            `PID: ${manifest.rPid ?? 'pending'}`,
            ...(age
                ? [`${manifest.status === 'exited' ? 'Lifetime' : 'Session age'}: ${age}`]
                : []),
            ...(Number.isFinite(manifest.created)
                ? [`Started: ${new Date(manifest.created).toLocaleString()}`]
                : []),
            `Working directory: ${directory}`,
            `Host: ${manifest.host}`,
            `Process supervision: ${supervision}${manifest.supervision === 'detached' ? ' (survives VS Code reload/exit)' : ''}`,
            ...(manifest.rPath ? [`R executable: ${manifest.rPath}`] : []),
            `Session: ${manifest.id.slice(0, 8)}`,
        ].join('\n'),
    };
}
