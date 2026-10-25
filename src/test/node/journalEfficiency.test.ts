import * as assert from 'assert';
import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { createHash } from 'crypto';
import {
    SessionJournal,
    readPreviousJournalAsync,
    retainedAssetIds,
    atomicJson,
} from '../../interactive/journal';
import { getJournalIndex } from '../../interactive/journalIndex';

suite('Indexed journal working sets', () => {
    let root: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-journal-index-'));
    });
    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reads only the latest execution range after old output rotates into multiple segments', () => {
        const directory = path.join(root, 'generation');
        const journal = new SessionJournal(directory, 'generation', 32 * 1024 * 1024);
        try {
            const old = journal.accept({ id: 'old', code: 'print(large)' }).record;
            journal.append('accepted', { record: old }, old.id);
            for (let i = 0; i < 24; i++) {
                journal.append('stream', { text: 'x'.repeat(512 * 1024) }, old.id);
            }
            const latest = journal.accept({ id: 'latest', code: '1 + 1' }).record;
            journal.append('accepted', { record: latest }, latest.id);
            journal.append('stream', { text: '[1] 2\n' }, latest.id);
            let readBytes = 0;
            const original = fs.readSync;
            const stub = sinon.stub(fs, 'readSync').callsFake(((
                ...args: Parameters<typeof fs.readSync>
            ) => {
                const size = Reflect.apply(original, fs, args) as number;
                readBytes += size;
                return size;
            }) as typeof fs.readSync);
            try {
                const recent = journal.recent(1);
                assert.deepStrictEqual(
                    recent.executions.map((record) => record.id),
                    ['latest'],
                );
                assert.deepStrictEqual(
                    recent.events.map((event) => event.type),
                    ['accepted', 'stream'],
                );
                assert.ok(
                    readBytes < 64 * 1024,
                    'A one-cell read must not scan the old 12 MiB output',
                );
            } finally {
                stub.restore();
            }
        } finally {
            journal.close();
        }
    });

    test('reopens indexed output without rereading full segments and repairs a torn tail', () => {
        const directory = path.join(root, 'generation');
        let journal = new SessionJournal(directory, 'generation');
        const record = journal.accept({ id: 'old', code: 'print(x)' }).record;
        journal.append('accepted', { record }, record.id);
        for (let i = 0; i < 10; i++) {
            journal.append('stream', { text: 'x'.repeat(512 * 1024) }, record.id);
        }
        const seq = journal.seq;
        journal.close();
        const stub = sinon.stub(fs, 'readFileSync').callsFake(((
            ...args: Parameters<typeof fs.readFileSync>
        ) => {
            assert.ok(
                !/events-\d{6}\.jsonl$/.test(String(args[0])),
                'Warm open should use its verified index',
            );
            return Reflect.apply(stub.wrappedMethod, fs, args) as Buffer;
        }) as typeof fs.readFileSync);
        try {
            journal = new SessionJournal(directory, 'generation');
            assert.strictEqual(journal.seq, seq);
            journal.close();
        } finally {
            stub.restore();
        }
        const file = getJournalIndex(directory, 'generation').segments.at(-1)!.name;
        fs.appendFileSync(path.join(directory, file), '{"torn":');
        journal = new SessionJournal(directory, 'generation');
        try {
            assert.strictEqual(journal.seq, seq);
            assert.strictEqual(
                journal.accept({ id: record.id, code: record.code }).duplicate,
                true,
            );
            assert.throws(
                () => journal.accept({ id: record.id, code: 'different()' }),
                /different code/,
            );
        } finally {
            journal.close();
        }
    });

    test('indexes prototype-named execution IDs after a cold persisted-index reopen', () => {
        const original = path.join(root, 'original'),
            directory = path.join(root, 'cold');
        let journal = new SessionJournal(original, 'generation');
        journal.accept({ id: 'old', code: '1' });
        journal.append('stream', { text: 'old output' }, 'old');
        journal.close();
        fs.cpSync(original, directory, { recursive: true });
        // Keep a valid persisted index while using a path outside the hot cache.
        const file = path.join(directory, 'events-index.json');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { data: string; hash: string };
        const index = JSON.parse(saved.data) as { segments: { name: string; mtime: number }[] };
        for (const segment of index.segments) {
            segment.mtime = fs.statSync(path.join(directory, segment.name)).mtimeMs;
        }
        saved.data = JSON.stringify(index);
        saved.hash = createHash('sha256').update(saved.data).digest('hex');
        fs.writeFileSync(file, JSON.stringify(saved));
        journal = new SessionJournal(directory, 'generation');
        try {
            const ids = ['__proto__', 'constructor', 'toString'];
            for (const id of ids) {
                const record = journal.accept({ id, code: id }).record;
                journal.append('accepted', { record }, id);
                journal.append('stream', { text: id }, id);
            }
            const recent = journal.recent(3);
            assert.deepStrictEqual(
                recent.executions.map((record) => record.id),
                ids,
            );
            assert.deepStrictEqual(
                recent.events
                    .filter((event) => event.type === 'stream')
                    .map((event) => event.data.text),
                ids,
            );
        } finally {
            journal.close();
        }
    });

    test('reads legacy archived records and output asynchronously without repairing files', async () => {
        const directory = path.join(root, 'generation');
        const journal = new SessionJournal(directory, 'generation');
        for (const id of ['old', 'latest']) {
            const record = journal.accept({ id, code: 'print("' + id + '")' }).record;
            journal.append('accepted', { record }, id);
            journal.append('stream', { text: id }, id);
        }
        journal.close();
        fs.rmSync(path.join(directory, 'executions-index.json'));
        fs.rmSync(path.join(directory, 'events-index.json'));
        const file = path.join(directory, 'events-000000.jsonl');
        fs.appendFileSync(file, '{"torn":');
        const before = fs.readFileSync(file);
        const stub = sinon
            .stub(fs, 'readFileSync')
            .throws(new Error('Archive disk reads must be asynchronous'));
        try {
            const snapshot = await readPreviousJournalAsync(root, 'generation', 1);
            assert.deepStrictEqual(
                snapshot.executions.map((record) => record.id),
                ['latest'],
            );
            assert.deepStrictEqual(
                snapshot.events.map((event) => event.type),
                ['accepted', 'stream'],
            );
            assert.strictEqual(snapshot.seq, 4);
        } finally {
            stub.restore();
        }
        assert.deepStrictEqual(fs.readFileSync(file), before);
    });

    test('checks authoritative events before trusting a manipulated cold asset index', () => {
        const storage = path.join(root, 'original'),
            copy = path.join(root, 'copied');
        const journal = new SessionJournal(path.join(storage, 'generation'), 'generation');
        journal.append('display', { displayId: 'plot', svg: 'kept.svg' }, 'cell');
        journal.close();
        fs.cpSync(storage, copy, { recursive: true });
        const file = path.join(copy, 'generation', 'events-index.json');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { data: string; hash: string };
        const index = JSON.parse(saved.data) as {
            segments: { name: string; mtime: number; displays: object }[];
        };
        for (const segment of index.segments) {
            segment.mtime = fs.statSync(path.join(copy, 'generation', segment.name)).mtimeMs;
            segment.displays = {};
        }
        saved.data = JSON.stringify(index);
        saved.hash = createHash('sha256').update(saved.data).digest('hex');
        fs.writeFileSync(file, JSON.stringify(saved));
        // Read-only restoration may use the checksum-valid offset index. Collection
        // must still verify its display references against the source at least once.
        getJournalIndex(path.join(copy, 'generation'), 'generation');
        assert.deepStrictEqual(retainedAssetIds(copy), new Set(['kept.svg']));
        fs.appendFileSync(path.join(copy, 'generation', 'events-000000.jsonl'), '{invalid}\n');
        assert.throws(() => retainedAssetIds(copy));
    });

    test('recognizes new durable admissions even when a directory timestamp is unchanged', async () => {
        const directory = path.join(root, 'generation'),
            folder = path.join(directory, 'executions');
        let journal = new SessionJournal(directory, 'generation');
        const first = journal.accept({ id: 'old', code: 'old()' }).record;
        const timestamp = new Date(1700000000000);
        fs.utimesSync(folder, timestamp, timestamp);
        journal.close();
        const saved = JSON.parse(
            fs.readFileSync(path.join(directory, 'executions-index.json'), 'utf8'),
        ) as { mtime: number };
        const added = {
            ...first,
            id: 'added',
            code: 'new()',
            hash: createHash('sha256').update('new()').digest('hex'),
            order: first.order + 1,
        };
        atomicJson(path.join(folder, 'added.json'), added);
        fs.utimesSync(folder, timestamp, timestamp);
        assert.strictEqual(
            fs.statSync(folder).mtimeMs,
            saved.mtime,
            'Simulate a coarse unchanged directory timestamp',
        );
        const snapshot = await readPreviousJournalAsync(root, 'generation', 1);
        assert.deepStrictEqual(
            snapshot.executions.map((record) => record.id),
            ['added'],
        );
        journal = new SessionJournal(directory, 'generation');
        try {
            assert.strictEqual(journal.accept({ id: added.id, code: added.code }).duplicate, true);
            assert.throws(
                () => journal.accept({ id: added.id, code: 'different()' }),
                /different code/,
            );
            assert.strictEqual(
                journal.accept({ id: 'next', code: 'next()' }).record.order,
                added.order + 1,
            );
        } finally {
            journal.close();
        }
    });

    test('keeps deduplication after source-code working-set eviction', () => {
        const journal = new SessionJournal(path.join(root, 'generation'), 'generation');
        try {
            for (let i = 0; i < 8; i++) {
                journal.accept({ id: 'id' + i, code: 'x'.repeat(1024 * 1024) });
            }
            assert.strictEqual(journal.executions.size, 8);
            const cache = journal.executions as unknown as { cacheBytes: number };
            assert.ok(cache.cacheBytes <= 4 * 1024 * 1024);
            assert.strictEqual(
                journal.accept({ id: 'id0', code: 'x'.repeat(1024 * 1024) }).duplicate,
                true,
            );
            assert.throws(
                () => journal.accept({ id: 'id0', code: 'different()' }),
                /different code/,
            );
            assert.ok(journal.executions.history('', Number.MAX_SAFE_INTEGER).more);
        } finally {
            journal.close();
        }
    });
});
