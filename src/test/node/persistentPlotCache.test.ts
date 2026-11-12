import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import {
    PersistentPlotCache,
    PERSISTENT_PLOT_CACHE_MAX_BYTES,
    PersistentPlotReference,
} from '../../plotViewer/persistentPlotCache';
import { PlotHistoryPersistence } from '../../plotViewer/plotHistoryPersistence';
import { PlotHistory, PlotFrame, PlotHistoryState } from '../../plotViewer/jgdPlotHistory';

suite('Persistent workspace plot cache', () => {
    let directory: string;
    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plot-cache-'));
    });
    teardown(async () => {
        // mkdtemp returns the exact isolated directory this test owns.
        await fs.rm(directory, { recursive: true, force: true });
    });

    async function size(): Promise<number> {
        const files = await fs.readdir(directory);
        return (
            await Promise.all(
                files.map(async (name) => (await fs.stat(path.join(directory, name))).size),
            )
        ).reduce((sum, bytes) => sum + bytes, 0);
    }

    async function put(cache: PersistentPlotCache, namespace: string, plots: object[]) {
        let refs: PersistentPlotReference[] = [];
        await cache.write(
            namespace,
            async (write) => {
                const result = [];
                for (const plot of plots) {
                    result.push(await write(plot));
                }
                return result;
            },
            (value) => {
                refs = value;
                return Promise.resolve();
            },
        );
        return refs;
    }

    test('uses one 256 MiB budget; concurrent backend saves evict the oldest whole plot', async () => {
        assert.equal(PERSISTENT_PLOT_CACHE_MAX_BYTES, 256 * 1024 * 1024);
        const a = { data: 'a'.repeat(80) },
            b = { data: 'b'.repeat(80) },
            c = { data: 'c'.repeat(80) };
        const bytes = Buffer.byteLength(JSON.stringify(a));
        const cache = new PersistentPlotCache(directory, bytes * 2);
        const [jgd, httpgd] = await Promise.all([
            put(cache, 'jgd', [a, b]),
            put(cache, 'httpgd', [c]),
        ]);
        assert.equal(await size(), bytes * 2);
        assert.equal(await cache.read(jgd[0]), undefined);
        assert.deepEqual(await cache.read(jgd[1]), b);
        assert.deepEqual(await cache.read(httpgd[0]), c);
        // Saving unchanged live history must not cycle evicted plots back onto disk.
        await put(cache, 'jgd', [a, b]);
        assert.equal(await cache.read(jgd[0]), undefined);
        assert.deepEqual(await cache.read(httpgd[0]), c);
        const reload = new PersistentPlotCache(directory, bytes * 2);
        reload.register(
            'jgd',
            jgd.map((ref) => ref.cacheKey),
        );
        reload.register(
            'httpgd',
            httpgd.map((ref) => ref.cacheKey),
        );
        assert.deepEqual(await reload.read(jgd[1]), b);
        assert.deepEqual(await reload.read(httpgd[0]), c);
    });

    test('skips an oversized plot, measures UTF-8 bytes, and keeps the live input intact', async () => {
        const cache = new PersistentPlotCache(directory, 100);
        const plot = { data: '漢'.repeat(50) };
        const [ref] = await put(cache, 'jgd', [plot]);
        assert.equal(await cache.read(ref), undefined);
        assert.equal(await size(), 0);
        assert.equal(plot.data.length, 50);
    });

    test('large histories share the byte budget without rewriting unchanged files', async () => {
        const cache = new PersistentPlotCache(directory, 20 * 1024 * 1024);
        const a = { data: 'a'.repeat(8 * 1024 * 1024) };
        const b = { data: 'b'.repeat(8 * 1024 * 1024) };
        const c = { data: 'c'.repeat(8 * 1024 * 1024) };
        const jgd = await put(cache, 'jgd', [a, b]);
        const filename = path.join(directory, `${jgd[1].cacheKey}.json`);
        await fs.utimes(filename, new Date(1000), new Date(1000));
        const httpgd = await put(cache, 'httpgd', [c]);
        await put(cache, 'jgd', [a, b]);
        assert.ok((await size()) <= 20 * 1024 * 1024);
        assert.equal(await cache.read(jgd[0]), undefined);
        assert.deepEqual(await cache.read(jgd[1]), b);
        assert.deepEqual(await cache.read(httpgd[0]), c);
        assert.equal((await fs.stat(filename)).mtimeMs, 1000);
    });

    test('recovers after an initial filesystem failure', async () => {
        const cacheDirectory = path.join(directory, 'cache');
        await fs.writeFile(cacheDirectory, 'not a directory');
        const cache = new PersistentPlotCache(cacheDirectory);
        await assert.rejects(put(cache, 'jgd', [{ data: 'plot' }]));
        await fs.rm(cacheDirectory);
        const [ref] = await put(cache, 'jgd', [{ data: 'plot' }]);
        assert.deepEqual(await cache.read(ref), { data: 'plot' });
    });

    test('does not share storage between workspaces or use a fallback for an empty window', async () => {
        const one = new PersistentPlotCache(path.join(directory, 'one'));
        const two = new PersistentPlotCache(path.join(directory, 'two'));
        const [ref] = await put(one, 'jgd', [{ data: 'workspace one' }]);
        two.register('jgd', [ref.cacheKey]);
        assert.equal(await two.read(ref), undefined);
        assert.deepEqual(await one.read(ref), { data: 'workspace one' });
        const emptyWindow = new PersistentPlotCache(undefined);
        const [unsaved] = await put(emptyWindow, 'jgd', [{ data: 'unsaved' }]);
        assert.equal(await emptyWindow.read(unsaved), undefined);
    });

    test('deleting one backend releases only its unreferenced files', async () => {
        const cache = new PersistentPlotCache(directory);
        const [a] = await put(cache, 'jgd', [{ data: 'a' }]);
        const [b] = await put(cache, 'httpgd', [{ data: 'b' }]);
        await put(cache, 'jgd', []);
        assert.equal(await cache.read(a), undefined);
        assert.deepEqual(await cache.read(b), { data: 'b' });
    });

    test('missing, corrupt and traversal references cannot break restoration', async () => {
        const cache = new PersistentPlotCache(directory);
        const [a, b] = await put(cache, 'jgd', [{ data: 'a' }, { data: 'b' }]);
        await fs.rm(path.join(directory, `${a.cacheKey}.json`));
        await fs.writeFile(path.join(directory, `${b.cacheKey}.json`), '{unfinished');
        assert.equal(await cache.read(a), undefined);
        assert.equal(await cache.read(b), undefined);
        assert.equal(await cache.read({ cacheKey: '../outside' }), undefined);
    });

    test('failed metadata publication is retryable and startup collects orphan files', async () => {
        const cache = new PersistentPlotCache(directory);
        const [old] = await put(cache, 'jgd', [{ data: 'old' }]);
        await assert.rejects(
            cache.write(
                'jgd',
                (write) => write({ data: 'orphan' }),
                () => {
                    throw new Error('storage unavailable');
                },
            ),
        );
        assert.deepEqual(await cache.read(old), { data: 'old' });
        const reload = new PersistentPlotCache(directory);
        reload.register('jgd', [old.cacheKey]);
        assert.deepEqual(await reload.read(old), { data: 'old' });
        assert.equal((await fs.readdir(directory)).length, 1);
        const [next] = await put(reload, 'jgd', [{ data: 'next' }]);
        assert.deepEqual(await reload.read(next), { data: 'next' });
        assert.equal((await fs.readdir(directory)).length, 1);
    });

    function fixture() {
        const values = new Map<string, unknown>();
        const context = {
            storageUri: { fsPath: directory },
            workspaceState: {
                get: (key: string) => values.get(key),
                update: (key: string, value: unknown) => {
                    values.set(key, structuredClone(value));
                    return Promise.resolve();
                },
            },
        } as unknown as ExtensionContext;
        return { values, storage: () => new PlotHistoryPersistence(context) };
    }

    function frame(device: string, label: string): PlotFrame {
        return {
            version: 1,
            sessionId: device,
            device: { width: 800, height: 600, dpi: 96, bg: 'white' },
            ops: [{ op: 'text', str: label }],
        };
    }

    test('migrates legacy JGD and SVG content to disk without retaining payloads in workspaceState', async () => {
        const { values, storage } = fixture();
        const history = new PlotHistory();
        history.addPlot('a', frame('a', 'JGD_PAYLOAD'));
        const legacy = { ...history.snapshot(), checkpointId: 'checkpoint' };
        values.set('r.plot.jgdState', legacy);
        const svg = {
            plots: [
                {
                    id: '1',
                    data: '<svg>SVG_PAYLOAD</svg>',
                    width: 800,
                    height: 600,
                    zoom: 1,
                    reference: { origin: 'http://localhost:1234', id: '1' },
                },
            ],
        };
        values.set('r.plot.httpgdHistory', { http: svg });
        const first = storage();
        const restored = await first.readJgd(legacy);
        assert.equal(restored.changed, true);
        assert.deepEqual(restored.state, legacy);
        await first.writeJgd(legacy);
        await first.writeHttpgd(new Map([['http', svg]]));
        const metadata = JSON.stringify([...values]);
        assert.ok(!metadata.includes('JGD_PAYLOAD'));
        assert.ok(!metadata.includes('SVG_PAYLOAD'));
        const reloaded = storage();
        const saved = values.get('r.plot.jgdState') as PlotHistoryState;
        const read = await reloaded.readJgd(saved);
        assert.deepEqual(read.state?.sessions, legacy.sessions);
        const http = (await reloaded.readHttpgd(values.get('r.plot.httpgdHistory'))) as {
            http: typeof svg;
        };
        assert.deepEqual(http.http.plots, svg.plots);
    });

    test('missing JGD frames preserve cross-device order and remap the selected position', async () => {
        const { values, storage } = fixture();
        const history = new PlotHistory();
        const owner = { sessionId: 'R', host: 'host', pid: '1', rVer: '4.6', processExited: false };
        history.addPlot('a', frame('a', 'first'));
        history.setSessionSource('a', owner);
        history.addPlot('b', frame('b', 'second'));
        history.setSessionSource('b', owner);
        history.addPlot('a', frame('a', 'third'));
        const first = storage();
        await first.writeJgd(history.snapshot());
        const saved = values.get('r.plot.jgdState') as PlotHistoryState;
        const ref = saved.sessions[0].plots[0] as unknown as PersistentPlotReference;
        await fs.rm(path.join(directory, 'plot-cache', `${ref.cacheKey}.json`));
        const restored = await storage().readJgd(saved, [{ deviceId: 'a', currentIndex: 1 }]);
        const next = new PlotHistory();
        next.restore(restored.state, restored.positions);
        assert.equal(next.count('a'), 2);
        assert.deepEqual(next.currentPlot('a')?.ops, [{ op: 'text', str: 'second' }]);
        assert.deepEqual(next.navigateLast('a')?.ops, [{ op: 'text', str: 'third' }]);
        assert.equal(restored.changed, true);
    });
});
