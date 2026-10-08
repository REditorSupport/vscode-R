import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

const bundledRevision = 'git-tree:' + 'a'.repeat(40);
const oldRevision = 'git-tree:' + 'b'.repeat(40);
const description = (revision: string) => [
    'Package: sess',
    'Version: 0.0.1',
    'Title: Installer Test Fixture',
    'Description: A dependency-free installer regression fixture.',
    'License: MIT',
    'Author: Test Author',
    'Maintainer: Test Author <test@example.com>',
    `Config/vscode-R/source-revision: ${revision}`,
    ''
].join('\n');

suite('Sess installation with real R tasks', () => {
    let sandbox: sinon.SinonSandbox;
    let extensionRoot: string;
    let projectA: string;
    let projectB: string;

    setup(async () => {
        sandbox = sinon.createSandbox();
        const folders = vscode.workspace.workspaceFolders;
        assert.ok(folders, 'Run using the sess-install-tasks configuration');
        assert.strictEqual(folders.length, 2);
        projectA = folders[0].uri.fsPath;
        projectB = folders[1].uri.fsPath;
        const root = path.dirname(projectA);
        extensionRoot = path.join(root, 'extension with spaces');
        const repositoryRoot = path.join(__dirname, '..', '..', '..');
        await fs.ensureDir(path.join(extensionRoot, 'R'));
        for (const script of ['install_sess.R', 'sess_source.R', 'sess-package-install.R']) {
            await fs.copy(path.join(repositoryRoot, 'R', script), path.join(extensionRoot, 'R', script));
        }
        const pkg = path.join(extensionRoot, 'dist', 'resources', 'sess');
        await fs.ensureDir(path.join(pkg, 'R'));
        await fs.writeFile(path.join(pkg, 'DESCRIPTION'), description(bundledRevision));
        const exports = ['connect', 'notify_client', 'request_client'];
        await fs.writeFile(path.join(pkg, 'NAMESPACE'), exports.map(name => `export(${name})`).join('\n'));
        await fs.writeFile(path.join(pkg, 'R', 'fixture.R'), exports.map(name => `${name} <- function(...) NULL`).join('\n'));
        for (const project of [projectA, projectB]) {
            const library = path.join(project, 'library');
            await fs.ensureDir(path.join(library, 'sess'));
            // Seed visible old metadata so the globally installed sess cannot
            // make the project appear up to date or hide a failed installation.
            await fs.writeFile(path.join(library, 'sess', 'DESCRIPTION'), description(oldRevision));
            await fs.writeFile(path.join(project, '.Rprofile'), '.libPaths(c(file.path(getwd(), "library"), .libPaths()))\n');
        }
        mockExtensionContext(extensionRoot, sandbox);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);
    });

    teardown(async () => {
        sandbox.restore();
        for (const project of [projectA, projectB]) {
            await fs.remove(path.join(project, 'library'));
            await fs.remove(path.join(project, '.Rprofile'));
        }
        await fs.remove(extensionRoot);
    });

    for (const asUri of [false, true]) {
        test(`installs into the second project's library (URI: ${String(asUri)})`, async () => {
            const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
            const settings = { get: () => true } as unknown as vscode.WorkspaceConfiguration;
            assert.strictEqual(await util.getInstalledSessSourceRevision(projectA), oldRevision);
            assert.strictEqual(await util.getInstalledSessSourceRevision(projectB), oldRevision);

            // Use the production identity checks, R invocation and VS Code task.
            const ready = await util.promptToInstallSessPackage(
                asUri ? vscode.Uri.file(projectB) : projectB, () => settings);

            assert.strictEqual(ready, true, JSON.stringify(errors.args));
            assert.strictEqual(errors.called, false);
            assert.strictEqual(await util.getInstalledSessSourceRevision(projectB), bundledRevision);
            assert.strictEqual(await util.getInstalledSessSourceRevision(projectA), oldRevision);
            // R may fold the installed DESCRIPTION field onto a continuation
            // line. The production R query above reads it through read.dcf().
            assert.strictEqual(await fs.pathExists(path.join(projectB, 'library', 'sess', 'Meta', 'package.rds')), true);
            assert.strictEqual(await fs.pathExists(path.join(projectA, 'library', 'sess', 'Meta')), false);
        }).timeout(120000);
    }
});
