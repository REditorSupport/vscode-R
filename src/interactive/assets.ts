import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';

const mimeTypes: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.json': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
};

/** Immutable, session-private assets. The HTTP service exposes assets only, never execution. */
export class AssetStore {
    private server?: http.Server;
    private token = randomBytes(32).toString('hex');
    base = '';
    private bytes = 0;

    constructor(readonly directory: string, private limit = 512 * 1024 * 1024) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const size = (file: string): number => {
            const stat = fs.lstatSync(file);
            return stat.isDirectory() ? fs.readdirSync(file).reduce((sum, entry) => sum + size(path.join(file, entry)), 0) : stat.size;
        };
        this.bytes = size(directory);
    }

    put(content: Buffer | string, extension: string): string {
        if (!/^\.[a-z0-9]+$/.test(extension)) { throw new Error('Invalid asset extension'); }
        const id = createHash('sha256').update(content).digest('hex') + extension;
        const file = path.join(this.directory, id);
        if (!fs.existsSync(file)) {
            this.reserve(Buffer.byteLength(content));
            fs.writeFileSync(file, content, { mode: 0o600 });
        }
        return id;
    }

    importHtml(file: string): string {
        if (fs.lstatSync(file).isSymbolicLink()) { throw new Error('HTML bundles cannot contain symbolic links'); }
        const root = path.dirname(fs.realpathSync(file));
        const entries: { relative: string; bytes: Buffer }[] = [];
        const visited = new Set<string>();
        let total = 0;
        const collect = (absolute: string): void => {
            if (visited.has(absolute)) { return; }
            visited.add(absolute);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) { throw new Error('HTML bundles cannot contain symbolic links'); }
            if (stat.isDirectory()) {
                for (const entry of fs.readdirSync(absolute)) { collect(path.join(absolute, entry)); }
                return;
            }
            if (!stat.isFile()) { return; }
            total += stat.size;
            if (total > 64 * 1024 * 1024 || entries.length >= 5000) { throw new Error('HTML bundle exceeds the 64 MiB / 5000 file limit'); }
            const bytes = fs.readFileSync(absolute);
            entries.push({ relative: path.relative(root, absolute), bytes });
            if (!/\.(html?|css)$/i.test(absolute)) { return; }
            // Copy referenced dependencies, never unrelated siblings of an HTML file.
            const references = bytes.toString('utf8').matchAll(/(?:\b(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\))/gi);
            for (const match of references) {
                const reference = (match[1] ?? match[2]).trim().replace(/&amp;/g, '&');
                if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) { continue; }
                const target = path.resolve(path.dirname(absolute), decodeURIComponent(reference.split(/[?#]/)[0]));
                if (!target.startsWith(root + path.sep)) { throw new Error('HTML dependencies must be inside the bundle directory'); }
                if (!fs.existsSync(target)) { continue; }
                const relative = path.relative(root, target);
                // Widget libraries may load additional files dynamically inside their own directory.
                collect(relative.includes(path.sep) ? path.join(root, relative.split(path.sep)[0]) : target);
            }
        };
        collect(fs.realpathSync(file));
        entries.sort((a, b) => a.relative.localeCompare(b.relative));
        const hash = createHash('sha256');
        for (const entry of entries) { hash.update(entry.relative).update('\0').update(entry.bytes); }
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
            } catch (error) {
                fs.rmSync(temporary, { recursive: true, force: true });
                throw error;
            }
        }
        return `${id}/${path.basename(file)}`;
    }

    resolve(id: string): string {
        const relative = path.normalize(id);
        if (path.isAbsolute(relative) || relative.startsWith('..') || relative.includes('\0')) {
            throw new Error('Invalid asset path');
        }
        const file = fs.realpathSync(path.join(this.directory, relative));
        if (!file.startsWith(fs.realpathSync(this.directory) + path.sep)) { throw new Error('Invalid asset path'); }
        return file;
    }

    private reserve(bytes: number): void {
        if (this.bytes + bytes > this.limit) { throw new Error('Session asset storage limit reached. Export history and remove unused stopped sessions, or increase r.interactive.maxAssetBytes.'); }
        this.bytes += bytes;
    }

    async start(): Promise<void> {
        this.server = http.createServer((request, response) => {
            try {
                if (request.method !== 'GET' && request.method !== 'HEAD') {
                    response.writeHead(405).end(); return;
                }
                const url = new URL(request.url ?? '/', 'http://localhost');
                const prefix = `/${this.token}/`;
                if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
                const file = this.resolve(decodeURIComponent(url.pathname.slice(prefix.length)));
                const stat = fs.statSync(file);
                if (!stat.isFile()) { response.writeHead(404).end(); return; }
                response.writeHead(200, {
                    'Content-Type': mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
                    'Content-Length': stat.size,
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'private, max-age=31536000, immutable',
                    'Access-Control-Allow-Origin': '*',
                    'Content-Security-Policy': 'default-src \'self\' data: blob: https:; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https:; style-src \'self\' \'unsafe-inline\' https:; connect-src \'self\' https: wss:; object-src \'none\'; base-uri \'none\'; frame-ancestors *',
                });
                if (request.method === 'HEAD') { response.end(); }
                else { fs.createReadStream(file).on('error', () => response.destroy()).pipe(response); }
            } catch {
                response.writeHead(404).end();
            }
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(0, '127.0.0.1', resolve);
        });
        const address = this.server.address();
        if (!address || typeof address === 'string') { throw new Error('Could not open asset server'); }
        this.base = `http://127.0.0.1:${address.port}/${this.token}/`;
    }

    close(): void { this.server?.close(); }
}
