import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { FailureDiagnostics } from '../common/failureDiagnostics';
import { parseCpuTime, parsePs, startProcessMonitor } from '../common/processMonitor';
import { StallSampler } from '../common/stallSampler';

const readLines = (file: string): Record<string, unknown>[] =>
    fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

const blockFor = (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        // Keep the event loop busy, as a stalled extension host would.
    }
};

suite('Failure diagnostics', () => {
    let directory: string;
    let consoleError: sinon.SinonStub;
    setup(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-diagnostics-'));
        consoleError = sinon.stub(console, 'error');
    });
    teardown(() => {
        consoleError.restore();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('writes the call timeline and attachments to the report file, then calls that finish after close', async () => {
        const reportFile = path.join(directory, 'nested', 'report.log');
        const diagnostics = new FailureDiagnostics('test', () => ({ state: 1 }), {
            reportFile,
            maxCalls: 2,
        });
        diagnostics.attach('samples', () => ({ sampled: true }));
        for (let i = 0; i < 3; i++) {
            await diagnostics.trace('done', () => Promise.resolve());
        }
        const stalled = deferred();
        void diagnostics.trace('stalled', () => stalled.promise);
        diagnostics.close();
        diagnostics.report();
        stalled.resolve();
        await settle();
        diagnostics.appendAfterReport('cleanup', { stopped: true });

        const [report, late, cleanup] = readLines(reportFile);
        assert.strictEqual(report.kind, 'report');
        assert.deepStrictEqual(report.state, { state: 1 });
        assert.deepStrictEqual(report.attachments, { samples: { sampled: true } });
        assert.deepStrictEqual(
            (report.pendingCalls as { id: number; name: string }[]).map(({ id, name }) => ({
                id,
                name,
            })),
            [{ id: 4, name: 'stalled' }],
        );
        assert.deepStrictEqual(
            (report.completedCalls as { id: number }[]).map(({ id }) => id),
            [2, 3],
        );
        assert.strictEqual(report.droppedCalls, 1);
        assert.strictEqual(late.kind, 'late call');
        assert.strictEqual(late.id, 4);
        assert.strictEqual(late.result, 'fulfilled');
        assert.ok((late.endMs as number) >= (report.closedAtMs as number));
        assert.deepStrictEqual(
            { kind: cleanup.kind, data: cleanup.data },
            { kind: 'cleanup', data: { stopped: true } },
        );
        sinon.assert.calledOnce(consoleError);
        assert.ok(String(consoleError.firstCall.args[0]).includes(reportFile));
    });

    test('a passing test writes nothing, even when a traced call finishes after close', async () => {
        const reportFile = path.join(directory, 'report.log');
        const diagnostics = new FailureDiagnostics('test', () => ({}), { reportFile });
        const stalled = deferred();
        void diagnostics.trace('stalled', () => stalled.promise);
        diagnostics.close();
        stalled.resolve();
        await settle();
        diagnostics.appendAfterReport('cleanup', {});
        assert.strictEqual(fs.existsSync(reportFile), false);
        sinon.assert.notCalled(consoleError);
    });

    test('a rejection after close does not report a new failure', async () => {
        const diagnostics = new FailureDiagnostics('test', () => ({}));
        const stalled = Promise.reject(new Error('late'));
        stalled.catch(() => undefined);
        diagnostics.close();
        await diagnostics
            .trace('late', () => stalled)
            .then(
                () => undefined,
                () => undefined,
            );
        await settle();
        sinon.assert.notCalled(consoleError);
    });
});

suite('Stall sampler', () => {
    test('records timer lag and keeps at most one probe pending', async () => {
        type Snapshot = {
            samples: { timerLagMs: number; userCpuMs: number }[];
            probes: {
                completed: { result: string }[];
                pending?: { pendingMs: number };
                skippedWhilePending: number;
            };
        };
        const probes: (() => void)[] = [];
        const sampler = new StallSampler({
            intervalMs: 20,
            probe: () =>
                new Promise<void>((resolve) => {
                    probes.push(resolve);
                }),
        });
        sampler.start();
        try {
            const deadline = Date.now() + 10000;
            const waitFor = async (condition: () => boolean, message: string) => {
                while (!condition()) {
                    assert.ok(Date.now() < deadline, message);
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            };
            await waitFor(() => probes.length > 0, 'No probe was sent');
            blockFor(200);
            await waitFor(
                () => (sampler.snapshot() as Snapshot).probes.skippedWhilePending >= 2,
                'Ticks did not continue while the probe was pending',
            );
            const stalled = sampler.snapshot() as Snapshot;
            assert.strictEqual(probes.length, 1, 'A pending probe must not be repeated');
            assert.ok(stalled.probes.pending && stalled.probes.pending.pendingMs >= 200);
            assert.ok(stalled.probes.skippedWhilePending >= 2);
            assert.ok(
                stalled.samples.some((sample) => sample.timerLagMs >= 150),
                JSON.stringify(stalled.samples),
            );
            // CPU time depends on scheduling, so only check that it is recorded.
            assert.ok(
                stalled.samples.every(
                    (sample) => Number.isFinite(sample.userCpuMs) && sample.userCpuMs >= 0,
                ),
            );
            probes[0]();
            await waitFor(() => probes.length >= 2, 'No probe was sent after the first completed');
            // The second probe stays pending, so later ticks must not add more.
            await new Promise((resolve) => setTimeout(resolve, 60));
            const resumed = sampler.snapshot() as Snapshot;
            assert.strictEqual(resumed.probes.completed[0].result, 'fulfilled');
            assert.strictEqual(probes.length, 2, 'The next tick sends one new probe');
        } finally {
            sampler.stop();
        }
    });
});

suite('Process monitor', () => {
    test('parses cumulative CPU times from macOS and Linux ps', () => {
        assert.strictEqual(parseCpuTime('1:02.50'), 62500);
        assert.strictEqual(parseCpuTime('01:02:03'), 3723000);
        assert.strictEqual(parseCpuTime('2-00:00:01'), 172801000);
        assert.deepStrictEqual(
            parsePs('  12   1   0:01.50  2048 /Applications/Code.app/Contents/MacOS/Electron\n'),
            [
                {
                    pid: 12,
                    ppid: 1,
                    cpuMs: 1500,
                    rssKb: 2048,
                    command: '/Applications/Code.app/Contents/MacOS/Electron',
                },
            ],
        );
    });

    test('exits by itself once the watched process has exited', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-monitor-'));
        const watched = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
            stdio: 'ignore',
        });
        const output = path.join(directory, 'processes.log');
        const monitor = startProcessMonitor(output, { watched: watched.pid, intervalMs: 50 });
        try {
            const deadline = Date.now() + 20000;
            while (!fs.existsSync(output)) {
                assert.ok(Date.now() < deadline, JSON.stringify(monitor.status()));
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            watched.kill('SIGKILL');
            while (!(monitor.status() as { exit?: unknown }).exit) {
                assert.ok(Date.now() < deadline, 'The monitor outlived the watched process');
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.strictEqual(readLines(output).at(-1)?.reason, 'watched process exited');
        } finally {
            watched.kill('SIGKILL');
            await monitor.stop();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('samples the watched process tree until stopped', async function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-monitor-'));
        const output = path.join(directory, 'processes.log');
        const monitor = startProcessMonitor(output, { intervalMs: 50 });
        try {
            // Count lines without parsing, since the last one may be partly written.
            const samples = () =>
                fs.existsSync(output)
                    ? fs.readFileSync(output, 'utf8').split('"kind":"sample"').length - 1
                    : 0;
            const deadline = Date.now() + 20000;
            while (samples() < 2) {
                assert.ok(Date.now() < deadline, JSON.stringify(monitor.status()));
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            await monitor.stop();
            const lines = readLines(output);
            assert.strictEqual(lines[0].kind, 'start');
            assert.strictEqual(lines[0].watched, process.pid);
            assert.deepStrictEqual(
                { kind: lines.at(-1)?.kind, reason: lines.at(-1)?.reason },
                { kind: 'stop', reason: 'SIGTERM' },
            );
            assert.deepStrictEqual((monitor.status() as { exit: unknown }).exit, {
                code: 0,
                signal: null,
            });
            const sample = lines.find((line) => line.kind === 'sample') as {
                tree: { pid: number }[];
                machine: { loadAverage: number[] };
            };
            assert.ok(sample.tree.some((row) => row.pid === process.pid));
            assert.strictEqual(sample.machine.loadAverage.length, 3);
        } finally {
            await monitor.stop();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
