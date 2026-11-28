import * as vscode from 'vscode';
import type { WebR } from 'webr';

// An imported helper and its data retain their relative paths in the session.
export const sessionDirectory = '/workspace';

function segments(path: string): string[] {
    const parts = path.split('/');
    if (
        !path ||
        parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))
    ) {
        throw new Error('Use a relative path within the webR session directory.');
    }
    return parts;
}

export async function importFiles(runtime: WebR, files: readonly vscode.Uri[]): Promise<void> {
    for (const file of files) {
        const folder = vscode.workspace.getWorkspaceFolder(file);
        const relative = folder
            ? vscode.workspace.asRelativePath(file)
            : file.path.slice(file.path.lastIndexOf('/') + 1);
        const parts = segments(relative);
        let directory = sessionDirectory;
        for (const part of parts.slice(0, -1)) {
            directory += '/' + part;
            if (!(await runtime.FS.analyzePath(directory)).exists) {
                await runtime.FS.mkdir(directory);
            }
        }
        const data = await vscode.workspace.fs.readFile(file);
        await runtime.FS.writeFile(sessionDirectory + '/' + parts.join('/'), data);
    }
}

export async function exportFile(
    runtime: WebR,
    source: string,
    destination: vscode.Uri,
): Promise<void> {
    if (vscode.workspace.fs.isWritableFileSystem(destination.scheme) === false) {
        throw new Error('Select a destination that permits writing files.');
    }
    const data = await runtime.FS.readFile(sessionDirectory + '/' + segments(source).join('/'));
    await vscode.workspace.fs.writeFile(destination, data);
}
