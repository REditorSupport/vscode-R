import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** Shared by all plot backends in one workspace, not a per-session allowance. */
export const PERSISTENT_PLOT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export interface PersistentPlotReference {
    cacheKey: string;
}

const filePattern = /^[a-f0-9]{64}\.json$/;

/** Disk persistence for reload restoration, separate from the viewer's in-memory history.
 * Metadata is published only after the content-addressed files finish writing.
 */
export class PersistentPlotCache {
    private files = new Map<string, { bytes: number; created: number }>();
    private references = new Map<string, Set<string>>();
    private initialized?: Promise<void>;
    private writes: Promise<unknown> = Promise.resolve();
    private bytes = 0;
    private discarded = new Set<string>();

    constructor(
        private readonly directory: string | undefined,
        private readonly maxBytes = PERSISTENT_PLOT_CACHE_MAX_BYTES,
    ) {}

    register(namespace: string, references: Iterable<string>): void {
        this.references.set(namespace, new Set(references));
    }

    private initialize(): Promise<void> {
        this.initialized ??= (async () => {
            if (!this.directory) {
                return;
            }
            await fs.mkdir(this.directory, { recursive: true });
            for (const name of await fs.readdir(this.directory)) {
                if (!filePattern.test(name)) {
                    continue;
                }
                const stat = await fs.stat(path.join(this.directory, name));
                if (!stat.isFile()) {
                    continue;
                }
                this.files.set(name.slice(0, -5), { bytes: stat.size, created: stat.mtimeMs });
                this.bytes += stat.size;
            }
            await this.collect();
            await this.makeRoom(0);
            for (const keys of this.references.values()) {
                for (const key of keys) {
                    if (!this.files.has(key)) {
                        this.discarded.add(key);
                    }
                }
            }
        })().catch((error: unknown) => {
            this.initialized = undefined;
            this.files.clear();
            this.bytes = 0;
            throw error;
        });
        return this.initialized;
    }

    private async remove(key: string): Promise<void> {
        const file = this.files.get(key);
        if (!file || !this.directory) {
            return;
        }
        await fs.rm(path.join(this.directory, `${key}.json`), { force: true });
        this.bytes -= file.bytes;
        this.files.delete(key);
    }

    private async collect(): Promise<void> {
        const retained = new Set([...this.references.values()].flatMap((keys) => [...keys]));
        for (const key of this.files.keys()) {
            if (!retained.has(key)) {
                await this.remove(key);
            }
        }
        for (const key of this.discarded) {
            if (!retained.has(key)) {
                this.discarded.delete(key);
            }
        }
    }

    private async makeRoom(bytes: number, retained?: ReadonlySet<string>): Promise<void> {
        // Replacements must release superseded payloads before evicting plots
        // still referenced by the next checkpoint or the other backend.
        if (retained) {
            for (const key of this.files.keys()) {
                if (this.bytes + bytes <= this.maxBytes) {
                    break;
                }
                if (!retained.has(key)) {
                    await this.remove(key);
                }
            }
        }
        if (this.bytes + bytes <= this.maxBytes) {
            return;
        }
        const oldest = [...this.files].sort((a, b) => a[1].created - b[1].created);
        for (const [key] of oldest) {
            if (this.bytes + bytes <= this.maxBytes) {
                break;
            }
            await this.remove(key);
            this.discarded.add(key);
        }
    }

    async read(reference: PersistentPlotReference): Promise<unknown> {
        const key = reference?.cacheKey;
        if (!this.directory || typeof key !== 'string' || !filePattern.test(`${key}.json`)) {
            return undefined;
        }
        try {
            await this.initialize();
            if (!this.files.has(key)) {
                return undefined;
            }
            const content = await fs.readFile(path.join(this.directory, `${key}.json`));
            if (createHash('sha256').update(content).digest('hex') !== key) {
                return undefined;
            }
            return JSON.parse(content.toString('utf8')) as unknown;
        } catch (error) {
            // Cache eviction, interrupted writes and manual cache cleanup are recoverable.
            if (
                error instanceof SyntaxError ||
                (error as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
                return undefined;
            }
            console.warn('[Plot Viewer] Could not read plot cache', error);
            return undefined;
        }
    }

    /** Serialize writes across both backends so their combined size stays within the budget. */
    write<T>(
        namespace: string,
        build: (put: (plot: object) => Promise<PersistentPlotReference>) => Promise<T>,
        publish: (metadata: T) => PromiseLike<void>,
    ): Promise<void> {
        const operation = this.writes.then(async () => {
            await this.initialize();
            const references = new Set<string>();
            // Keep snapshot objects, not a second serialized copy of the entire
            // history. Only missing payloads need serialization again for writing.
            const pending = new Map<string, { plot: object; bytes: number }>();
            const metadata = await build((plot) => {
                const content = JSON.stringify(plot);
                const key = createHash('sha256').update(content).digest('hex');
                references.add(key);
                const bytes = Buffer.byteLength(content);
                if (
                    this.directory &&
                    bytes <= this.maxBytes &&
                    !this.files.has(key) &&
                    !this.discarded.has(key)
                ) {
                    pending.set(key, { plot, bytes });
                }
                return Promise.resolve({ cacheKey: key });
            });
            const retained = new Set(references);
            for (const [other, keys] of this.references) {
                if (other !== namespace) {
                    for (const key of keys) {
                        retained.add(key);
                    }
                }
            }
            for (const [key, { plot, bytes }] of pending) {
                if (this.directory) {
                    const content = JSON.stringify(plot);
                    await this.makeRoom(bytes, retained);
                    const filename = path.join(this.directory, `${key}.json`);
                    try {
                        await fs.writeFile(filename, content);
                    } catch (error) {
                        await fs.rm(filename, { force: true });
                        throw error;
                    }
                    this.files.set(key, { bytes, created: Date.now() });
                    this.bytes += bytes;
                }
            }
            await publish(metadata);
            this.register(namespace, references);
            await this.collect();
        });
        // A failed checkpoint must not prevent later writes from retrying.
        this.writes = operation.catch(() => {});
        return operation;
    }
}
