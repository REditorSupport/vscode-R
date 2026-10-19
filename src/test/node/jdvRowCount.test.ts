import * as assert from 'node:assert/strict';
import { JdvRowCountHints } from '../../jdvRowCount';

suite('jdv row-count hints', () => {
    test('applies a hint received before view/open', () => {
        const hints = new JdvRowCountHints();
        hints.hint('session-a', 'view-1', 3, 42);
        const applied: number[] = [];

        assert.equal(hints.open('session-a', 'view-1', 3, nrow => applied.push(nrow)), 42);
        hints.hint('session-a', 'view-1', 3, 43);
        assert.deepEqual(applied, [43]);
    });

    test('applies a hint received after view/open', () => {
        const hints = new JdvRowCountHints();
        const applied: number[] = [];

        assert.equal(hints.open('session-a', 'view-1', 1, nrow => applied.push(nrow)), undefined);
        hints.hint('session-a', 'view-1', 1, 9);
        assert.deepEqual(applied, [9]);
        assert.equal(hints.open('session-a', 'view-1', 1, nrow => applied.push(nrow)), 9);
    });

    test('replaces the active generation and ignores stale hints and closes', () => {
        const hints = new JdvRowCountHints();
        const oldGeneration: number[] = [];
        const newGeneration: number[] = [];

        hints.open('session-a', 'view-1', 1, nrow => oldGeneration.push(nrow));
        hints.open('session-a', 'view-1', 2, nrow => newGeneration.push(nrow));
        hints.hint('session-a', 'view-1', 1, 100);
        hints.close('session-a', 'view-1', 1);
        hints.hint('session-a', 'view-1', 2, 200);

        assert.deepEqual(oldGeneration, []);
        assert.deepEqual(newGeneration, [200]);
    });

    test('closing an older active generation releases its callback while retaining newer pending data', () => {
        const hints = new JdvRowCountHints();
        const applied: number[] = [];
        hints.open('session-a', 'view-1', 1, nrow => applied.push(nrow));
        hints.hint('session-a', 'view-1', 2, 20);
        hints.close('session-a', 'view-1', 1);
        hints.hint('session-a', 'view-1', 1, 10);

        assert.equal(applied.length, 0);
        assert.equal(hints.open('session-a', 'view-1', 2, nrow => applied.push(nrow)), 20);
    });

    test('a close tombstone blocks same-generation delayed open and hints', () => {
        const hints = new JdvRowCountHints();
        const applied: number[] = [];

        hints.close('session-a', 'view-1', 7);
        hints.hint('session-a', 'view-1', 7, 70);
        assert.equal(hints.open('session-a', 'view-1', 7, nrow => applied.push(nrow)), undefined);
        hints.hint('session-a', 'view-1', 7, 71);
        assert.equal(applied.length, 0);

        hints.hint('session-a', 'view-1', 8, 80);
        assert.equal(hints.open('session-a', 'view-1', 8, nrow => applied.push(nrow)), 80);
    });

    test('isolates scopes even when view and generation match', () => {
        const hints = new JdvRowCountHints();
        hints.hint('session-a/socket-a', 'view-1', 1, 11);
        hints.hint('session-b/socket-b', 'view-1', 1, 22);
        hints.clear('session-a/socket-a');

        assert.equal(hints.open('session-a/socket-a', 'view-1', 1, () => undefined), undefined);
        assert.equal(hints.open('session-b/socket-b', 'view-1', 1, () => undefined), 22);
    });

    test('bounds pending hints and preserves live subscriptions', () => {
        const hints = new JdvRowCountHints(2, 8);
        const applied: number[] = [];
        hints.open('session-a', 'live', 1, nrow => applied.push(nrow));
        hints.hint('session-a', 'one', 1, 1);
        hints.hint('session-a', 'two', 1, 2);
        hints.hint('session-a', 'three', 1, 3);

        assert.equal(hints.open('session-a', 'one', 1, () => undefined), undefined);
        assert.equal(hints.open('session-a', 'two', 1, () => undefined), 2);
        assert.equal(hints.open('session-a', 'three', 1, () => undefined), 3);
        hints.hint('session-a', 'live', 1, 99);
        assert.deepEqual(applied, [99]);
    });

    test('bounds inactive metadata without evicting open panel callbacks', () => {
        const hints = new JdvRowCountHints(4, 1);
        const applied: number[] = [];
        hints.open('session-a', 'live', 1, nrow => applied.push(nrow));
        hints.hint('session-a', 'other', 1, 2);
        hints.hint('session-a', 'another', 1, 3);
        hints.hint('session-a', 'live', 1, 10);

        assert.deepEqual(applied, [10]);
    });
});
