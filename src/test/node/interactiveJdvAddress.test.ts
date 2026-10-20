import * as assert from 'assert';
import {
    acquireInteractiveJdvAddress,
    disposeInteractiveJdvHostOnControlLoss,
} from '../../interactive/jdvAddress';
import { disposeJdvHostIfCurrentAddress } from '../../jdvHostLifecycle';

suite('Interactive jdv address', () => {
    test('returns a listener address scoped to the captured session and generation', async () => {
        const address = await acquireInteractiveJdvAddress({
            sessionId: 'session:g1',
            hostKey: 'interactive:session:g1',
            canConnect: () => true,
            isCurrent: () => true,
            getAddress: (sessionId, hostKey) => {
                assert.strictEqual(sessionId, 'session:g1');
                assert.strictEqual(hostKey, 'interactive:session:g1');
                return Promise.resolve('/tmp/jdv.sock');
            },
            disposeHost: () => assert.fail('A current session must keep its listener'),
        });
        assert.strictEqual(address, '/tmp/jdv.sock');
    });

    test('refuses observers without creating a listener', async () => {
        let created = false;
        await assert.rejects(
            acquireInteractiveJdvAddress({
                sessionId: 'session:g1',
                hostKey: 'interactive:session:g1',
                canConnect: () => false,
                isCurrent: () => true,
                getAddress: () => {
                    created = true;
                    return Promise.resolve('/tmp/jdv.sock');
                },
                disposeHost: () => assert.fail('No listener was created'),
            }),
            /controlling Interactive client/,
        );
        assert.strictEqual(created, false);
    });

    test('disposes an existing listener when control moves to another client', () => {
        let disposed = 0;
        assert.strictEqual(
            disposeInteractiveJdvHostOnControlLoss(true, false, () => {
                disposed++;
            }),
            true,
        );
        assert.strictEqual(disposed, 1);
        assert.strictEqual(
            disposeInteractiveJdvHostOnControlLoss(false, false, () => {
                disposed++;
            }),
            false,
        );
        assert.strictEqual(
            disposeInteractiveJdvHostOnControlLoss(true, true, () => {
                disposed++;
            }),
            false,
        );
        assert.strictEqual(disposed, 1);
    });

    test('closes a listener when a completed restart changes the captured generation', async () => {
        let resolveAddress!: (address: string) => void;
        const pending = new Promise<string>((resolve) => {
            resolveAddress = resolve;
        });
        let generation = 'g1';
        const disposed: string[] = [];
        const request = acquireInteractiveJdvAddress({
            sessionId: 'session:g1',
            hostKey: 'interactive:session:g1',
            canConnect: () => true,
            isCurrent: () => generation === 'g1',
            getAddress: () => pending,
            disposeHost: (hostKey) => {
                disposed.push(hostKey);
            },
        });
        // A restart may finish before the asynchronous listener creation resumes.
        generation = 'g2';
        resolveAddress('/tmp/old-jdv.sock');
        await assert.rejects(request, /session changed/);
        assert.deepStrictEqual(disposed, ['interactive:session:g1']);
    });

    test('does not dispose a reattached host when an old address acquisition finishes late', async () => {
        const hostKey = 'interactive:session:g1';
        let resolveAddress!: (address: string) => void;
        const pendingAddress = new Promise<string>((resolve) => {
            resolveAddress = resolve;
        });
        let oldHostDisposed = false;
        let newHostDisposed = false;
        const oldHostPromise = Promise.resolve({
            address: '/tmp/old.sock',
            dispose: () => {
                oldHostDisposed = true;
            },
        });
        const newHost = {
            address: '/tmp/new.sock',
            dispose: () => {
                newHostDisposed = true;
            },
        };
        const hosts = new Map<string, Promise<typeof newHost>>([[hostKey, oldHostPromise]]);
        const request = acquireInteractiveJdvAddress({
            sessionId: 'session:g1',
            hostKey,
            canConnect: () => true,
            isCurrent: () => false,
            getAddress: () => pendingAddress,
            disposeHost: (key, address) =>
                disposeJdvHostIfCurrentAddress(
                    hosts,
                    key,
                    address,
                    (host) => host.address,
                    (host) => host.dispose(),
                ).then(() => undefined),
        });
        // Detach removed the old host and a same-generation reattach installed a new one.
        hosts.delete(hostKey);
        hosts.set(hostKey, Promise.resolve(newHost));
        resolveAddress('/tmp/old.sock');
        await assert.rejects(request, /session changed/);
        assert.strictEqual(hosts.get(hostKey) !== undefined, true);
        assert.strictEqual((await hosts.get(hostKey))?.address, '/tmp/new.sock');
        assert.strictEqual(oldHostDisposed, false);
        assert.strictEqual(newHostDisposed, false);
    });

    test('closes a listener when detach wins while its address is being created', async () => {
        let resolveAddress!: (address: string) => void;
        const pending = new Promise<string>((resolve) => {
            resolveAddress = resolve;
        });
        let attached = true;
        let disposed = false;
        const request = acquireInteractiveJdvAddress({
            sessionId: 'session:g1',
            hostKey: 'interactive:session:g1',
            canConnect: () => true,
            isCurrent: () => attached,
            getAddress: () => pending,
            disposeHost: () => {
                disposed = true;
            },
        });
        attached = false;
        resolveAddress('/tmp/detached-jdv.sock');
        await assert.rejects(request, /session changed/);
        assert.strictEqual(disposed, true);
    });

    test('closes a listener if R exits while its address is being created', async () => {
        let resolveAddress!: (address: string) => void;
        const pending = new Promise<string>((resolve) => {
            resolveAddress = resolve;
        });
        let running = true;
        let disposed = false;
        const request = acquireInteractiveJdvAddress({
            sessionId: 'session:g1',
            hostKey: 'interactive:session:g1',
            canConnect: () => running,
            isCurrent: () => true,
            getAddress: () => pending,
            disposeHost: () => {
                disposed = true;
            },
        });
        running = false;
        resolveAddress('/tmp/stopped-jdv.sock');
        await assert.rejects(request, /session changed/);
        assert.strictEqual(disposed, true);
    });
});
