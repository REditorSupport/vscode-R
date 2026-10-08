import * as assert from 'assert';
import * as sinon from 'sinon';
import { SessionProcessMonitor } from '../../sessionProcessMonitor';

suite('Session process monitor', () => {
    let sandbox: sinon.SinonSandbox;
    let clock: sinon.SinonFakeTimers;
    let kill: sinon.SinonStub;
    let monitor: SessionProcessMonitor<ReturnType<typeof owner>>;
    const owner = (sessionId = 'source', pid = '12345', host = 'local') => ({
        sessionId, pid, host, processExited: false,
    });

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers();
        kill = sandbox.stub(process, 'kill').returns(true);
        monitor = new SessionProcessMonitor(host => host.toLowerCase() === 'local');
    });

    teardown(() => sandbox.restore());

    test('shares one timer and one probe per source, including reconnected transports', () => {
        const first = owner();
        const callbacks = [sandbox.stub(), sandbox.stub(), sandbox.stub()];
        const viewers = [monitor.observe(first, callbacks[0]), monitor.observe(first, callbacks[1]),
            monitor.observe(owner('source', '12345', 'LOCAL'), callbacks[2])];
        const other = monitor.observe(owner('other', '23456'), sandbox.stub());
        assert.strictEqual(clock.countTimers(), 1);
        clock.tick(1000);
        sinon.assert.calledTwice(kill);
        sinon.assert.calledWithExactly(kill, 12345, 0);
        sinon.assert.calledWithExactly(kill, 23456, 0);

        viewers[0].dispose();
        kill.resetHistory();
        kill.withArgs(12345, 0).throws(Object.assign(new Error('exited'), { code: 'ESRCH' }));
        clock.tick(1000);
        sinon.assert.calledTwice(kill);
        sinon.assert.notCalled(callbacks[0]);
        sinon.assert.calledOnce(callbacks[1]);
        sinon.assert.calledOnce(callbacks[2]);
        assert.ok(viewers.every(viewer => viewer.exited));
        viewers.forEach(viewer => viewer.dispose());
        assert.strictEqual(clock.countTimers(), 1, 'the other process still needs monitoring');
        other.dispose();
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('confirmed exit immediately notifies every viewer and stops polling', () => {
        const source = owner();
        const callbacks = [sandbox.stub(), sandbox.stub()];
        const viewers = callbacks.map(callback => monitor.observe(source, callback));
        source.processExited = true;
        monitor.markExited(source);
        callbacks.forEach(callback => sinon.assert.calledOnce(callback));
        assert.ok(viewers.every(viewer => viewer.exited));
        assert.strictEqual(clock.countTimers(), 0);
        monitor.markExited(source);
        clock.tick(1000);
        callbacks.forEach(callback => sinon.assert.calledOnce(callback));
        sinon.assert.notCalled(kill);
        viewers.forEach(viewer => viewer.dispose());
    });

    test('remote hosts and invalid PIDs need no polling timer', () => {
        for (const source of [owner('remote', '12345', 'foreign'), owner('invalid', 'not-a-pid'), owner('empty', '')]) {
            const callback = sandbox.stub();
            const viewer = monitor.observe(source, callback);
            assert.strictEqual(clock.countTimers(), 0);
            source.processExited = true;
            monitor.markExited(source);
            sinon.assert.calledOnce(callback);
            assert.strictEqual(viewer.exited, true);
            viewer.dispose();
        }
        sinon.assert.notCalled(kill);
    });

    test('an exited reconnect confirms the original process even without PID metadata', () => {
        const source = owner('source', '12345', 'foreign');
        const callback = sandbox.stub();
        const viewer = monitor.observe(source, callback);
        const reconnected = { ...source, pid: '', processExited: true };
        monitor.markExited(reconnected);
        sinon.assert.calledOnce(callback);
        assert.strictEqual(viewer.exited, true);
        const next = monitor.observe(reconnected, sandbox.stub());
        assert.strictEqual(next.exited, true);
        assert.strictEqual(clock.countTimers(), 0);
        viewer.dispose(); next.dispose();
    });

    test('permission and unknown errors do not mark the source exited', () => {
        const callback = sandbox.stub();
        const viewer = monitor.observe(owner(), callback);
        for (const code of ['EPERM', 'EACCES', undefined]) {
            kill.throws(Object.assign(new Error('uncertain'), { code }));
            clock.tick(1000);
            assert.strictEqual(viewer.exited, false);
        }
        sinon.assert.notCalled(callback);
        viewer.dispose();
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('old viewers retain their original PID and exit state across metadata changes', () => {
        const source = owner();
        const viewer = monitor.observe(source, sandbox.stub());
        source.pid = '23456';
        clock.tick(1000);
        sinon.assert.calledOnceWithExactly(kill, 12345, 0);
        kill.throws(Object.assign(new Error('exited'), { code: 'ESRCH' }));
        clock.tick(1000);
        assert.strictEqual(monitor.hasExited(source), true);
        viewer.dispose();
        kill.resetHistory();
        kill.resetBehavior();
        kill.returns(true);
        const reopened = monitor.observe(source, sandbox.stub());
        assert.strictEqual(reopened.exited, true);
        assert.strictEqual(clock.countTimers(), 0, 'a known exit must not be revived');
        const replacement = monitor.observe(owner('replacement', '23456'), sandbox.stub());
        assert.strictEqual(replacement.exited, false);
        clock.tick(1000);
        sinon.assert.calledOnceWithExactly(kill, 23456, 0);
        reopened.dispose(); replacement.dispose();
    });

    test('monitoring resumes if the last viewer closes before the source exits', () => {
        const source = owner();
        monitor.observe(source, sandbox.stub()).dispose();
        assert.strictEqual(clock.countTimers(), 0);
        const viewer = monitor.observe(source, sandbox.stub());
        clock.tick(1000);
        sinon.assert.calledOnceWithExactly(kill, 12345, 0);
        viewer.dispose();
        assert.strictEqual(clock.countTimers(), 0);
    });
});
