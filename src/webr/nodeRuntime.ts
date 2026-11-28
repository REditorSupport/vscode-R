import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar';
import { WEBR_VERSION } from './runtime';

const integrity =
    'dOyIK2ul4zbtrbylcfSdgS8uC7vygr6f4uUbCVJaqpKaPlSNo2cr+cjjI1RgzrS5GSiwAmrmVSI++M8fTnQupg==';
const cacheName = 'webr-' + WEBR_VERSION + '-node1';
const downloads = new Map<string, Promise<string>>();
const assets = ['webr-worker.js', 'R.js', 'R.wasm', 'libRblas.so', 'libRlapack.so'];
class InvalidAsset extends Error {}

/** Publish a complete runtime atomically so detached agents can reopen it after IDE updates.
 * Offline tests can populate staging from the pinned npm distribution already on disk.
 */
export function prepareNodeWebR(root: string, unpack = download): Promise<string> {
    const directory = path.join(root, 'runtimes', cacheName);
    const pending = downloads.get(directory);
    if (pending) {
        return pending;
    }
    const install = prepare(directory, unpack).finally(() => downloads.delete(directory));
    downloads.set(directory, install);
    return install;
}

async function download(stage: string): Promise<void> {
    const url = `https://registry.npmjs.org/webr/-/webr-${WEBR_VERSION}.tgz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
        throw new Error(`Cannot download webR: HTTP ${response.status} from ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha512').update(bytes).digest('base64') !== integrity) {
        throw new Error('The downloaded webR archive failed its integrity check.');
    }
    const archive = path.join(stage, 'runtime.tgz');
    await writeFile(archive, bytes);
    await pipeline(
        createReadStream(archive),
        extract({
            cwd: stage,
            strip: 2,
            filter: (entry) => entry.startsWith('package/dist/'),
        }),
    );
    await rm(archive);
}

async function prepareWorker(stage: string): Promise<void> {
    // webR 0.6.1 imports path.resolve(".../R.js") as an ESM specifier. Node treats
    // a drive letter as a protocol and interprets # and % in unescaped filenames.
    const file = path.join(stage, 'webr-worker.js');
    const worker = await readFile(file, 'utf8');
    const original = 'await import((await import("path")).default.resolve(e))';
    const portable =
        'await import((await import("node:url")).pathToFileURL((await import("node:path")).resolve(e)).href)';
    if (worker.split(original).length !== 2) {
        throw new Error('The pinned webR Node loader has changed.');
    }
    // The synchronous XMLHttpRequest shim invokes process.argv[0] in a child.
    // Only this Wasm worker's children should inherit Electron's Node mode.
    const bootstrap = 'if (process.versions.electron) process.env.ELECTRON_RUN_AS_NODE = "1";\n';
    await writeFile(file, bootstrap + worker.replace(original, portable));
}

/** Inventory the runtime binaries and lazy VFS files. The download already verified their contents. */
async function signature(directory: string): Promise<string> {
    const inventory: string[] = [];
    async function file(relative: string): Promise<void> {
        const entry = await stat(path.join(directory, relative));
        if (!entry.isFile()) {
            throw new InvalidAsset('Invalid webR asset: ' + relative);
        }
        inventory.push(relative + '\0' + entry.size);
    }
    async function tree(relative: string): Promise<void> {
        const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
        await Promise.all(
            entries.map((entry) => {
                const name = relative + '/' + entry.name;
                return entry.isDirectory() ? tree(name) : file(name);
            }),
        );
    }
    await Promise.all([...assets.map(file), tree('vfs')]);
    return createHash('sha256').update(inventory.sort().join('\n')).digest('hex');
}

async function state(directory: string): Promise<'missing' | 'ready' | 'incomplete'> {
    try {
        if (!(await lstat(directory)).isDirectory()) {
            return 'incomplete';
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 'missing';
        }
        throw error;
    }
    try {
        const marker = await readFile(path.join(directory, '.complete'), 'utf8');
        if (/^[0-9a-f]{64}$/.test(marker) && marker === (await signature(directory))) {
            return 'ready';
        }
    } catch (error) {
        if (
            !(error instanceof InvalidAsset) &&
            !['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
            throw error;
        }
    }
    return 'incomplete';
}

async function prepare(
    directory: string,
    unpack: (stage: string) => Promise<void>,
): Promise<string> {
    await mkdir(path.dirname(directory), { recursive: true });
    let stage: string | undefined;
    try {
        for (let index = 0; ; index++) {
            const target = index ? directory + '-' + index : directory;
            const status = await state(target);
            if (status === 'ready') {
                return target + path.sep;
            }
            // An old worker may still use parts of this generation. Leave it in
            // place and publish the repair at a fresh path.
            if (status === 'incomplete') {
                continue;
            }
            if (!stage) {
                stage = await mkdtemp(directory + '-staging-');
                await unpack(stage);
                await prepareWorker(stage);
                await writeFile(path.join(stage, '.complete'), await signature(stage));
            }
            try {
                await rename(stage, target);
                stage = undefined;
                return target + path.sep;
            } catch (error) {
                if (
                    !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
                        (error as NodeJS.ErrnoException).code ?? '',
                    )
                ) {
                    throw error;
                }
                const raced = await state(target);
                if (raced === 'ready') {
                    return target + path.sep;
                }
                if (raced === 'missing') {
                    throw error;
                }
            }
        }
    } finally {
        if (stage) {
            await rm(stage, { recursive: true, force: true });
        }
    }
}
