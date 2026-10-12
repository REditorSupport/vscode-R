import * as assert from 'assert';
import { NativeTerminalPidWaitRegistry } from '../../nativeTerminalPidWait';

interface Terminal { id: string }

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function trackedSignal() {
    let listener: (() => void) | undefined;
    let removals = 0;
    const signal = {
        aborted: false,
        addEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => {
            listener = typeof callback === 'function' ? () => callback(new Event('abort')) : () => callback.handleEvent(new Event('abort'));
        },
        removeEventListener: () => { removals++; listener = undefined; },
    } as unknown as AbortSignal;
    return {
        signal,
        get removals() { return removals; },
        abort() {
            (signal as { aborted: boolean }).aborted = true;
            listener?.();
        },
    };
}

suite('Native terminal PID wait registry', () => {
    let registry: NativeTerminalPidWaitRegistry<Terminal>;
    let first: Terminal;
    let second: Terminal;

    setup(() => {
        registry = new NativeTerminalPidWaitRegistry<Terminal>();
        first = { id: 'first' };
        second = { id: 'second' };
    });

    test('undefined is a successful PID read, distinct from invalidation', async () => {
        const result = await registry.waitFor(first, () => undefined);
        assert.deepStrictEqual(result.kind, 'resolved');
        if (result.kind === 'resolved') {
            assert.strictEqual(result.value, undefined);
            assert.strictEqual(result.isCurrent(), true);
        }
    });

    test('resolved snapshots become stale after terminal or lifecycle invalidation', async () => {
        const terminalRead = await registry.waitFor(first, () => 48);
        assert.strictEqual(terminalRead.kind, 'resolved');
        if (terminalRead.kind === 'resolved') {
            assert.strictEqual(terminalRead.isCurrent(), true);
            registry.invalidate(first);
            assert.strictEqual(terminalRead.isCurrent(), false);
        }
        const freshTerminalRead = await registry.waitFor(first, () => 49);
        assert.strictEqual(freshTerminalRead.kind, 'resolved');
        if (freshTerminalRead.kind === 'resolved') {
            assert.strictEqual(freshTerminalRead.isCurrent(), true);
            if (terminalRead.kind === 'resolved') { assert.strictEqual(terminalRead.isCurrent(), false); }
        }

        const lifecycleRead = await registry.waitFor(second, () => 50);
        assert.strictEqual(lifecycleRead.kind, 'resolved');
        registry.invalidateAll();
        if (lifecycleRead.kind === 'resolved') { assert.strictEqual(lifecycleRead.isCurrent(), false); }
        const freshLifecycleRead = await registry.waitFor(second, () => 51);
        assert.strictEqual(freshLifecycleRead.kind, 'resolved');
        if (freshLifecycleRead.kind === 'resolved') { assert.strictEqual(freshLifecycleRead.isCurrent(), true); }
    });

    test('registration during the processId getter permanently invalidates that read', async () => {
        const pending = deferred<number | undefined>();
        const resultPromise = registry.waitFor(first, () => {
            registry.invalidate(first);
            return pending.promise;
        });
        const result = await resultPromise;
        assert.deepStrictEqual(result, { kind: 'invalidated', reason: 'terminal' });
        pending.resolve(42);
        await new Promise<void>(resolve => setImmediate(resolve));

        const fresh = await registry.waitFor(first, () => undefined);
        assert.strictEqual(fresh.kind, 'resolved', 'disposing registration cannot revive an old operation, but a fresh read can run');
    });

    test('a late rejection after invalidation is observed without unhandled rejection', async () => {
        const pending = deferred<number | undefined>();
        const resultPromise = registry.waitFor(first, () => pending.promise);
        registry.invalidate(first);
        assert.deepStrictEqual(await resultPromise, { kind: 'invalidated', reason: 'terminal' });
        pending.reject(new Error('late processId failure'));
        await new Promise<void>(resolve => setImmediate(resolve));
    });

    test('lifecycle invalidation affects old waits but not a fresh lifecycle read', async () => {
        const oldPending = deferred<number | undefined>();
        const oldWait = registry.waitFor(first, () => oldPending.promise);
        registry.invalidateAll();
        assert.deepStrictEqual(await oldWait, { kind: 'invalidated', reason: 'lifecycle' });
        const freshWait = await registry.waitFor(first, () => 43);
        assert.deepStrictEqual(freshWait.kind, 'resolved');
        if (freshWait.kind === 'resolved') { assert.strictEqual(freshWait.value, 43); }
    });

    test('terminal invalidation is scoped to its terminal', async () => {
        const otherPending = deferred<number | undefined>();
        const firstPending = deferred<number | undefined>();
        const otherWait = registry.waitFor(second, () => otherPending.promise);
        const firstWait = registry.waitFor(first, () => firstPending.promise);
        registry.invalidate(first);
        assert.deepStrictEqual(await firstWait, { kind: 'invalidated', reason: 'terminal' });
        otherPending.resolve(44);
        const otherResult = await otherWait;
        assert.strictEqual(otherResult.kind, 'resolved');
        if (otherResult.kind === 'resolved') { assert.strictEqual(otherResult.value, 44); }
    });

    test('AbortSignal invalidation cleans up its listener', async () => {
        const pending = deferred<number | undefined>();
        const tracked = trackedSignal();
        const wait = registry.waitFor(first, () => pending.promise, { signal: tracked.signal });
        tracked.abort();
        assert.deepStrictEqual(await wait, { kind: 'invalidated', reason: 'operation' });
        assert.strictEqual(tracked.removals, 1);
        pending.resolve(45);
    });

    test('normal completion and read or eligibility errors clean up AbortSignal listeners', async () => {
        const completedSignal = trackedSignal();
        const complete = await registry.waitFor(first, () => 46, { signal: completedSignal.signal });
        assert.strictEqual(complete.kind, 'resolved');
        assert.strictEqual(completedSignal.removals, 1);

        const readSignal = trackedSignal();
        await assert.rejects(registry.waitFor(first, () => { throw new Error('read failed'); }, { signal: readSignal.signal }), /read failed/);
        assert.strictEqual(readSignal.removals, 1);

        const eligibilitySignal = trackedSignal();
        await assert.rejects(registry.waitFor(first, () => 47, {
            signal: eligibilitySignal.signal, isEligible: () => { throw new Error('eligibility failed'); },
        }), /eligibility failed/);
        assert.strictEqual(eligibilitySignal.removals, 1);
    });

    test('eligibility failure after the PID read starts rejects and removes its listener', async () => {
        const pending = deferred<number | undefined>();
        const tracked = trackedSignal();
        let eligibilityFailure = false;
        const wait = registry.waitFor(first, () => pending.promise, {
            signal: tracked.signal,
            isEligible: () => {
                if (eligibilityFailure) { throw new Error('terminal eligibility changed'); }
                return true;
            },
        });
        eligibilityFailure = true;
        pending.resolve(52);
        await assert.rejects(wait, /terminal eligibility changed/);
        assert.strictEqual(tracked.removals, 1);
    });
});
