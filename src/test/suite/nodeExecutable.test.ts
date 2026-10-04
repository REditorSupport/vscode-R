import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as sinon from 'sinon';
import { hostNodeRuntime } from '../../interactive/nodeExecutable';
import { nodeEnvironment, prepareNodeRuntime } from '../../interactive/launcher';

suite('Interactive Node runtime', () => {
    let root: string;
    setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-node-runtime-')); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('uses the current extension host executable without a PATH lookup', () => {
        const environment = sinon.stub(process.env, 'PATH').value(root);
        const executable = sinon.stub(process, 'execPath').value(path.join(root, 'Code Helper (Plugin)'));
        try {
            assert.deepStrictEqual(hostNodeRuntime(), { executable: process.execPath, electron: !!process.versions.electron });
            // A reload after an editor update must select the new host, not a cached path.
            executable.value(path.join(root, 'updated-server', 'node'));
            assert.strictEqual(hostNodeRuntime().executable, process.execPath);
        } finally { executable.restore(); environment.restore(); }
    });
    test('scopes Electron Node mode to its launch environment and removes debugger injection', () => {
        const environment = { ELECTRON_RUN_AS_NODE: '1', VSCODE_INSPECTOR_OPTIONS: '{}', NODE_OPTIONS: '--require missing', PATH: root };
        assert.deepStrictEqual(nodeEnvironment({ executable: 'Code', electron: true }, environment), { PATH: root, ELECTRON_RUN_AS_NODE: '1' });
        assert.deepStrictEqual(nodeEnvironment({ executable: 'node', electron: false }, environment), { PATH: root });
        assert.strictEqual(environment.NODE_OPTIONS, '--require missing');
    });
    test('reports a removed host runtime before creating session storage', async () => {
        await assert.rejects(prepareNodeRuntime(root, { executable: path.join(root, 'removed-host'), electron: true }), /Reload VS Code.*VS Code Server/);
        assert.deepStrictEqual(fs.readdirSync(root), []);
    });
    test('prepares and launches the actual host runtime with no node on PATH', async () => {
        const runtime = await prepareNodeRuntime(root);
        const script = `require(${JSON.stringify(require.resolve('../../interactive/launcher'))})
            .prepareNodeRuntime(process.cwd()).then(runtime => process.stdout.write(JSON.stringify(runtime)))
            .catch(error => { console.error(error); process.exitCode = 1; });`;
        const result = await promisify(execFile)(runtime.executable, ['-e', script], {
            cwd: root, env: nodeEnvironment(runtime, { ...process.env, PATH: root }), timeout: 10000,
        });
        assert.deepStrictEqual(JSON.parse(result.stdout), runtime);
    });
    test('probes the Node version in Electron mode instead of its application version', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const executable = path.join(root, 'Code Helper');
        const runtime = { executable, electron: true };
        const script = (version: string): string => `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] && [ "$1" = -p ] && [ "$2" = process.versions.node ] || exit 1\nprintf '${version}\\n'\n`;
        fs.writeFileSync(executable, script('24.0.0'), { mode: 0o700 });
        assert.deepStrictEqual(await prepareNodeRuntime(root, runtime), runtime);
        for (const version of ['16.0.0', 'not node']) {
            fs.writeFileSync(executable, script(version));
            await assert.rejects(prepareNodeRuntime(root, runtime), /requires Node.js 18 or newer/);
        }
    });
});
