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
        
        await util.promptToInstallSessPackage();
        
        assert.strictEqual(getVersionStub.called, false);
        assert.strictEqual(showMessageStub.called, false);
    });

    test('promptToInstallSessPackage prompts to install if not installed', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        sandbox.stub(util, 'getRPackageVersion').resolves(undefined);
        
        // Mock reading DESCRIPTION file
        sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage();
        
        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('required for the session watcher to work'));
    });

    test('promptToInstallSessPackage prompts to update if installed version is older', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        sandbox.stub(util, 'getRPackageVersion').resolves('0.0.9');
        
        // Mock reading DESCRIPTION file with newer version
        sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage();
        
        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('A newer version of R package "sess" (0.1.0) is available'));
    });

    test('promptToInstallSessPackage does not prompt if installed version is newer or equal', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        sandbox.stub(util, 'getRPackageVersion').resolves('0.1.0');
        
        sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        
        const showMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        
        await util.promptToInstallSessPackage();
        
        assert.strictEqual(showMessageStub.called, false);
    });
});
