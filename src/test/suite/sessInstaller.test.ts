import * as assert from 'assert';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

suite('Compiler-free sess installation', () => {
    test('installs bundled pure R source without a compiler and rejects an older API', async function () {
        this.timeout(120000);
        const root = path.resolve(__dirname, '../../..');
        const result = await promisify(execFile)('Rscript', [path.join(root, 'src/test/examples/sess-installer.R'), root],
            { timeout: 110000, maxBuffer: 4 * 1024 * 1024 });
        assert.match(result.stdout, /Pure R source installation and Interactive API verification passed/);
        assert.match(result.stdout, /Incompatible published build rejected without replacing installed sess/);
    });
});
