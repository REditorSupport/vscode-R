import { SessionManifest } from './protocol';

/** Public session details for the native kernel button; never include connection credentials. */
export function sessionPresentation(manifest: SessionManifest, connected: boolean, control: boolean, restarting = false,
    directory = manifest.directory): { label: string; description: string } {
    const state = restarting ? 'restarting' : !connected ? 'disconnected' : manifest.status === 'exited' ? 'stopped'
        : manifest.status === 'input' ? 'waiting for input' : manifest.status;
    const provider = manifest.provider === 'r' ? 'plain' : manifest.provider === 'arf-existing' ? 'arf (attached)' : 'arf';
    return {
        label: `R: ${manifest.label} · ${provider} · ${state}${connected && !control ? ' · observing' : ''}`,
        // VS Code uses description before detail as the kernel button's tooltip.
        description: [
            manifest.label,
            `State: ${state}${connected ? control ? ' · controlling' : ' · observing' : ''}`,
            `Provider: ${manifest.provider === 'r' ? 'Plain R' : manifest.provider === 'arf-existing' ? 'Attached arf' : 'Headless arf'}`,
            manifest.rVersion ?? 'R version: starting',
            `PID: ${manifest.rPid ?? 'starting'}`,
            `Working directory: ${directory}`,
            `Host: ${manifest.host} · ${manifest.supervision}`,
            ...(manifest.rPath ? [`R executable: ${manifest.rPath}`] : []),
            `Session: ${manifest.id.slice(0, 8)}`,
        ].join('\n'),
    };
}
