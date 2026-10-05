import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as sinon from 'sinon';
import { hostNodeRuntime, resolveNodeRuntime } from '../../interactive/nodeExecutable';
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
            assert.deepStrictEqual(resolveNodeRuntime('', root), hostNodeRuntime());
            assert.deepStrictEqual(resolveNodeRuntime('  ', root), hostNodeRuntime());
            // A reload after an editor update must select the new host, not a cached path.
            executable.value(path.join(root, 'updated-server', 'node'));
            assert.strictEqual(hostNodeRuntime().executable, process.execPath);
        } finally { executable.restore(); environment.restore(); }
    });
    test('resolves explicit names and quoted or relative paths without changing the automatic default', () => {
        const directory = path.join(root, 'custom Node'); fs.mkdirSync(directory);
        const name = process.platform === 'win32' ? 'node.exe' : 'node';
        const executable = path.join(directory, name);
        fs.writeFileSync(executable, '', { mode: 0o700 });
        const environment = sinon.stub(process.env, 'PATH').value(directory);
        try {
            assert.deepStrictEqual(resolveNodeRuntime('', root), hostNodeRuntime());
            const commands = [name, `"${executable}"`, path.join('.', 'custom Node', name)];
            const homeRelative = path.relative(os.homedir(), executable);
            // Windows can place the temp directory on a different drive from home.
            if (!path.isAbsolute(homeRelative)) { commands.push(`~/${homeRelative}`); }
            for (const command of commands) {
                assert.deepStrictEqual(resolveNodeRuntime(command, root), { executable, electron: false });
            }
            for (const command of [path.join(root, 'missing-node'), directory]) {
                assert.throws(() => resolveNodeRuntime(command, root), /r\.interactive\.nodePath.*remote server/);
            }
        } finally { environment.restore(); }
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
    test('validates explicit standalone Node without Electron mode and reports how to repair an override', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const executable = path.join(root, 'standalone Node');
        const script = (version: string): string => `#!/bin/sh\n[ -z "$ELECTRON_RUN_AS_NODE" ] && [ "$1" = -p ] && [ "$2" = process.versions.node ] || exit 1\nprintf '${version}\\n'\n`;
        fs.writeFileSync(executable, script('24.0.0'), { mode: 0o700 });
        const runtime = resolveNodeRuntime(executable, root);
        assert.deepStrictEqual(await prepareNodeRuntime(root, runtime), { executable, electron: false });
        for (const version of ['16.0.0', 'not node']) {
            fs.writeFileSync(executable, script(version));
            await assert.rejects(prepareNodeRuntime(root, runtime), /requires Node.js 18 or newer.*r\.interactive\.nodePath/);
        }
        fs.unlinkSync(executable);
        await assert.rejects(prepareNodeRuntime(root, runtime), /Cannot run the Node.js runtime.*r\.interactive\.nodePath/);
    });
});
