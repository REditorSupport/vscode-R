import { resolveExecutable } from './executable';

/** Runtime for the independent session agent, including Electron's Node mode. */
export interface NodeRuntime {
    executable: string;
    electron: boolean;
}

export function hostNodeRuntime(): NodeRuntime {
    return { executable: process.execPath, electron: !!process.versions.electron };
}

/** Empty uses the extension host; explicit overrides must resolve on the R host. */
export function resolveNodeRuntime(command: string, directory: string): NodeRuntime {
    if (!command.trim()) { return hostNodeRuntime(); }
    const executable = resolveExecutable(command, directory);
    if (!executable) {
        throw new Error(`Cannot find an executable Node.js runtime “${command}”. Set r.interactive.nodePath to a Node.js 18+ executable on the R host (the remote server when using Remote SSH), or clear it to use VS Code's runtime.`);
    }
    return { executable, electron: false };
}
