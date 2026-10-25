import * as assert from 'assert';
import { WorkspaceRefreshScheduler } from '../../workspaceRefresh';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Workspace refresh scheduling', () => {
    test('coalesces invalidations during an inspection and publishes only the newest metadata', async () => {
        const first = deferred<number>();
        let calls = 0;
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler(
            () => (++calls === 1 ? first.promise : Promise.resolve(2)),
            (value) => published.push(value),
            () => true,
        );
        const running = scheduler.ensure();
        await Promise.resolve();
        for (let i = 0; i < 20; i++) {
            scheduler.invalidate();
            assert.strictEqual(scheduler.ensure(), running);
        }
        assert.strictEqual(calls, 1);
        first.resolve(1);
        await running;
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(published, [2]);
        await scheduler.ensure();
        assert.strictEqual(calls, 2);
        scheduler.dispose();
    });

    test('retains dirty metadata without demand and drops a reply after the owner becomes unavailable', async () => {
        let available = false;
        let calls = 0;
        const first = deferred<number>();
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler(
            () => (++calls === 1 ? first.promise : Promise.resolve(2)),
            (value) => published.push(value),
            () => available,
        );
        scheduler.invalidate(0);
        await scheduler.ensure();
        assert.strictEqual(calls, 0);
        available = true;
        const running = scheduler.ensure();
        await Promise.resolve();
        available = false;
        first.resolve(1);
        await running;
        assert.deepStrictEqual(published, []);
        available = true;
        await scheduler.ensure();
        assert.deepStrictEqual(published, [2]);
        scheduler.dispose();
    });

    test('disposal suppresses replies from an obsolete connection', async () => {
        const result = deferred<number>();
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler(
            () => result.promise,
            (value) => published.push(value),
            () => true,
        );
        const running = scheduler.ensure();
        await Promise.resolve();
        scheduler.dispose();
        result.resolve(1);
        await running;
        scheduler.invalidate(0);
        await scheduler.ensure();
        assert.deepStrictEqual(published, []);
    });

    test('coalesces successful unchanged reads and suppresses invalidated child notifications', async () => {
        const cached = { version: 1 };
        const first = deferred<typeof cached>();
        let reads = 0;
        let invalidations = 0;
        const scheduler = new WorkspaceRefreshScheduler<typeof cached>(
            () => (++reads === 1 ? first.promise : Promise.resolve(cached)),
            (value) => {
                assert.strictEqual(value, cached);
                invalidations++;
            },
            () => true,
        );
        const running = scheduler.ensure();
        await Promise.resolve();
        for (let i = 0; i < 20; i++) {
            scheduler.invalidate();
        }
        first.resolve(cached);
        await running;
        assert.strictEqual(reads, 2);
        assert.strictEqual(invalidations, 1);
        scheduler.dispose();
    });

    test('deferred sends keep invalidation and inspection failures do not spin', async () => {
        let calls = 0;
        const errors: unknown[] = [];
        const scheduler = new WorkspaceRefreshScheduler(
            () => {
                calls++;
                return Promise.reject(new Error('R busy'));
            },
            () => assert.fail('A failed inspection must preserve the previous workspace'),
            () => true,
            (error) => errors.push(error),
        );
        scheduler.invalidate(1000);
        scheduler.defer();
        await scheduler.ensure();
        await scheduler.ensure();
        assert.strictEqual(calls, 1);
        assert.strictEqual(errors.length, 1);
        scheduler.invalidate();
        await scheduler.ensure();
        assert.strictEqual(calls, 2);
        scheduler.dispose();
    });
});
