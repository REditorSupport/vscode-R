import * as assert from 'assert';
import { OutputQueue } from '../../interactive/outputQueue';

suite('Interactive output queue', () => {
    test('coalesces updates received during a slow write and retains other cells', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const seen: string[] = [];
        let frame = 1;
        const queue = new OutputQueue(
            async (id) => {
                seen.push(`${id}:${frame}`);
                if (seen.length === 1) {
                    await blocked;
                }
            },
            (error) => {
                throw error;
            },
        );
        queue.schedule('plot', true);
        await Promise.resolve();
        for (frame = 2; frame <= 8; frame++) {
            queue.schedule('plot');
        }
        frame = 8;
        queue.schedule('console');
        assert.deepStrictEqual(seen, ['plot:1'], 'Only one output write may be in flight');
        release();
        await queue.flush();
        assert.deepStrictEqual(seen, ['plot:1', 'plot:8', 'console:8']);
        queue.dispose();
    });

    test('one failed output does not prevent the final update or another cell', async () => {
        const errors: unknown[] = [],
            seen: string[] = [];
        let attempts = 0;
        const queue = new OutputQueue(
            (id) => {
                if (!attempts++) {
                    queue.schedule(id);
                    return Promise.reject(new Error('Output transfer failed'));
                }
                seen.push(id);
                return Promise.resolve();
            },
            (error) => errors.push(error),
        );
        queue.schedule('plot');
        queue.schedule('console');
        await queue.flush();
        assert.strictEqual(errors.length, 1);
        assert.deepStrictEqual(seen, ['console', 'plot']);
        queue.dispose();
    });

    test('pauses after the current write so restoration does not wait for a streaming session to become idle', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const seen: string[] = [];
        const queue = new OutputQueue(
            async (id) => {
                seen.push(id);
                await blocked;
            },
            (error) => {
                throw error;
            },
        );
        queue.schedule('old', true);
        await Promise.resolve();
        const paused = queue.pause();
        queue.schedule('pending', true);
        release();
        await paused;
        assert.deepStrictEqual(seen, ['old']);
        queue.resume();
        await queue.flush();
        assert.deepStrictEqual(seen, ['old', 'pending']);
        queue.dispose();
    });

    test('disposing during a write discards pending output and ignores new work', async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const seen: string[] = [];
        const queue = new OutputQueue(
            async (id) => {
                seen.push(id);
                await blocked;
            },
            (error) => {
                throw error;
            },
        );
        queue.schedule('old', true);
        await Promise.resolve();
        queue.schedule('pending');
        queue.dispose();
        queue.schedule('new');
        release();
        await queue.flush();
        assert.deepStrictEqual(seen, ['old']);
    });
});
