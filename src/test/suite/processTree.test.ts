import * as assert from 'assert';
import childProcess from 'child_process';
import * as sinon from 'sinon';
import { once } from 'events';
import { getProcessAncestors } from '../../processTree';

suite('Process ancestry', () => {
    teardown(() => sinon.restore());

    test('follows parents in order without including siblings or looping', async () => {
        const run = sinon.stub(childProcess, 'execFile').callsArgWith(3, null,
            ' 30 20\r\n 20 10\r\n 40 20\r\n 10 20\r\n', '');
        assert.deepStrictEqual(await getProcessAncestors(30), [20, 10]);
        sinon.assert.calledOnce(run);
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

    test('finds the parent of a real child process on this OS', async () => {
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
    });
});
