import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { DEFAULT_MAX_ASSET_BYTES } from './protocol';

export interface AssetStorageStats {
    usedBytes: number;
    limitBytes: number;
    reclaimedBytes: number;
}

const compressedAsset = /^[a-f0-9]{64}\.(svg|json)\.gz$/;
export const exportedAssetName = (id: string): string =>
    compressedAsset.test(id) ? id.slice(0, -3) : id;

function resolveAsset(directory: string, id: string): string {
    const relative = path.normalize(id);
    if (path.isAbsolute(relative) || relative.startsWith('..') || relative.includes('\0')) {
        throw new Error('Invalid asset path');
    }
    const file = fs.realpathSync(path.join(directory, relative));
    if (!file.startsWith(fs.realpathSync(directory) + path.sep)) {
        throw new Error('Invalid asset path');
    }
    return file;
}

/** Decode only our compressed assets; widget dependency files retain their original encoding. */
export function readAsset(directory: string, id: string, maxBytes = 256 * 1024 * 1024): Buffer {
    const file = resolveAsset(directory, id);
    if (fs.statSync(file).size > maxBytes) {
        throw new Error('Use the asset URL for large files');
    }
    const bytes = fs.readFileSync(file);
    return compressedAsset.test(id) ? gunzipSync(bytes, { maxOutputLength: maxBytes }) : bytes;
}

function fileBytes(file: string): number {
    const stat = fs.lstatSync(file);
    return stat.isDirectory()
        ? fs.readdirSync(file).reduce((sum, entry) => sum + fileBytes(path.join(file, entry)), 0)
        : stat.size;
}

const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.json': 'application/json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain',
};

/** Immutable, session-private assets. The HTTP service exposes assets only, never execution. */
export class AssetStore {
    private server?: http.Server;
    private token = randomBytes(32).toString('hex');
    base = '';
    private bytes = 0;
    private lastCollection = 0;
    private lastCollectionBytes = -1;

    constructor(
        readonly directory: string,
        private limit = DEFAULT_MAX_ASSET_BYTES,
        private retained?: () => Set<string>,
    ) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.bytes = fileBytes(directory);
    }

    stats(): AssetStorageStats {
        return { usedBytes: this.bytes, limitBytes: this.limit, reclaimedBytes: 0 };
    }

    setLimit(limit: number): void {
        if (!Number.isSafeInteger(limit) || limit < 1024 * 1024) {
            throw new Error('Asset limit must be an integer of at least 1 MiB');
        }
        if (limit < this.bytes) {
            this.compact();
        }
        if (limit < this.bytes) {
            throw new Error(
                'Retained assets exceed this limit. Choose a higher limit to preserve existing output.',
            );
        }
        this.limit = limit;
    }

    compact(): AssetStorageStats {
        if (!this.retained) {
            return this.stats();
        }
        // The collector must finish before deleting anything: unreadable/corrupt
        // journals must never be interpreted as proof that assets are unused.
        const retained = new Set([...this.retained()].map((id) => id.split('/')[0]));
        let reclaimedBytes = 0;
        for (const name of fs.readdirSync(this.directory)) {
            if (retained.has(name) || !/^[a-f0-9]{64}(?:\.[a-z0-9]+(?:\.gz)?)?$/.test(name)) {
                continue;
            }
            const file = path.join(this.directory, name);
            const bytes = fileBytes(file);
            fs.rmSync(file, { recursive: true });
            reclaimedBytes += bytes;
        }
        this.bytes = fileBytes(this.directory);
        this.lastCollection = Date.now();
        this.lastCollectionBytes = this.bytes;
        return { ...this.stats(), reclaimedBytes };
    }

    put(content: Buffer | string, extension: string): string {
        if (!/^\.[a-z0-9]+$/.test(extension)) {
            throw new Error('Invalid asset extension');
        }
        let encoded = Buffer.isBuffer(content) ? content : Buffer.from(content);
        let suffix = extension;
        if ((extension === '.svg' || extension === '.json') && encoded.length >= 4096) {
            const compressed = gzipSync(encoded);
            if (compressed.length < encoded.length) {
                encoded = compressed;
                suffix += '.gz';
            }
        }
        const id = createHash('sha256').update(content).digest('hex') + suffix;
        const file = path.join(this.directory, id);
        if (!fs.existsSync(file)) {
            const bytes = encoded.length;
            this.reserve(bytes);
            const temporary = `${file}.tmp`;
            try {
                fs.writeFileSync(temporary, encoded, { mode: 0o600 });
                fs.renameSync(temporary, file);
                this.bytes += bytes;
            } catch (error) {
                fs.rmSync(temporary, { force: true });
                throw error;
            }
        }
        return id;
    }

    importHtml(file: string): string {
        if (fs.lstatSync(file).isSymbolicLink()) {
            throw new Error('HTML bundles cannot contain symbolic links');
        }
        const root = path.dirname(fs.realpathSync(file));
        const entries: { relative: string; bytes: Buffer }[] = [];
        const visited = new Set<string>();
        let total = 0;
        const collect = (absolute: string): void => {
            if (visited.has(absolute)) {
                return;
            }
            visited.add(absolute);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                throw new Error('HTML bundles cannot contain symbolic links');
            }
            if (stat.isDirectory()) {
                for (const entry of fs.readdirSync(absolute)) {
                    collect(path.join(absolute, entry));
                }
                return;
            }
            if (!stat.isFile()) {
                return;
            }
            total += stat.size;
            if (total > 64 * 1024 * 1024 || entries.length >= 5000) {
                throw new Error('HTML bundle exceeds the 64 MiB / 5000 file limit');
            }
            const bytes = fs.readFileSync(absolute);
            entries.push({ relative: path.relative(root, absolute), bytes });
            if (!/\.(html?|css)$/i.test(absolute)) {
                return;
            }
            // Copy referenced dependencies, never unrelated siblings of an HTML file.
            const references = bytes
                .toString('utf8')
                .matchAll(
                    /(?:\b(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\))/gi,
                );
            for (const match of references) {
                const reference = (match[1] ?? match[2]).trim().replace(/&amp;/g, '&');
                if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) {
                    continue;
                }
                const target = path.resolve(
                    path.dirname(absolute),
                    decodeURIComponent(reference.split(/[?#]/)[0]),
                );
                if (!target.startsWith(root + path.sep)) {
                    throw new Error('HTML dependencies must be inside the bundle directory');
                }
                if (!fs.existsSync(target)) {
                    continue;
                }
                const relative = path.relative(root, target);
                // Widget libraries may load additional files dynamically inside their own directory.
                collect(
                    relative.includes(path.sep)
                        ? path.join(root, relative.split(path.sep)[0])
                        : target,
                );
            }
        };
        collect(fs.realpathSync(file));
        entries.sort((a, b) => a.relative.localeCompare(b.relative));
        const hash = createHash('sha256');
        for (const entry of entries) {
            hash.update(entry.relative).update('\0').update(entry.bytes);
        }
        const id = hash.digest('hex');
        const destination = path.join(this.directory, id);
        if (!fs.existsSync(destination)) {
            this.reserve(total);
            const temporary = `${destination}.tmp`;
            fs.mkdirSync(temporary, { mode: 0o700 });
            try {
                for (const entry of entries) {
                    const target = path.join(temporary, entry.relative);
                    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
                    fs.writeFileSync(target, entry.bytes, { mode: 0o600 });
                }
                fs.renameSync(temporary, destination);
                this.bytes += total;
            } catch (error) {
                fs.rmSync(temporary, { recursive: true, force: true });
                throw error;
            }
        }
        return `${id}/${path.basename(file)}`;
    }

    resolve(id: string): string {
        return resolveAsset(this.directory, id);
    }

    read(id: string, maxBytes?: number): Buffer {
        return readAsset(this.directory, id, maxBytes);
    }

    exportTo(destination: string, ids: Iterable<string>): void {
        const source = path.resolve(this.directory),
            target = path.resolve(destination);
        if (target === source || target.startsWith(source + path.sep)) {
            throw new Error('Export outside the session asset directory');
        }
        fs.mkdirSync(destination, { recursive: true });
        for (const id of new Set([...ids].map((id) => id.split('/')[0]))) {
            if (compressedAsset.test(id)) {
                fs.writeFileSync(path.join(destination, exportedAssetName(id)), this.read(id));
            } else {
                fs.cpSync(this.resolve(id), path.join(destination, id), { recursive: true });
            }
        }
    }

    private reserve(bytes: number): void {
        // Start reclaiming superseded/unreferenced assets at 80% of the hard cap.
        // Repeated failures must not rescan every journal for every drawing frame.
        if (
            this.bytes + bytes > this.limit * 0.8 &&
            (this.bytes !== this.lastCollectionBytes || Date.now() - this.lastCollection > 1000)
        ) {
            this.compact();
        }
        if (this.bytes + bytes > this.limit) {
            throw new Error(
                `Session asset storage limit reached (${Math.round(this.limit / 1024 / 1024)} MiB). Retained outputs were preserved. Increase r.interactive.maxAssetSizeMiB or use R: Clean Up Interactive Assets.`,
            );
        }
    }

    async start(): Promise<void> {
        this.server = http.createServer((request, response) => {
            try {
                if (request.method !== 'GET' && request.method !== 'HEAD') {
                    response.writeHead(405).end();
                    return;
                }
                const url = new URL(request.url ?? '/', 'http://localhost');
                const prefix = `/${this.token}/`;
                if (!url.pathname.startsWith(prefix)) {
                    response.writeHead(404).end();
                    return;
                }
                const id = decodeURIComponent(url.pathname.slice(prefix.length));
                const file = this.resolve(id);
                const stat = fs.statSync(file);
                if (!stat.isFile()) {
                    response.writeHead(404).end();
                    return;
                }
                response.writeHead(200, {
                    'Content-Type':
                        mimeTypes[path.extname(exportedAssetName(id)).toLowerCase()] ??
                        'application/octet-stream',
                    ...(compressedAsset.test(id) ? { 'Content-Encoding': 'gzip' } : {}),
                    'Content-Length': stat.size,
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'private, max-age=31536000, immutable',
                    'Access-Control-Allow-Origin': '*',
                    // CSP's wildcard does not include VS Code's custom desktop schemes.
                    // Both the notebook webview and its top-level editor are ancestors.
                    'Content-Security-Policy':
                        "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; frame-ancestors * vscode-webview: vscode-file:",
                });
                if (request.method === 'HEAD') {
                    response.end();
                } else {
                    fs.createReadStream(file)
                        .on('error', () => response.destroy())
                        .pipe(response);
                }
            } catch {
                response.writeHead(404).end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(0, '127.0.0.1', resolve);
        });
        const address = this.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Could not open asset server');
        }
        this.base = `http://127.0.0.1:${address.port}/${this.token}/`;
    }

    close(): void {
        this.server?.close();
    }
}
