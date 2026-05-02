import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

const extension_root: string = path.join(__dirname, '..', '..', '..');

suite('Sess Install Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let originalSessionWatcher: boolean | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
        originalSessionWatcher = vscode.workspace.getConfiguration('r').get<boolean>('sessionWatcher');
    });

    teardown(async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', originalSessionWatcher, vscode.ConfigurationTarget.Global);
        sandbox.restore();
    });

    test('promptToInstallSessPackage does nothing if sessionWatcher is disabled', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', false, vscode.ConfigurationTarget.Global);
        
        const getVersionStub = sandbox.stub(util, 'getRPackageVersion').resolves(undefined);
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage(undefined, undefined, getVersionStub);
        
        assert.strictEqual(getVersionStub.called, false);
        assert.strictEqual(showMessageStub.called, false);
    });

    test('promptToInstallSessPackage prompts to install if not installed', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getVersionStub = sandbox.stub(util, 'getRPackageVersion').resolves(undefined);
        
        // Mock reading DESCRIPTION file
        const readFileStub = sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage(undefined, undefined, getVersionStub, readFileStub);
        
        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('required for the session watcher to work'));
    });

    test('promptToInstallSessPackage prompts to update if installed version is older', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getVersionStub = sandbox.stub(util, 'getRPackageVersion').resolves('0.0.9');
        
        // Mock reading DESCRIPTION file with newer version
        const readFileStub = sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage(undefined, undefined, getVersionStub, readFileStub);
        
        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('A newer version of R package "sess" (0.1.0) is available'));
    });

    test('promptToInstallSessPackage does not prompt if installed version is newer or equal', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getVersionStub = sandbox.stub(util, 'getRPackageVersion').resolves('0.1.0');
        
        const readFileStub = sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage(undefined, undefined, getVersionStub, readFileStub);
        
        assert.strictEqual(showMessageStub.called, false);
    });

    test('sess package version matches extension version', () => {
        const packageJsonPath = path.join(extension_root, 'package.json');
        const descriptionPath = path.join(extension_root, 'sess', 'DESCRIPTION');
        
        const packageJsonContent = util.readFileSyncSafe(packageJsonPath);
        const descriptionContent = util.readFileSyncSafe(descriptionPath);
        
        assert.ok(packageJsonContent, 'package.json should be readable');
        assert.ok(descriptionContent, 'sess/DESCRIPTION should be readable');
        
        const packageJson = JSON.parse(packageJsonContent) as { version: string };
        const match = descriptionContent.match(/^Version:\s*(.+)$/m);
        const sessVersion = match ? match[1] : undefined;
        
        const baseVersion = packageJson.version.split('-')[0];
        assert.strictEqual(sessVersion, baseVersion, 'sess package version should match base extension version in package.json');
    });
});
