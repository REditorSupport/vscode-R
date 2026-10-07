import * as assert from 'assert';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

suite('Bundled sess installation', () => {
    test('installs the stamped pure R bundle with dependencies available and verifies its identity', async function () {
        this.timeout(120000);
        const root = path.resolve(__dirname, '../../..');
        const result = await promisify(execFile)('Rscript', [path.join(root, 'src/test/examples/sess-installer.R'), root],
            { timeout: 110000, maxBuffer: 4 * 1024 * 1024 });
        assert.match(result.stdout, /Bundled pure R source installation and Interactive API verification passed/);
        assert.match(result.stdout, /Bundled pure R source installation for an ordinary R terminal passed/);
        assert.match(result.stdout, /Ordinary and Interactive verification works with only base default packages/);
        assert.match(result.stdout, /Exact source-revision mismatch rejected for ordinary and private verification/);
        assert.match(result.stdout, /Missing Imports use the configured repository and propagate installation errors/);
        assert.match(result.stdout, /Bundled sess installation failure is reported directly/);
    });
});
