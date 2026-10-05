import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

const stableRevision = 'git-tree:' + 'a'.repeat(40);
const preReleaseRevision = 'git-tree:' + 'b'.repeat(40);
const description = (version: string, revision: string) =>
    `Package: sess\nVersion: ${version}\nConfig/vscode-R/source-revision: ${revision}\n`;

const extension_root: string = path.join(__dirname, '..', '..', '..');

suite('Sess Install Test Suite', () => {
    let sandbox: sinon.SinonSandbox;
    let originalSessionWatcher: boolean | undefined;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
        originalSessionWatcher = vscode.workspace
            .getConfiguration('r')
            .get<boolean>('sessionWatcher');
    });

    teardown(async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', originalSessionWatcher, vscode.ConfigurationTarget.Global);
        sandbox.restore();
    });

    test('promptToInstallSessPackage does nothing if sessionWatcher is disabled', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', false, vscode.ConfigurationTarget.Global);

        const getRevisionStub = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(undefined);
        const showMessageStub = sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves(undefined);

        await util.promptToInstallSessPackage(undefined, undefined, getRevisionStub);

        assert.strictEqual(getRevisionStub.called, false);
        assert.strictEqual(showMessageStub.called, false);
    });

    test('promptToInstallSessPackage prompts to install if not installed', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getRevisionStub = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(undefined);

        // Mock reading DESCRIPTION file
        const readFileStub = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', stableRevision));

        const showMessageStub = sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves(undefined);

        assert.strictEqual(
            await util.promptToInstallSessPackage(
                undefined,
                undefined,
                getRevisionStub,
                readFileStub,
            ),
            true,
        );

        assert.strictEqual(
            readFileStub.firstCall.args[0],
            path.join(extension_root, 'dist', 'resources', 'sess', 'DESCRIPTION'),
        );
        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('required for the session watcher to work'));
        assert.deepStrictEqual(args.slice(1), ['Yes', 'No']);
    });

    test('promptToInstallSessPackage prompts when switching pre-release to stable', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getRevisionStub = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(preReleaseRevision);

        // Package version ordering has no role in the source comparison.
        const readFileStub = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', stableRevision));

        const showMessageStub = sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves('No' as unknown as vscode.MessageItem);
        const task = sinon.stub<[string, string, string[], true], Promise<void>>().resolves();

        assert.strictEqual(
            await util.promptToInstallSessPackage(
                undefined,
                undefined,
                getRevisionStub,
                readFileStub,
                task,
            ),
            true,
        );
        assert.strictEqual(task.called, false);

        assert.strictEqual(showMessageStub.calledOnce, true);
        const args = showMessageStub.getCall(0).args;
        assert.ok(args[0].includes('does not match this build'));
        assert.ok(!args[0].includes('newer'));
    });

    test('promptToInstallSessPackage does not prompt for the same source revision', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const getRevisionStub = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(stableRevision);

        const readFileStub = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', stableRevision));

        const showMessageStub = sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves(undefined);

        await util.promptToInstallSessPackage(undefined, undefined, getRevisionStub, readFileStub);

        assert.strictEqual(showMessageStub.called, false);
    });

    test('stable to pre-release with the same package version prompts', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const installed = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(stableRevision);
        const read = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', preReleaseRevision));
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        await util.promptToInstallSessPackage(undefined, undefined, installed, read);
        assert.strictEqual(prompt.calledOnce, true);
    });

    test('legacy packages without source metadata prompt once, then matching metadata skips', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(undefined);
        installed.onSecondCall().resolves(stableRevision);
        const read = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', stableRevision));
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        await util.promptToInstallSessPackage(undefined, undefined, installed, read);
        await util.promptToInstallSessPackage(undefined, undefined, installed, read);
        assert.strictEqual(prompt.calledOnce, true);
    });

    test('invalid bundled metadata reports a build problem without offering installation', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const installed = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(stableRevision);
        const read = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns('Package: sess\nVersion: 0.1.0\n');
        const prompt = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        assert.strictEqual(
            await util.promptToInstallSessPackage(undefined, undefined, installed, read),
            false,
        );
        assert.strictEqual(installed.called, false);
        assert.match(prompt.firstCall.args[0], /Rebuild or reinstall/);
        assert.strictEqual(prompt.firstCall.args.length, 1);
    });

    test('requested installation waits for the task and verifies the installed source', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(stableRevision);
        installed.onSecondCall().resolves(preReleaseRevision);
        const read = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', preReleaseRevision));
        sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves('Yes' as unknown as vscode.MessageItem);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        let finishTask!: () => void;
        const taskFinished = new Promise<void>((resolve) => {
            finishTask = resolve;
        });
        let taskStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            taskStarted = resolve;
        });
        const task = sinon.stub<[string, string, string[], true], Promise<void>>().callsFake(() => {
            taskStarted();
            return taskFinished;
        });
        let completed = false;
        const setup = util
            .promptToInstallSessPackage(undefined, undefined, installed, read, task)
            .then((result) => {
                completed = true;
                return result;
            });
        await started;
        assert.strictEqual(completed, false);
        assert.strictEqual(installed.calledOnce, true);
        finishTask();
        assert.strictEqual(await setup, true);
        assert.strictEqual(installed.calledTwice, true);
        assert.strictEqual(errors.called, false);
        assert.ok(
            task.firstCall.args[2].includes(
                path.join(extension_root, 'dist', 'resources', 'sess').replace(/\\/g, '/'),
            ),
        );
        assert.ok(
            task.firstCall.args[2].includes(
                `--file=${path.join(extension_root, 'R', 'install_sess.R').replace(/\\/g, '/')}`,
            ),
        );
    }).timeout(15000);

    test('failed or ineffective installation prevents startup and reports an error', async () => {
        await vscode.workspace
            .getConfiguration('r')
            .update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
        const installed = sandbox
            .stub(util, 'getInstalledSessSourceRevision')
            .resolves(stableRevision);
        const read = sandbox
            .stub(util, 'readFileSyncSafe')
            .returns(description('0.1.0', preReleaseRevision));
        sandbox
            .stub(vscode.window, 'showWarningMessage')
            .resolves('Yes' as unknown as vscode.MessageItem);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const task = sinon.stub<[string, string, string[], true], Promise<void>>();
        task.onFirstCall().resolves();
        task.onSecondCall().rejects(new Error('Could not start installation task'));
        assert.strictEqual(
            await util.promptToInstallSessPackage(undefined, undefined, installed, read, task),
            false,
        );
        assert.match(errors.firstCall.args[0], /not installed successfully/);
        assert.strictEqual(
            await util.promptToInstallSessPackage(undefined, undefined, installed, read, task),
            false,
        );
        assert.match(errors.secondCall.args[0], /Could not start installation task/);
    }).timeout(15000);

    test('source revision parsing validates metadata and handles CRLF', () => {
        assert.strictEqual(
            util.readSessSourceRevision(
                description('9.0.0', stableRevision).replace(/\n/g, '\r\n'),
            ),
            stableRevision,
        );
        for (const value of ['', 'unknown', 'git-tree:123', 'git-tree:' + 'A'.repeat(40)]) {
            assert.strictEqual(util.readSessSourceRevision(description('0.1.0', value)), undefined);
        }
    });
});
