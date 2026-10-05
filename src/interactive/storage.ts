import * as fs from 'fs';
import * as path from 'path';

export function storageError(root: string, error: unknown): unknown {
    if (
        !['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
        )
    ) {
        return error;
    }
    return new Error(
        `Cannot access persistent session storage "${root}". Set r.interactive.storagePath to an absolute, writable directory on the R host and reload VS Code. ${String(error)}`,
        { cause: error },
    );
}

export function ensureStorageDirectory(directory: string, root: string): void {
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch (error) {
        throw storageError(root, error);
    }
}

/** Check storage before probing R or building the private runtime. Never redirect an existing registry. */
export function prepareStorage(root: string): void {
    ensureStorageDirectory(root, root);
    ensureStorageDirectory(path.join(root, 'runtimes'), root);
}
