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

    test('deferred sends retain failed reads for the next explicit demand without spinning', async () => {
        let calls = 0;
        const errors: unknown[] = [];
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () => {
                calls++;
                return calls === 1 ? Promise.reject(new Error('R busy')) : Promise.resolve(2);
            },
            (value) => published.push(value),
            () => true,
            (error) => errors.push(error),
        );
        scheduler.invalidate(1000);
        scheduler.defer();
        await scheduler.ensure();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(calls, 1);
        assert.strictEqual(errors.length, 1);
        assert.deepStrictEqual(published, []);
        await scheduler.ensure();
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(published, [2]);
        await scheduler.ensure();
        assert.strictEqual(calls, 2, 'A successful refresh clears the pending demand');
        scheduler.dispose();
    });

    test('an undefined read stays pending without an automatic retry', async () => {
        let calls = 0;
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () => Promise.resolve(++calls === 1 ? undefined : 2),
            (value) => published.push(value),
            () => true,
        );
        await scheduler.ensure();
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(published, []);
        await scheduler.ensure();
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(published, [2]);
        scheduler.dispose();
    });

    test('invalidations during a failed read remain coalesced until the next demand', async () => {
        const first = deferred<number | undefined>();
        let calls = 0;
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
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
        first.resolve(undefined);
        await running;
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(published, []);
        await scheduler.ensure();
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(published, [2]);
        scheduler.dispose();
    });

    test('configured retries recover a failed read without demand, a bounded number of times', async () => {
        let calls = 0;
        let failures = 3;
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () => {
                calls++;
                return failures-- > 0
                    ? Promise.reject(new Error('timeout'))
                    : Promise.resolve(calls);
            },
            (value) => published.push(value),
            () => true,
            undefined,
            { retryDelaysMs: [1, 1] },
        );
        await scheduler.ensure();
        const deadline = Date.now() + 1000;
        while (calls < 3 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(calls, 3, 'One read and two retries, then it waits for demand');
        assert.deepStrictEqual(published, []);
        await scheduler.ensure();
        assert.deepStrictEqual(published, [4]);
        scheduler.dispose();
    });

    test('a successful retry and a new invalidation each restore the retries', async () => {
        let calls = 0;
        const fails = new Set([1, 3, 4]);
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () =>
                fails.has(++calls) ? Promise.reject(new Error('timeout')) : Promise.resolve(calls),
            (value) => published.push(value),
            () => true,
            undefined,
            { retryDelaysMs: [1] },
        );
        await scheduler.ensure();
        const wait = async (predicate: () => boolean) => {
            const deadline = Date.now() + 1000;
            while (!predicate() && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };
        await wait(() => published.length === 1);
        assert.deepStrictEqual(published, [2]);
        scheduler.invalidate();
        await scheduler.ensure();
        await wait(() => calls === 4);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(calls, 4, 'The invalidation allowed one retry again');
        assert.deepStrictEqual(published, [2]);
        scheduler.dispose();
    });

    test('disposal and deferral cancel a scheduled retry', async () => {
        for (const cancel of ['dispose', 'defer'] as const) {
            let calls = 0;
            const scheduler = new WorkspaceRefreshScheduler<number>(
                () => {
                    calls++;
                    return Promise.reject(new Error('timeout'));
                },
                () => {},
                () => true,
                undefined,
                { retryDelaysMs: [10] },
            );
            await scheduler.ensure();
            scheduler[cancel]();
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.strictEqual(calls, 1, cancel);
            scheduler.dispose();
        }
    });

    test('a retry that cannot read when it is due does not use up the retries', async () => {
        let available = true;
        let calls = 0;
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () => {
                calls++;
                return Promise.reject(new Error('timeout'));
            },
            () => {},
            () => available,
            undefined,
            { retryDelaysMs: [1] },
        );
        await scheduler.ensure();
        available = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(calls, 1);
        available = true;
        await scheduler.ensure();
        const deadline = Date.now() + 1000;
        while (calls < 3 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(calls, 3, 'The skipped retry is still available');
        scheduler.dispose();
    });

    test('a read scheduled during a failed read keeps its delay instead of waiting for a retry', async () => {
        let fail!: (error: Error) => void;
        let calls = 0;
        const published: number[] = [];
        const scheduler = new WorkspaceRefreshScheduler<number>(
            () =>
                ++calls === 1
                    ? new Promise<number>((_resolve, reject) => {
                          fail = reject;
                      })
                    : Promise.resolve(2),
            (value) => published.push(value),
            () => true,
            undefined,
            { retryDelaysMs: [5000] },
        );
        const running = scheduler.ensure();
        await Promise.resolve();
        scheduler.invalidate(5);
        fail(new Error('timeout'));
        await running;
        const deadline = Date.now() + 1000;
        while (!published.length && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepStrictEqual(published, [2]);
        scheduler.dispose();
    });
});
