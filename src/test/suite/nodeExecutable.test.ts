import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveNodeExecutable } from '../../interactive/nodeExecutable';
import { agentEnvironment, prepareNodeRuntime } from '../../interactive/launcher';

suite('Interactive Node runtime', () => {
    let root: string;
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-node-path-')); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });
    function executable(directory: string, filename = name, text = ''): string {
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, filename);
        fs.writeFileSync(file, text, { mode: 0o700 });
        return file;
    }

    test('uses VS Code Server Node when node is missing from the remote PATH', () => {
        const bundled = executable(path.join(root, '.vscode-server', 'bin'));
        assert.strictEqual(resolveNodeExecutable('node', root, { execPath: bundled, path: path.join(root, 'empty') }), bundled);
        assert.strictEqual(resolveNodeExecutable('', root, { execPath: bundled, path: '' }), bundled);
    });
    test('prefers PATH or an explicit executable and does not replace invalid custom paths', () => {
        const bundled = executable(path.join(root, 'server'));
        const local = executable(path.join(root, 'custom path'));
        const host = { execPath: bundled, path: path.dirname(local) };
        assert.strictEqual(resolveNodeExecutable('node', root, host), local);
        assert.strictEqual(resolveNodeExecutable(`"${local}"`, root, host), local);
        assert.strictEqual(resolveNodeExecutable(path.join(root, 'missing-node'), root, host), undefined);
    });
    test('never falls back to a desktop Electron helper or a removed server runtime', () => {
        const bundled = executable(path.join(root, 'server'));
        assert.strictEqual(resolveNodeExecutable('node', root, { execPath: bundled, electron: '42.0.0', path: '' }), undefined);
        const helper = executable(root, 'Code Helper');
        assert.strictEqual(resolveNodeExecutable('node', root, { execPath: helper, path: '' }), undefined);
        fs.unlinkSync(bundled);
        assert.strictEqual(resolveNodeExecutable('node', root, { execPath: bundled, path: '' }), undefined);
    });
    test('reports invalid paths with a Remote SSH recovery setting before launch', async () => {
        await assert.rejects(prepareNodeRuntime(path.join(root, 'missing-node'), root), /r\.interactive\.nodePath.*remote server/);
        assert.deepStrictEqual(fs.readdirSync(root), []);
    });
    test('prepares the actual standalone host runtime with no node on PATH', async () => {
        const node = resolveNodeExecutable('node', root); assert.ok(node);
        const script = `require(${JSON.stringify(require.resolve('../../interactive/launcher'))})
            .prepareNodeRuntime('node', process.cwd()).then(node => process.stdout.write(node))
            .catch(error => { console.error(error); process.exitCode = 1; });`;
        const result = await promisify(execFile)(node, ['-e', script], {
            cwd: root, env: { ...agentEnvironment(), PATH: root }, timeout: 10000,
        });
        assert.strictEqual(fs.realpathSync(result.stdout), fs.realpathSync(node));
    });
    test('validates the runtime version rather than accepting arbitrary version output', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const node = executable(root, name, '#!/bin/sh\nprintf "v24.0.0\\n"\n');
        assert.strictEqual(await prepareNodeRuntime(node, root), node);
        for (const version of ['v16.0.0', 'not node']) {
            fs.writeFileSync(node, `#!/bin/sh\nprintf "${version}\\n"\n`);
            await assert.rejects(prepareNodeRuntime(node, root), /requires Node.js 18 or newer/);
        }
    });
});
