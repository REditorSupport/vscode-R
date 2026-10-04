const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { stampSess } = require('./stamp-sess');
const { verifySessVsix } = require('../.github/scripts/verify-sess-vsix');
const { ZipFile } = createRequire(require.resolve('@vscode/vsce/package.json'))('yazl');

const root = path.join(__dirname, '..');
const field = 'Config/vscode-R/source-revision';
const rscript = process.env.RSCRIPT || 'Rscript';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sess source test '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.copyFileSync(path.join(root, '.gitattributes'), path.join(directory, '.gitattributes'));
    fs.cpSync(path.join(root, 'sess'), path.join(directory, 'sess'), { recursive: true });
    const descriptionPath = path.join(directory, 'sess', 'DESCRIPTION');
    fs.writeFileSync(descriptionPath, fs.readFileSync(descriptionPath, 'utf8')
        .replace(/^Config\/vscode-R\/source-revision:.*$/gm, `${field}: @VSCODE_R_SESS_SOURCE_REVISION@`));
    fs.writeFileSync(path.join(directory, 'extension.ts'), '// stable\n');
    const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'core.autocrlf', 'false');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Source snapshot');
    return { directory, descriptionPath, git };
}

// A script file avoids passing multiline expressions through Windows command-line
// quoting. Keep it outside sess/ so bootstrap's clean-source check is meaningful.
function runRScript(directory, cwd, source) {
    const script = path.join(directory, 'test-script.R');
    fs.writeFileSync(script, source);
    execFileSync(rscript, ['--vanilla', script], { cwd });
}

test('clean stamp equals Git subtree, is idempotent, and preserves the real index', t => {
    const { directory, git } = fixture(t);
    const index = git('ls-files', '--stage');
    const expected = `git-tree:${git('rev-parse', 'HEAD:sess')}`;
    assert.equal(stampSess(directory), expected);
    assert.equal(stampSess(directory), expected);
    assert.equal(git('ls-files', '--stage'), index);
});

test('extension changes preserve identity; same-version sess changes and reverting change it', t => {
    const { directory, git } = fixture(t);
    const stable = stampSess(directory);
    fs.writeFileSync(path.join(directory, 'extension.ts'), '// pre-release\n');
    assert.equal(stampSess(directory), stable);
    const source = path.join(directory, 'sess', 'R', 'server.R');
    const original = fs.readFileSync(source);
    fs.appendFileSync(source, '\n# new implementation at the same package version\n');
    const preRelease = stampSess(directory);
    assert.notEqual(preRelease, stable);
    assert.equal(stampSess(directory), preRelease);
    fs.writeFileSync(source, original);
    assert.equal(stampSess(directory), stable);
    // Changing commits outside sess is also independent of the subtree identity.
    git('add', 'extension.ts');
    git('commit', '--quiet', '-m', 'Extension only');
    assert.equal(stampSess(directory), stable);
});

test('new and deleted sess files are included in development fingerprints', t => {
    const { directory } = fixture(t);
    const initial = stampSess(directory);
    const source = path.join(directory, 'sess', 'R', 'new.R');
    fs.writeFileSync(source, '# new source\n');
    assert.notEqual(stampSess(directory), initial);
    fs.unlinkSync(source);
    assert.equal(stampSess(directory), initial);
    fs.unlinkSync(path.join(directory, 'sess', 'R', 'server.R'));
    assert.notEqual(stampSess(directory), initial);
});

test('R-universe bootstrap after DESCRIPTION normalization matches VSIX identity', t => {
    const { directory, descriptionPath, git } = fixture(t);
    const expected = stampSess(directory);
    // R-universe normalizes DESCRIPTION and may append system requirement metadata
    // before invoking bootstrap.R from the package directory.
    const packageDirectory = path.join(directory, 'sess');
    runRScript(directory, packageDirectory, `
        x <- read.dcf('DESCRIPTION', keep.white = 'Authors@R')
        x[1, '${field}'] <- '@VSCODE_R_SESS_SOURCE_REVISION@'
        write.dcf(x, 'DESCRIPTION', keep.white = 'Authors@R')
        cat('Config/pak/sysreqs: test-build-metadata\n', file = 'DESCRIPTION', append = TRUE)
    `);
    for (let i = 0; i < 2; i++) {
        execFileSync(rscript, ['--vanilla', 'bootstrap.R'], { cwd: packageDirectory });
        assert.match(fs.readFileSync(descriptionPath, 'utf8'), new RegExp(`${field}: ${expected}`));
    }
    assert.equal(expected, `git-tree:${git('rev-parse', 'HEAD:sess')}`);
    // The custom field must also survive R CMD build into the source tarball.
    execFileSync('R', ['--vanilla', 'CMD', 'build', '--no-manual', '--no-build-vignettes', 'sess'], { cwd: directory });
    const tarball = fs.readdirSync(directory).find(name => name.endsWith('.tar.gz'));
    runRScript(directory, directory, `
        untar(${JSON.stringify(tarball)}, files = 'sess/DESCRIPTION', exdir = 'built')
        x <- read.dcf('built/sess/DESCRIPTION')
        stopifnot(x[1, '${field}'] == '${expected}')
    `);
});

test('failed bootstrap leaves no stale stamp, including dirty sources', t => {
    const { directory, descriptionPath } = fixture(t);
    stampSess(directory);
    fs.appendFileSync(path.join(directory, 'sess', 'R', 'server.R'), '\n# dirty source\n');
    const failed = spawnSync(rscript, ['--vanilla', 'bootstrap.R'], { cwd: path.join(directory, 'sess') });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr.toString(), /bootstrap.R requires committed sess sources/);
    assert.ok(fs.readFileSync(descriptionPath, 'utf8').includes('@VSCODE_R_SESS_SOURCE_REVISION@'));
    // R-universe ignores this exit status; an unstamped package is a migration
    // candidate, never an apparently matching copy.
    fs.rmSync(path.join(directory, '.git'), { recursive: true, force: true });
    fs.writeFileSync(descriptionPath, fs.readFileSync(descriptionPath, 'utf8')
        .replace('@VSCODE_R_SESS_SOURCE_REVISION@', 'git-tree:' + 'a'.repeat(40)));
    const missingGit = spawnSync(rscript, ['--vanilla', 'bootstrap.R'], { cwd: path.join(directory, 'sess') });
    assert.notEqual(missingGit.status, 0);
    assert.match(missingGit.stderr.toString(), /Cannot determine sess source revision from Git/);
    assert.ok(fs.readFileSync(descriptionPath, 'utf8').includes('@VSCODE_R_SESS_SOURCE_REVISION@'));
    assert.throws(() => stampSess(directory));
});

test('VSIX verification accepts the matching stamp and rejects invalid packaged metadata', async t => {
    const { directory, descriptionPath } = fixture(t);
    const revision = stampSess(directory);
    const description = fs.readFileSync(descriptionPath, 'utf8');
    const vsix = path.join(directory, 'test.vsix');
    async function writeVsix(content) {
        const zip = new ZipFile();
        if (content !== undefined) {
            zip.addBuffer(Buffer.from(content), 'extension/sess/DESCRIPTION');
        } else {
            zip.addBuffer(Buffer.from('{}'), 'extension/package.json');
        }
        const output = fs.createWriteStream(vsix);
        const finished = new Promise((resolve, reject) => {
            output.on('finish', resolve);
            output.on('error', reject);
            zip.outputStream.on('error', reject);
        });
        zip.outputStream.pipe(output);
        zip.end();
        await finished;
    }
    await writeVsix(description);
    await verifySessVsix(vsix, directory);
    await writeVsix(description.replace(revision, 'git-tree:' + 'a'.repeat(40)));
    await assert.rejects(verifySessVsix(vsix, directory), /must match/);
    await writeVsix(description.replace(revision, '@VSCODE_R_SESS_SOURCE_REVISION@'));
    await assert.rejects(verifySessVsix(vsix, directory), /must match/);
    await writeVsix(undefined);
    await assert.rejects(verifySessVsix(vsix, directory), /missing/);
});
