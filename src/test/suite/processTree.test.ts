import * as assert from 'assert';
import childProcess from 'child_process';
import * as sinon from 'sinon';
import { once } from 'events';
import { getProcessAncestors, getProcessQuerySpec } from '../../processTree';

suite('Process ancestry', () => {
    teardown(() => sinon.restore());

    test('follows parents in order without including siblings or looping', async () => {
        const run = sinon.stub(childProcess, 'execFile').callsArgWith(3, null,
            ' 30 20\r\n 20 10\r\n 40 20\r\n 10 20\r\n', '');
        assert.deepStrictEqual(await getProcessAncestors(30), [20, 10]);
        sinon.assert.calledOnce(run);
        assert.strictEqual(run.firstCall.args[0], getProcessQuerySpec().executable);
        assert.deepStrictEqual(run.firstCall.args[1], getProcessQuerySpec().args);
        assert.deepStrictEqual(run.firstCall.args[2], {
            encoding: 'utf8', timeout: getProcessQuerySpec().timeout,
            maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        });
    });

    test('builds bounded process query commands for Windows and POSIX', () => {
        assert.deepStrictEqual(getProcessQuerySpec('win32'), {
            executable: 'powershell.exe',
            args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'],
            timeout: 15000,
        });
        assert.deepStrictEqual(getProcessQuerySpec('linux'), {
            executable: 'ps', args: ['-A', '-o', 'pid=', '-o', 'ppid='], timeout: 5000,
        });
        assert.deepStrictEqual(getProcessQuerySpec('darwin'), getProcessQuerySpec('linux'));
    });

    test('ignores malformed rows and stops at missing or zero parents', async () => {
        sinon.stub(childProcess, 'execFile').callsArgWith(3, null,
            '10 0\n20 10\n30 nope\n40 20 extra\n50 999\n', '');
        assert.deepStrictEqual(await getProcessAncestors(20), [10]);
        assert.deepStrictEqual(await getProcessAncestors(30), []);
        assert.deepStrictEqual(await getProcessAncestors(40), []);
        assert.deepStrictEqual(await getProcessAncestors(50), [999]);
    });

    test('unknown PIDs and failed process queries do not invent an association', async () => {
        const run = sinon.stub(childProcess, 'execFile').callsArgWith(3, null, '20 10\n', '');
        assert.deepStrictEqual(await getProcessAncestors(30), []);
        run.callsArgWith(3, new Error('process query timed out'), '', '');
        sinon.stub(console, 'warn');
        assert.deepStrictEqual(await getProcessAncestors(30), []);
    });

    test('invalid PIDs do not launch a process query', async () => {
        const run = sinon.stub(childProcess, 'execFile');
        for (const pid of [0, -1, NaN, 1.5]) {
            assert.deepStrictEqual(await getProcessAncestors(pid), []);
        }
        sinon.assert.notCalled(run);
    });

    (process.platform !== 'win32' || process.env.VSCODE_R_TEST_WINDOWS_PROCESS_ANCESTRY === '1' ? test : test.skip)(
        'finds the parent of a real child process on this OS', async () => {
            const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',
            });
            try {
                await once(child, 'spawn');
                assert.ok(child.pid);
                assert.strictEqual((await getProcessAncestors(child.pid))[0], process.pid);
            } finally {
                const exited = once(child, 'exit');
                child.kill();
                await exited;
            }
        }
    );
});
