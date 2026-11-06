import * as assert from 'assert';
import type { Memento } from 'vscode';
import '../../extension';
import { PackageManager } from '../../helpViewer/packages';
import type { HelpFile, RHelp } from '../../helpViewer';

function jsonState(initial: Record<string, unknown> = {}): Memento {
    const values = new Map(Object.entries(initial));
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback,
        update: (key: string, value: unknown) => {
            if (value === undefined) {
                values.delete(key);
            } else {
                values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
            }
            return Promise.resolve();
        },
    } as Memento;
}

const index = (name: string): HelpFile => ({
    requestPath: '/library/example/html/00Index.html',
    html: `<table><tr><td><a href="${name}.html">${name}</a></td><td>Description</td></tr></table>`,
});

function manager(state: Memento, getHelpFileForPath: () => Promise<HelpFile | undefined>) {
    return new PackageManager({
        rPath: 'R',
        persistentState: state,
        rHelp: { getHelpFileForPath } as unknown as RHelp,
    });
}

suite('Help package state and index requests', () => {
    test('favorites survive JSON persistence and can be removed after reloading', () => {
        const state = jsonState();
        const first = manager(state, () => Promise.resolve(undefined));
        first.addFavorite('base');
        first.addFavorite('stats');
        const reloaded = manager(state, () => Promise.resolve(undefined));
        assert.deepStrictEqual([...reloaded.favoriteNames], ['base', 'stats']);
        assert.deepStrictEqual(reloaded.removeFavorite('base'), ['stats']);
        assert.deepStrictEqual(
            [...manager(state, () => Promise.resolve(undefined)).favoriteNames],
            ['stats'],
        );
    });

    test('recovers legacy serialized Sets and ignores invalid favorite values', () => {
        for (const saved of [{}, ['base', 1, null], new Set(['base'])]) {
            const packages = manager(jsonState({ 'r.helpPanel.favoriteNamesSet': saved }), () =>
                Promise.resolve(undefined),
            );
            assert.doesNotThrow(() => packages.addFavorite('stats'));
            assert.ok(packages.favoriteNames.has('stats'));
            assert.ok([...packages.favoriteNames].every((name) => typeof name === 'string'));
        }
    });

    test('concurrent topic requests share one pending index fetch', async () => {
        let requests = 0;
        let finish!: (file: HelpFile) => void;
        const file = new Promise<HelpFile>((resolve) => {
            finish = resolve;
        });
        const packages = manager(jsonState(), () => {
            requests++;
            return file;
        });
        const first = packages.getTopics('example');
        const second = packages.getTopics('example');
        assert.strictEqual(requests, 1);
        finish(index('first'));
        const [a, b] = await Promise.all([first, second]);
        assert.deepStrictEqual(a, b);
        await packages.getTopics('example');
        assert.strictEqual(requests, 1);
    });

    test('clearing the cache prevents an older pending fetch from restoring stale topics', async () => {
        let finish!: (file: HelpFile) => void;
        const oldFile = new Promise<HelpFile>((resolve) => {
            finish = resolve;
        });
        let requests = 0;
        const packages = manager(jsonState(), () =>
            ++requests === 1 ? oldFile : Promise.resolve(index('latest')),
        );
        const pending = packages.getTopics('example');
        await packages.clearCachedFiles();
        finish(index('stale'));
        await pending;
        const latest = await packages.getTopics('example');
        assert.strictEqual(requests, 2);
        assert.ok(latest?.some((topic) => topic.name === 'latest'));
        assert.ok(!latest?.some((topic) => topic.name === 'stale'));
    });
});
