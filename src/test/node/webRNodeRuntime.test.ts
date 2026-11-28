import * as assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareNodeWebR } from '../../webr/nodeRuntime';

suite('cached webR Node worker', function () {
    this.timeout(60000);
    test('runs from an escaped host path, mounts project files, and recovers incomplete generations', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'webR # 100% '));
        let installs = 0;
        const unpack = async (directory: string) => {
            installs++;
            await cp(path.dirname(require.resolve('webr')), directory, { recursive: true });
        };
        try {
            const [first, second] = await Promise.all([
                prepareNodeWebR(root, unpack),
                prepareNodeWebR(root, unpack),
            ]);
            assert.equal(first, second);
            assert.equal(installs, 1);
            const { WebR } = await import('webr');
            const runtime = new WebR({ baseUrl: first });
            try {
                await runtime.init();
                const project = path.join(root, 'project #1 %22');
                await mkdir(project);
                await writeFile(path.join(project, 'value.R'), 'value <- 21\n');
                await runtime.FS.mkdir('/project');
                await runtime.FS.mount('NODEFS', { root: project }, '/project');
                await runtime.evalRVoid(
                    'setwd("/project"); source("value.R"); writeLines(as.character(value * 2), "result.txt")',
                );
                assert.equal(
                    (await readFile(path.join(project, 'result.txt'), 'utf8')).trim(),
                    '42',
                );
                if (process.platform === 'win32') {
                    const drive = path.parse(project).root;
                    const relative = path
                        .relative(drive, path.join(project, 'value.R'))
                        .split(path.sep)
                        .join('/');
                    await runtime.FS.mkdir('/drive');
                    await runtime.FS.mount('NODEFS', { root: drive }, '/drive');
                    assert.equal(
                        new TextDecoder().decode(await runtime.FS.readFile('/drive/' + relative)),
                        'value <- 21\n',
                    );
                }
            } finally {
                runtime.close();
            }
            // Model a second extension host publishing after this installer sees
            // a cache miss and before it renames its completed staging directory.
            const competingRoot = path.join(root, 'other host');
            const competingDir = path.join(competingRoot, 'runtimes', path.basename(first));
            const raced = await prepareNodeWebR(competingRoot, async (stage) => {
                await cp(path.dirname(require.resolve('webr')), stage, { recursive: true });
                await cp(first, competingDir, { recursive: true });
            });
            assert.equal(raced, competingDir + path.sep);
            assert.deepEqual(await readdir(path.dirname(competingDir)), [path.basename(first)]);
            await rm(path.join(first, 'R.wasm'));
            const repaired = await prepareNodeWebR(root, unpack);
            assert.notEqual(repaired, first);
            assert.equal(installs, 2);
            await rm(path.join(repaired, '.complete'));
            const third = await prepareNodeWebR(root, unpack);
            assert.notEqual(third, repaired);
            assert.equal(await prepareNodeWebR(root, unpack), third);
            assert.equal(installs, 3);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
