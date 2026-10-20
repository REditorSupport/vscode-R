import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findExecutableOnPath } from '../rPathResolver';

/** Resolve an executable without a shell, using the prospective process's cwd. */
export function resolveExecutable(
    command: string,
    directory: string,
    pathValue = process.env.PATH,
): string | undefined {
    command = command.trim();
    if (!command) {
        return;
    }
    if (
        (command.startsWith('"') && command.endsWith('"')) ||
        (command.startsWith("'") && command.endsWith("'"))
    ) {
        command = command.slice(1, -1);
    }
    if (command.startsWith('~/')) {
        command = path.join(os.homedir(), command.slice(2));
    }
    const executable = (file: string): boolean => {
        try {
            if (!fs.statSync(file).isFile()) {
                return false;
            }
            fs.accessSync(file, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    };
    if (command.includes('/') || command.includes('\\')) {
        const file = path.resolve(directory, command);
        return executable(file) ? file : undefined;
    }
    // Resolve relative PATH entries against the session's cwd, as spawn does.
    const searchPath = pathValue
        ?.split(path.delimiter)
        .map((entry) => path.resolve(directory, entry))
        .join(path.delimiter);
    return findExecutableOnPath(command, process.platform, searchPath, executable);
}
