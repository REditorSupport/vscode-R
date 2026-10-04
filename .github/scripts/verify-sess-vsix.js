const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

// Reuse vsce's ZIP dependency without relying on its private API. Resolve it in
// vsce's context because pnpm does not expose transitive dependencies at root.
const { open } = createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');

function readDescription(vsixFile) {
    return new Promise((resolve, reject) => {
        open(vsixFile, { lazyEntries: true }, (error, zip) => {
            if (error) {
                reject(error);
                return;
            }
            let description;
            const fail = error => {
                zip.close();
                reject(error);
            };
            zip.on('error', fail);
            zip.on('end', () => {
                if (description === undefined) {
                    reject(new Error('VSIX is missing extension/dist/resources/sess/DESCRIPTION'));
                } else {
                    resolve(description);
                }
            });
            zip.on('entry', entry => {
                if (entry.fileName !== 'extension/dist/resources/sess/DESCRIPTION') {
                    zip.readEntry();
                    return;
                }
                if (description !== undefined) {
                    fail(new Error('VSIX contains multiple sess DESCRIPTION files'));
                    return;
                }
                zip.openReadStream(entry, (error, stream) => {
                    if (error) {
                        fail(error);
                        return;
                    }
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.on('error', fail);
                    stream.on('end', () => {
                        description = Buffer.concat(chunks).toString('utf8');
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
    });
}

async function verifySessVsix(vsixFile, cwd = path.join(__dirname, '..', '..')) {
    assert.ok(vsixFile, 'Pass a VSIX path or set VSIX_FILE');
    const tree = execFileSync('git', ['rev-parse', 'HEAD:sess'], { cwd, encoding: 'utf8' }).trim();
    const description = await readDescription(vsixFile);
    const revisions = [...description.matchAll(/^Config\/vscode-R\/source-revision:[ \t]*(\S+)[ \t]*\r?$/gm)];
    assert.equal(revisions.length, 1, 'Packaged sess must have exactly one source revision');
    assert.equal(revisions[0][1], `git-tree:${tree}`, 'Packaged sess source must match this checkout');
    assert.ok(!description.includes('@VSCODE_R_SESS_SOURCE_REVISION@'), 'Unexpanded sess source revision');
}

module.exports = { verifySessVsix };
if (require.main === module) {
    verifySessVsix(process.argv[2] || process.env.VSIX_FILE).then(() => {
        console.log('Packaged sess source identity verified');
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
