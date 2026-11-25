import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import { TerminalStartupMonitor } from '../../terminalStartupMonitor';
import type { TerminalStartupRecord } from '../../terminalStartup';

suite('Terminal startup monitor', () => {
    const name = 'a'.repeat(32) + '.json.startup';
    let directory: string;
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;
    let open: sinon.SinonStub;
    let monitor: TerminalStartupMonitor;
    let received: { attempt: string; live: boolean }[];
    let reads: number;
    let revision: number;
    let hooks: {
        watcher: EventEmitter;
        change: (name: string | null) => void;
        close: sinon.SinonSpy;
    }[];

    async function publish(attempt: string, status: TerminalStartupRecord['status'] = 'failed') {
        const file = path.join(directory, name);
        const data: TerminalStartupRecord = {
            attemptId: attempt,
            token: 't',
            pid: 123,
            endpoint: 'saved',
            status,
        };
        await fs.promises.writeFile(file + '.tmp', JSON.stringify(data));
        await fs.promises.rename(file + '.tmp', file);
        // Make the directory timestamp distinct even on a coarse test filesystem.
        await fs.promises.utimes(directory, ++revision, revision);
    }

    async function until(condition: () => boolean) {
        const deadline = Date.now() + 5000;
        while (!condition()) {
            assert.ok(Date.now() < deadline, 'monitor did not finish the requested operation');
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }

    setup(async () => {
        directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vscode-r-startup-'));
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        hooks = [];
        open = sandbox.stub(fs, 'watch').callsFake(((
            _dir: string,
            _options: object,
            notify: (event: string, name: string | null) => void,
        ) => {
            const watcher = new EventEmitter();
            const close = sinon.spy(() => watcher.emit('close'));
            hooks.push({ watcher, close, change: (name) => notify('rename', name) });
            return Object.assign(watcher, { close });
        }) as unknown as typeof fs.watch);
        received = [];
        reads = 0;
        revision = 100;
        monitor = new TerminalStartupMonitor(
            directory,
            async (file) => {
                reads++;
                return JSON.parse(
                    await fs.promises.readFile(file, 'utf8'),
                ) as TerminalStartupRecord;
            },
            (_file, record, live) => {
                received.push({ attempt: record.attemptId, live });
                return Promise.resolve();
            },
        );
    });

    teardown(async () => {
        await monitor.dispose();
        sandbox.restore();
        await fs.promises.rm(directory, { recursive: true, force: true });
    });

    test('scans at startup and on nameless events, and requires live evidence for a scan-only record', async () => {
        await publish('historical');
        await monitor.start();
        assert.deepEqual(received, [{ attempt: 'historical', live: false }]);
        await publish('retry');
        hooks[0].change(null);
        await until(() => received.length === 2);
        assert.deepEqual(received[1], { attempt: 'retry', live: true });
        assert.equal(reads, 2);
        await clock.tickAsync(2000); // Unchanged directory only needs a metadata check.
        assert.equal(reads, 2);
    });

    test('finds silent atomic replacements and retains evidence from a pending retry', async () => {
        await monitor.start();
        await publish('first');
        await clock.tickAsync(2000);
        await until(() => received.length === 1);
        assert.deepEqual(received[0], { attempt: 'first', live: false });
        await publish('second', 'pending');
        await clock.tickAsync(2000);
        await until(() => reads === 2);
        await publish('second');
        await clock.tickAsync(2000);
        await until(() => received.length === 2);
        assert.deepEqual(received[1], { attempt: 'second', live: true });
    });

    test('treats a nameless pending-to-failed publication as evidence for the same attempt', async () => {
        await publish('one', 'pending');
        await monitor.start();
        assert.equal(received.length, 0);
        await publish('one');
        hooks[0].change(null);
        await until(() => received.length === 1);
        assert.deepEqual(received[0], { attempt: 'one', live: true });
    });

    test('recreates a silently removed directory and rebinds a silently replaced inode', async () => {
        await monitor.start();
        await fs.promises.rm(directory, { recursive: true });
        await clock.tickAsync(2000);
        await until(() => hooks[0].close.calledOnce);
        await clock.tickAsync(250);
        await until(() => hooks.length === 2);
        assert.ok((await fs.promises.stat(directory)).isDirectory());
        const old = directory + '-old';
        await fs.promises.rename(directory, old);
        try {
            await fs.promises.mkdir(directory);
            await clock.tickAsync(2000);
            await until(() => hooks[1].close.calledOnce);
            await clock.tickAsync(500);
            await until(() => hooks.length === 3);
            await publish('current');
            hooks[2].change(name);
            await until(() => received.length === 1);
            assert.equal(received[0].live, true);
        } finally {
            await fs.promises.rm(old, { recursive: true, force: true });
        }
    });

    test('coalesces overlapping hints and stops before publishing an in-flight record', async () => {
        await monitor.dispose();
        let resume!: () => void;
        let readStarted!: () => void;
        const reading = new Promise<void>((resolve) => {
            readStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            resume = resolve;
        });
        let calls = 0;
        monitor = new TerminalStartupMonitor(
            directory,
            async (file) => {
                const record = JSON.parse(
                    await fs.promises.readFile(file, 'utf8'),
                ) as TerminalStartupRecord;
                calls++;
                if (calls === 1) {
                    readStarted();
                    await blocked;
                }
                return record;
            },
            (_file, record, live) => {
                received.push({ attempt: record.attemptId, live });
                return Promise.resolve();
            },
        );
        await monitor.start();
        await publish('old', 'pending');
        hooks[0].change(name);
        await reading;
        await publish('new');
        hooks[0].change(name);
        hooks[0].change(name);
        assert.equal(calls, 1);
        resume();
        await until(() => received.length === 1);
        assert.equal(calls, 2);
        assert.deepEqual(received, [{ attempt: 'new', live: true }]);
        // An event queued immediately before disposal must not reach the publisher.
        await publish('after-stop');
        hooks[0].change(name);
        await monitor.dispose();
        assert.equal(received.length, 1);
    });

    test('retries failed watch setup and errors with backoff, ignores stale handles and disposes timers', async () => {
        const warn = sandbox.stub(console, 'warn');
        open.onFirstCall().throws(new Error('watch initially unavailable'));
        await publish('initial');
        await monitor.start();
        assert.equal(received.length, 1);
        assert.ok(warn.calledOnce);
        await clock.tickAsync(249);
        assert.equal(open.callCount, 1);
        await clock.tickAsync(1);
        await until(() => hooks.length === 1);
        const old = hooks[0];
        old.watcher.emit('error', new Error('watch lost'));
        assert.equal(old.close.callCount, 1);
        await clock.tickAsync(499);
        assert.equal(open.callCount, 2);
        await clock.tickAsync(1);
        await until(() => hooks.length === 2);
        const current = hooks[1];
        old.watcher.emit('error', new Error('late error'));
        assert.equal(current.close.callCount, 0);
        current.watcher.emit('close');
        await monitor.dispose();
        const count = open.callCount;
        old.change(name);
        current.change(null);
        await clock.tickAsync(60000);
        assert.equal(open.callCount, count);
        assert.equal(clock.countTimers(), 0);
    });
});
