import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionJournal } from '../../interactive/journal';
import { JsonLines } from '../../interactive/framing';
import { AssetStore } from '../../interactive/assets';
import { Transcript } from '../../interactive/transcript';
import { submission, AgentSnapshot } from '../../interactive/protocol';
import { defaultStorage, discoverSessions, installRuntime, prepareStorage, shellQuote } from '../../interactive/launcher';
import { tablePage, TABLE_PAGE_SIZE } from '../../interactive/tablePaging';
import { searchHistory } from '../../interactive/history';

suite('Interactive storage', () => {
    let home: string;
    setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-storage-')); });
    teardown(() => fs.rmSync(home, { recursive: true, force: true }));

    test('uses Application Support for new macOS registries and the state directory on Linux', () => {
        assert.strictEqual(defaultStorage('darwin', home, {}), path.join(home, 'Library', 'Application Support', 'vscode-r', 'interactive'));
        assert.strictEqual(defaultStorage('linux', home, {}), path.join(home, '.local', 'state', 'vscode-r', 'interactive'));
        assert.deepStrictEqual(fs.readdirSync(home), [], 'Resolving storage must not create directories');
    });

    test('honors absolute XDG state paths and ignores empty or relative values', () => {
        const xdg = path.join(home, 'state');
        for (const platform of ['darwin', 'linux'] as const) {
            assert.strictEqual(defaultStorage(platform, home, { XDG_STATE_HOME: xdg }), path.join(xdg, 'vscode-r', 'interactive'));
            for (const invalid of ['', 'relative/state']) {
                assert.strictEqual(defaultStorage(platform, home, { XDG_STATE_HOME: invalid }), defaultStorage(platform, home, {}));
            }
        }
    });

    test('reuses an existing macOS registry and discovers its original sessions', () => {
        const legacy = path.join(home, '.local', 'state', 'vscode-r', 'interactive');
        fs.mkdirSync(path.join(legacy, 'existing-session'), { recursive: true });
        const manifest = { id: 'existing-session', host: os.hostname(), created: 1 };
        fs.writeFileSync(path.join(legacy, manifest.id, 'manifest.json'), JSON.stringify(manifest));
        fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'vscode-r', 'interactive'), { recursive: true });
        assert.strictEqual(defaultStorage('darwin', home, {}), legacy);
        assert.deepStrictEqual(discoverSessions(defaultStorage('darwin', home, {})), [manifest]);
        assert.strictEqual(defaultStorage('darwin', home, { XDG_STATE_HOME: path.join(home, 'override') }),
            path.join(home, 'override', 'vscode-r', 'interactive'));
    });

    test('creates private macOS storage when .local is not writable', function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const local = path.join(home, '.local');
        fs.mkdirSync(local, { mode: 0o555 });
        try {
            assert.throws(() => fs.accessSync(local, fs.constants.W_OK));
            const root = defaultStorage('darwin', home, {});
            prepareStorage(root);
            fs.writeFileSync(path.join(root, 'runtimes', 'write-check'), 'ok');
            assert.strictEqual(fs.statSync(root).mode & 0o777, 0o700);
            assert.strictEqual(fs.statSync(path.join(root, 'runtimes')).mode & 0o777, 0o700);
            assert.strictEqual(fs.statSync(local).mode & 0o777, 0o555);
            assert.ok(!fs.existsSync(path.join(local, 'state')));
        } finally { fs.chmodSync(local, 0o700); }
    });

    test('reports unwritable storage before reading runtime sources or starting R', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const locked = path.join(home, 'locked'); fs.mkdirSync(locked, { mode: 0o500 });
        const root = path.join(locked, 'interactive');
        try {
            await assert.rejects(installRuntime('missing-extension', root, 'missing-R', () => undefined), (error: Error) => {
                assert.ok(error.message.includes(root));
                assert.match(error.message, /r\.interactive\.storagePath/);
                assert.match(error.message, /reload VS Code/);
                assert.match(error.message, /EACCES/);
                assert.strictEqual((error.cause as NodeJS.ErrnoException).code, 'EACCES');
                return true;
            });
            assert.deepStrictEqual(fs.readdirSync(home), ['locked'], 'No fallback registry is created');
        } finally { fs.chmodSync(locked, 0o700); }
    });

    test('checks write access to an existing runtimes directory', function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const runtimes = path.join(home, 'runtimes'); fs.mkdirSync(runtimes, { mode: 0o500 });
        try { assert.throws(() => prepareStorage(home), /r\.interactive\.storagePath.*EACCES/); }
        finally { fs.chmodSync(runtimes, 0o700); }
    });

    test('distinguishes a missing registry from an unreadable one', function () {
        assert.deepStrictEqual(discoverSessions(path.join(home, 'missing')), []);
        if (process.platform === 'win32' || process.getuid?.() === 0) { this.skip(); }
        const locked = path.join(home, 'locked'); fs.mkdirSync(locked, { mode: 0o300 });
        try { assert.throws(() => discoverSessions(locked), /r\.interactive\.storagePath.*EACCES/); }
        finally { fs.chmodSync(locked, 0o700); }
    });

    test('reports a file blocking the configured storage path', () => {
        const file = path.join(home, 'file'); fs.writeFileSync(file, 'keep');
        assert.throws(() => prepareStorage(path.join(file, 'interactive')), /r\.interactive\.storagePath/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'keep');
    });
});

suite('Interactive protocol and persistence', () => {
    let directory: string;
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-test-')); });
    teardown(() => fs.rmSync(directory, { recursive: true, force: true }));

    test('frames fragmented Unicode and rejects oversized unterminated input', () => {
        const received: Record<string, unknown>[] = [];
        const parser = new JsonLines(message => received.push(message), 100);
        const bytes = Buffer.from('{"text":"λ🙂"}\n{"text":"next"}\n');
        for (const byte of bytes) { parser.push(Buffer.from([byte])); }
        assert.deepStrictEqual(received, [{ text: 'λ🙂' }, { text: 'next' }]);
        assert.throws(() => parser.push(Buffer.alloc(101, 97)), /size limit/);
    });

    test('admission survives reopening and never accepts changed code with a reused ID', () => {
        let journal = new SessionJournal(directory, 'generation');
        const first = journal.accept({ id: 'one', code: 'counter <- counter + 1' });
        journal.append('accepted', { record: first.record }, 'one', true);
        assert.strictEqual(journal.accept(first.record).duplicate, true);
        assert.throws(() => journal.accept({ id: 'one', code: 'different()' }), /different code/);
        journal.close();
        fs.appendFileSync(path.join(directory, 'events-000000.jsonl'), '{"partial":');
        journal = new SessionJournal(directory, 'generation');
        assert.strictEqual(journal.seq, 1);
        assert.strictEqual(journal.accept(first.record).duplicate, true);
        journal.append('stream', { text: 'new' }, 'one');
        assert.strictEqual(journal.replay(0).events.length, 2);
        journal.close();
    });

    test('transcript deduplicates replay and replaces only the same display identity', () => {
        const journal = new SessionJournal(directory, 'generation');
        const record = journal.accept({ id: 'one', code: 'plot(1:3)' }).record;
        const accepted = journal.append('accepted', { record }, 'one');
        const first = journal.append('display', { displayId: 'plot', svg: 'a.svg' }, 'one');
        const next = journal.append('display', { displayId: 'plot', svg: 'b.svg' }, 'one');
        const model = new Transcript('generation');
        model.apply(accepted); model.apply(first); model.apply(next); model.apply(first);
        assert.strictEqual(model.cells.get('one')?.outputs.length, 1);
        assert.strictEqual(model.cells.get('one')?.outputs[0].data.svg, 'b.svg');
        assert.strictEqual(model.apply({ ...next, generation: 'other', seq: 9 }), undefined);
        const snapshot = { executions: [record], events: [first, next], seq: 3 } as AgentSnapshot;
        model.restore(snapshot);
        assert.strictEqual(model.cells.get('one')?.outputs.length, 1);
        journal.close();
    });

    test('asset paths cannot escape storage and HTML bundles retain local dependencies', () => {
        const assets = new AssetStore(path.join(directory, 'assets'));
        const source = path.join(directory, 'widget'); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'index.html'), '<script src="widget.js"></script>');
        fs.writeFileSync(path.join(source, 'widget.js'), 'window.answer = 42;');
        fs.writeFileSync(path.join(source, 'unrelated.txt'), 'not part of the widget');
        const id = assets.importHtml(path.join(source, 'index.html'));
        assert.throws(() => assets.resolve(id.replace('index.html', 'unrelated.txt')));
        assert.match(fs.readFileSync(assets.resolve(id), 'utf8'), /widget.js/);
        assert.strictEqual(fs.readFileSync(assets.resolve(id.replace('index.html', 'widget.js')), 'utf8'), 'window.answer = 42;');
        assert.throws(() => assets.resolve('../widget/index.html'), /Invalid asset/);
        if (process.platform !== 'win32') {
            fs.symlinkSync(path.join(source, 'index.html'), path.join(source, 'linked.html'));
            fs.appendFileSync(path.join(source, 'index.html'), '<script src="linked.html"></script>');
            assert.throws(() => assets.importHtml(path.join(source, 'index.html')), /symbolic/);
        }
    });

    test('validates code and shell-quotes launch arguments without evaluating them', () => {
        assert.throws(() => submission({ id: '../escape', code: '1' }), /identifier/);
        assert.throws(() => submission({ id: 'id', code: '' }), /nonempty/);
        assert.strictEqual(shellQuote('a\'b $HOME `touch nope`'), '\'a\'"\'"\'b $HOME `touch nope`\'');
    });

    test('inline table pages visit every row once and stop at the final partial page', () => {
        const rows: number[] = [];
        for (let start = 0; start < 53; start += TABLE_PAGE_SIZE) {
            const page = tablePage(53, start);
            for (let row = page.start; row < page.end; row++) { rows.push(row); }
        }
        assert.deepStrictEqual(rows, Array.from({ length: 53 }, (_, i) => i));
        assert.deepStrictEqual(tablePage(53, 1000), { start: 40, end: 53 });
        assert.deepStrictEqual(tablePage(0, 20), { start: 0, end: 0 });
        assert.deepStrictEqual(tablePage(53, NaN), { start: 0, end: 20 });
    });

    test('history searches older admitted code with stable paging and bounded responses', () => {
        const journal = new SessionJournal(directory, 'history');
        try {
            for (let i = 0; i < 5; i++) { journal.accept({ id: `id${i}`, code: `plot(${i}) # λ` }); }
            const page = searchHistory(journal.executions.values(), 'PLOT', undefined, 2);
            assert.deepStrictEqual(page.executions.map(record => record.id), ['id4', 'id3']);
            assert.ok(page.more);
            assert.deepStrictEqual(searchHistory(journal.executions.values(), 'λ', page.executions[1].order).executions.map(record => record.id), ['id2', 'id1', 'id0']);
            assert.strictEqual(searchHistory(journal.executions.values(), 'absent').executions.length, 0);
            const huge = page.executions.map(record => ({ ...record, code: 'x'.repeat(1024 * 1024) }));
            assert.ok(Buffer.byteLength(JSON.stringify(searchHistory(huge))) < 3 * 1024 * 1024);
            assert.ok(searchHistory(huge).more);
        } finally { journal.close(); }
    });
});
