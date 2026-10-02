import * as path from 'path';
import { resolveExecutable } from './executable';

interface NodeHost {
    execPath: string;
    electron?: string;
    path?: string;
}

/** A Remote SSH extension host already runs under VS Code Server's standalone Node. */
export function resolveNodeExecutable(command: string, directory: string,
    host: NodeHost = { execPath: process.execPath, electron: process.versions.electron, path: process.env.PATH }): string | undefined {
    command = command.trim() || 'node';
    const configured = resolveExecutable(command, directory, host.path ?? '');
    if (configured) { return configured; }
    // Explicit paths/names must not silently select another runtime. Never launch
    // the local desktop Electron helper as an independent Node agent.
    if (command === 'node' && !host.electron && /^node(?:js)?(?:\.exe)?$/i.test(path.basename(host.execPath))) {
        return resolveExecutable(host.execPath, directory, '');
    }
}
