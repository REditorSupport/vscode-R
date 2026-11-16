import * as assert from 'assert';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { localEndpoint } from '../../interactive/transport';
import { defaultStorage, hasSessionEndpoint } from '../../interactive/launcher';
import { prepareSupervisor } from '../../interactive/supervisor';

suite('Interactive Windows transport and storage', () => {
    test('uses native, stable pipe names independent of the storage path length', () => {
        const directory = 'C:\\Users\\example\\AppData\\Local\\' + 'long name '.repeat(40);
        const endpoint = localEndpoint(directory, 'control.sock', 'win32');
        assert.match(endpoint, /^\\\\\.\\pipe\\vscode-r-[a-f0-9]{32}-control\.sock$/);
        assert.strictEqual(endpoint, localEndpoint(directory, 'control.sock', 'win32'));
        assert.notStrictEqual(endpoint, localEndpoint(directory, 'sess.sock', 'win32'));
        assert.notStrictEqual(
            endpoint,
            localEndpoint(directory + 'other', 'control.sock', 'win32'),
        );
        assert.strictEqual(
            localEndpoint('/tmp/private', 'control.sock', 'linux'),
            path.join('/tmp/private', 'control.sock'),
        );
    });
    test('Windows auto uses detached supervision and user-local storage', () => {
        assert.deepStrictEqual(prepareSupervisor('auto', '.', 'win32'), { kind: 'detached' });
        assert.deepStrictEqual(prepareSupervisor('detached', '.', 'win32'), { kind: 'detached' });
        assert.throws(() => prepareSupervisor('tmux', '.', 'win32'), /Windows supports/);
        assert.strictEqual(
            defaultStorage('win32', 'C:\\Users\\example', {}),
            'C:\\Users\\example\\AppData\\Local\\vscode-r\\interactive',
        );
        assert.strictEqual(
            defaultStorage('win32', 'C:\\Users\\example', {
                LOCALAPPDATA: 'D:\\Local',
                XDG_STATE_HOME: '/state',
            }),
            'D:\\Local\\vscode-r\\interactive',
        );
    });
    test('stale-entry pre-filter checks PIDs and only stats Unix sockets', () => {
        const manifest = {
            agentPid: process.pid,
            endpoint: localEndpoint('private', 'control', 'win32'),
        } as import('../../interactive/protocol').SessionManifest;
        const stat = sinon.stub(fs, 'statSync').throws(new Error('Must not stat a pipe'));
        const kill = sinon.stub(process, 'kill').returns(true);
        try {
            assert.ok(hasSessionEndpoint(manifest, 'win32'));
            sinon.assert.notCalled(stat);
            const unix = { ...manifest, endpoint: path.join(os.tmpdir(), 'control.sock') };
            stat.resetBehavior();
            stat.returns({ isSocket: () => false } as fs.Stats);
            assert.ok(!hasSessionEndpoint(unix, 'linux'));
            stat.returns({ isSocket: () => true } as fs.Stats);
            assert.ok(hasSessionEndpoint(unix, 'linux'));
            stat.throws(Object.assign(new Error('Missing socket'), { code: 'ENOENT' }));
            assert.ok(!hasSessionEndpoint(unix, 'linux'));
            stat.resetHistory();
            kill.throws(Object.assign(new Error('No such process'), { code: 'ESRCH' }));
            assert.ok(!hasSessionEndpoint(manifest, 'win32'));
            assert.ok(!hasSessionEndpoint(unix, 'linux'));
            sinon.assert.notCalled(stat);
        } finally {
            kill.restore();
            stat.restore();
        }
    });
});
