const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const field = 'Config/vscode-R/source-revision';
const placeholder = `${field}: @VSCODE_R_SESS_SOURCE_REVISION@`;

// A temporary index includes local development edits without changing the user's
// index. Restore the placeholder so stamping is idempotent and, for a clean
// checkout, the result is exactly HEAD:sess (not the extension's commit ID).
function stampSess(root = path.join(__dirname, '..')) {
    const descriptionPath = path.join(root, 'sess', 'DESCRIPTION');
    const template = fs.readFileSync(descriptionPath, 'utf8');
    const fieldPattern = /^Config\/vscode-R\/source-revision:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gm;
    const description = template.replace(fieldPattern, placeholder);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-sess-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') };
    const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
    try {
        if (template.match(fieldPattern)?.length !== 1) {
            throw new Error('sess/DESCRIPTION must contain exactly one source revision field');
        }
        if (!description.endsWith('\n')) {
            throw new Error('sess/DESCRIPTION must end with a newline');
        }
        git('read-tree', 'HEAD');
        git('add', '--all', '--', 'sess');
        const blob = execFileSync('git', ['hash-object', '-w', '--path=sess/DESCRIPTION', '--stdin'], {
            cwd: root, env, input: description, encoding: 'utf8'
        }).trim();
        git('update-index', '--add', '--cacheinfo', `100644,${blob},sess/DESCRIPTION`);
        const tree = git('write-tree');
        const revision = `git-tree:${git('rev-parse', `${tree}:sess`)}`;
        if (!/^git-tree:(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
            throw new Error('Could not determine bundled sess source revision');
        }
        fs.writeFileSync(descriptionPath, description.replace(placeholder, `${field}: ${revision}`));
        return revision;
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

module.exports = { stampSess };
if (require.main === module) {
    console.log(stampSess());
}
