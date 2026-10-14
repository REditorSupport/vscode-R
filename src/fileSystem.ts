import { access, readFile } from 'node:fs/promises';
import type { PathLike } from 'node:fs';

export async function pathExists(path: PathLike): Promise<boolean> {
    // Match fs-extra: an inaccessible path is treated as absent.
    return access(path).then(() => true, () => false);
}

export async function readJson(path: PathLike): Promise<unknown> {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
}
