import * as assert from 'assert';
import * as sinon from 'sinon';
import { TestResources } from '../common/testResources';

suite('Test resource cleanup', () => {
    test('aggregates sync and async failures, retains the original failure and continues in order', async () => {
        const resources = new TestResources(['stop', 'remove']);
        const original = new Error('setup failed');
        const sync = new Error('sync stop failed');
        const asyncError = new Error('async stop failed');
        const calls: string[] = [];
        resources.add('stop', 'sync resource', () => {
            calls.push('sync');
            throw sync;
        });
        resources.add('stop', 'async resource', () => Promise.reject(asyncError));
        resources.add('stop', 'discover healthy resource', () => {
            resources.add('stop', 'healthy resource', () => {
                calls.push('healthy');
            });
        });
        resources.add('remove', 'directory', () => {
            calls.push('remove');
        });
        await assert.rejects(resources.dispose([original]), (error: unknown) => {
            assert.ok(error instanceof AggregateError);
            assert.strictEqual(error.errors[0], original);
            assert.match(error.message, /Cleanup \[stop\] sync resource: sync stop failed/);
            const failures = error.errors.slice(1) as Error[];
            assert.deepStrictEqual(
                failures.map((failure) => failure.cause),
                [sync, asyncError],
            );
            assert.deepStrictEqual(
                failures.map((failure) => failure.message),
                ['Cleanup [stop] sync resource', 'Cleanup [stop] async resource'],
            );
            return true;
        });
        assert.deepStrictEqual(calls, ['sync', 'healthy', 'remove']);
    });

    test('bounds a stuck release and still attempts the next phase', async () => {
        const clock = sinon.useFakeTimers();
        try {
            const resources = new TestResources(['stop', 'remove'], 10, 20);
            let removed = false;
            resources.add('stop', 'stuck resource', () => new Promise(() => undefined));
            resources.add('remove', 'directory', () => {
                removed = true;
            });
            const result = assert.rejects(resources.dispose(), (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.match((error.errors[0] as Error).message, /\[stop\] stuck resource/);
                return true;
            });
            await clock.tickAsync(10);
            await result;
            assert.ok(removed);
        } finally {
            clock.restore();
        }
    });
});
