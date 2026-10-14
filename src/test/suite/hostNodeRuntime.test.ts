import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { nodeEnvironment, prepareNodeRuntime } from '../../interactive/launcher';

suite('Interactive VS Code host runtime', () => {
    let root: string;
    setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-host-node-runtime-')); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('prepares and launches the actual host runtime with no node on PATH', async () => {
        // This case must run in the desktop Extension Host, not standalone Node.
        assert.ok(process.versions.electron, 'Expected the actual VS Code Electron runtime');
        const runtime = await prepareNodeRuntime(root);
        assert.strictEqual(runtime.executable, process.execPath);
        assert.strictEqual(runtime.electron, true);
        const script = `require(${JSON.stringify(require.resolve('../../interactive/launcher'))})
            .prepareNodeRuntime(process.cwd()).then(runtime => process.stdout.write(JSON.stringify(runtime)))
            .catch(error => { console.error(error); process.exitCode = 1; });`;
        const result = await promisify(execFile)(runtime.executable, ['-e', script], {
            cwd: root, env: nodeEnvironment(runtime, { ...process.env, PATH: root }), timeout: 10000,
        });
        assert.deepStrictEqual(JSON.parse(result.stdout), runtime);
    });
});
