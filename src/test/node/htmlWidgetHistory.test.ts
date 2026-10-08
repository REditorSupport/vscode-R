import * as assert from 'assert';
import * as sinon from 'sinon';
import type { Memento } from 'vscode';
import { SessionProcessMonitor } from '../../sessionProcessMonitor';
import { createViewerSessionContext, ViewerSessionSource } from '../../viewerSession';
import { WidgetHistory, WidgetHistoryStore, widgetHistoryKey } from '../../webViewer/history';

suite('Retained HTML widget history', () => {
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;
    let kill: sinon.SinonStub;
    let state: Memento;
    let persisted: unknown;
    const stores: WidgetHistoryStore[] = [];
    const source = (sessionId = 'history-source', host = 'local'): ViewerSessionSource => ({
        sessionId, host, pid: '12345', rVer: '4.6.1', processExited: false,
    });
    const record = (owner = source()): WidgetHistory => ({
        source: owner, history: [{ file: '/tmp/a.html', title: 'A' }, { file: '/tmp/b.html', title: 'B' }],
        index: 0, viewColumn: 2,
    });
    const create = () => {
        const monitor = new SessionProcessMonitor<ViewerSessionSource>(host => host === 'local');
        const store = new WidgetHistoryStore(state, owner => createViewerSessionContext(owner, monitor));
        stores.push(store);
        return { store, monitor };
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers();
        kill = sandbox.stub(process, 'kill').returns(true);
        persisted = undefined;
        state = {
            keys: () => persisted ? [widgetHistoryKey] : [],
            get: <T>(_key: string, fallback?: T) => persisted === undefined ? fallback : JSON.parse(JSON.stringify(persisted)) as T,
            update: (key, value) => {
                assert.strictEqual(key, widgetHistoryKey);
                persisted = JSON.parse(JSON.stringify(value));
                return Promise.resolve();
            },
        } as Memento;
    });

    teardown(async () => {
        await Promise.all(stores.map(store => store.flush()));
        stores.splice(0).forEach(store => store.dispose());
        sandbox.restore();
    });

    test('fresh storage restores paths, selection, process ownership, and editor group', async () => {
        persisted = [record()];
        const first = create();
        await first.store.flush();
        first.store.dispose();
        assert.strictEqual(clock.countTimers(), 0);
        const second = create();
        assert.deepStrictEqual(second.store.entries.get('history-source'), record());
        assert.strictEqual(clock.countTimers(), 1);
        await second.store.flush();
        assert.deepStrictEqual(persisted, [record()]);
    });

    test('a process exit clears persisted history even without an open Viewer or attached transport', async () => {
        persisted = [record()];
        const { store } = create();
        kill.throws(Object.assign(new Error('exited'), { code: 'ESRCH' }));
        clock.tick(1000);
        await store.flush();
        assert.strictEqual(store.entries.size, 0);
        assert.deepStrictEqual(persisted, []);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('remote detachment and permission errors preserve history until a confirmed exit', async () => {
        const remote = source('remote', 'foreign');
        persisted = [record(), record(remote)];
        const { store, monitor } = create();
        kill.throws(Object.assign(new Error('permission denied'), { code: 'EPERM' }));
        clock.tick(2000);
        assert.strictEqual(store.entries.size, 2);
        monitor.markExited({ ...remote, processExited: true });
        await store.flush();
        assert.deepStrictEqual(persisted, [record()]);
    });

    test('rejects invalid persisted state, trims excess history, and adjusts its selection', async () => {
        const long = record();
        long.history = Array.from({ length: 52 }, (_, index) => ({ file: `/tmp/${index}.html`, title: String(index) }));
        long.index = 51;
        persisted = [null, { source: {} }, { ...record(source('bad-index')), index: -1 },
            record({ ...source('already-exited'), processExited: true }), long];
        const { store } = create();
        await store.flush();
        assert.strictEqual(store.entries.size, 1);
        const retained = store.entries.get('history-source')!;
        assert.strictEqual(retained.history.length, 50);
        assert.strictEqual(retained.history[0].title, '2');
        assert.strictEqual(retained.index, 49);
        assert.deepStrictEqual(persisted, [retained]);
    });

    test('queued writes capture their revision and an exit wins over pending output saves', async () => {
        const writes: unknown[] = [];
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        sandbox.stub(state, 'update').callsFake(async (_key, value) => {
            writes.push(JSON.parse(JSON.stringify(value)));
            if (writes.length === 1) { await blocked; }
            persisted = value;
        });
        const { store, monitor } = create();
        const owner = source();
        const history = store.remember(createViewerSessionContext(owner, monitor));
        history.history.push({ file: '/tmp/a.html', title: 'A' }); history.index = 0;
        void store.save(history);
        history.history.push({ file: '/tmp/b.html', title: 'B' }); history.index = 1;
        void store.save(history);
        monitor.markExited({ ...owner, processExited: true });
        release();
        await store.flush();
        assert.deepStrictEqual(writes.map(value => (value as WidgetHistory[])[0]?.history.length ?? 0), [1, 2, 0]);
        assert.deepStrictEqual(persisted, []);
    });
});
