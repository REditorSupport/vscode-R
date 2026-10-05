import { resolveExecutable } from './executable';

/** Resolve on the extension host, without a shell or starting an arf process. */
export function resolveArfExecutable(
    command: string,
    directory: string,
    pathValue = process.env.PATH,
): string | undefined {
    return resolveExecutable(command.trim() || 'arf', directory, pathValue);
}
