import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as os from 'os';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

const stableRevision = 'git-tree:' + 'a'.repeat(40);
const preReleaseRevision = 'git-tree:' + 'b'.repeat(40);
const description = (version: string, revision: string) =>
    `Package: sess\nVersion: ${version}\nConfig/vscode-R/source-revision: ${revision}\n`;
const identity: util.SessRuntimeIdentity = { platform: 'x86_64-pc-linux-gnu', version: '4.4' };
const identityProvider = () => Promise.resolve(identity);
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

    async function enableSessionWatcher(): Promise<void> {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', true, vscode.ConfigurationTarget.Global);
    }

    function bundledDescription(revision = stableRevision) {
        return sandbox.stub(util, 'readFileSyncSafe').returns(description('0.1.0', revision));
    }

    function taskStub(): sinon.SinonStub<[string, string, string[], true, string?], Promise<void>> {
        return sinon.stub<[string, string, string[], true, string?], Promise<void>>().resolves();
    }

    test('does nothing when sessionWatcher is disabled', async () => {
        await vscode.workspace.getConfiguration('r').update('sessionWatcher', false, vscode.ConfigurationTarget.Global);
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision').resolves(undefined);
        const read = sandbox.stub(util, 'readFileSyncSafe');
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
        assert.strictEqual(installed.called, false);
        assert.strictEqual(read.called, false);
        assert.strictEqual(prompt.called, false);
        assert.strictEqual(task.called, false);
    });

    test('uses an exact source revision from a normal library without prompting or installing', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision').resolves(stableRevision);
        const read = bundledDescription();
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
        assert.strictEqual(installed.calledOnce, true);
        assert.deepStrictEqual(installed.firstCall.args, [undefined, stableRevision]);
        assert.strictEqual(prompt.called, false);
        assert.strictEqual(task.called, false);
    });

    test('uses an exact source revision already prepared in the managed library', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(undefined);
        installed.onSecondCall().resolves(stableRevision);
        const read = bundledDescription();
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
        assert.strictEqual(installed.calledTwice, true);
        assert.deepStrictEqual(installed.firstCall.args, [undefined, stableRevision]);
        assert.deepStrictEqual(installed.secondCall.args.slice(0, 2), [undefined, stableRevision]);
        assert.strictEqual(installed.secondCall.args[2], util.getSessManagedLibrary(
            path.join(os.tmpdir(), 'vscode-r-test-global-storage', String(process.pid), 'sess'), identity, stableRevision));
        assert.strictEqual(prompt.called, false);
        assert.strictEqual(task.called, false);
    });

    for (const answer of [undefined, 'No' as unknown as vscode.MessageItem]) {
        test(`declining installation (${answer === undefined ? 'dismiss' : 'No'}) leaves libraries untouched`, async () => {
            await enableSessionWatcher();
            const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
            installed.onFirstCall().resolves(undefined); // No exact revision in normal libraries.
            installed.onSecondCall().resolves(undefined); // No prepared managed copy.
            installed.onThirdCall().resolves(preReleaseRevision); // Existing, mismatched sess remains intact.
            const read = bundledDescription();
            const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(answer);
            const task = taskStub();

            assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
            assert.strictEqual(prompt.calledOnce, true);
            assert.match(prompt.firstCall.args[0], /vscode-R-managed library/);
            assert.match(prompt.firstCall.args[0], /existing installation will not be modified|existing sess installations will not be modified/);
            assert.strictEqual(task.called, false);
            assert.strictEqual(installed.callCount, 3);
        });
    }

    test('asks before installing a missing sess and targets only the managed library', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(undefined); // Normal libraries have no exact revision.
        installed.onSecondCall().resolves(undefined); // Managed library is not prepared yet.
        installed.onThirdCall().resolves(undefined); // No sess exists in normal libraries.
        installed.onCall(3).resolves(stableRevision); // Verify the installed managed copy by exact revision.
        const read = bundledDescription();
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
        assert.strictEqual(prompt.calledOnce, true);
        assert.match(prompt.firstCall.args[0], /vscode-R needs its bundled sess package/);
        assert.match(prompt.firstCall.args[0], /vscode-R-managed library/);
        assert.match(prompt.firstCall.args[0], /existing sess installations will not be modified/);
        assert.strictEqual(task.calledOnce, true);
        const args = task.firstCall.args;
        assert.strictEqual(args[0], 'Install "sess" package');
        assert.ok(args[1]);
        assert.ok(args[2].includes(`--file=${path.join(extension_root, 'R', 'install_sess.R').replace(/\\/g, '/')}`));
        const managedLibrary = installed.getCall(1).args[2];
        assert.ok(managedLibrary);
        assert.strictEqual(args[2].at(-1), managedLibrary);
        assert.ok(managedLibrary.includes(identity.platform));
        assert.ok(managedLibrary.includes(identity.version));
        assert.ok(managedLibrary.includes(stableRevision.slice('git-tree:'.length)));
        assert.deepStrictEqual(installed.getCall(3).args, [undefined, stableRevision, managedLibrary]);
        assert.strictEqual(errors.called, false);
    });

    for (const [installedRevision, bundledRevision] of [
        [preReleaseRevision, stableRevision],
        [stableRevision, preReleaseRevision]
    ]) {
        test(`prompts for a ${installedRevision === stableRevision ? 'stable to pre-release' : 'pre-release to stable'} revision change`, async () => {
            await enableSessionWatcher();
            const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
            installed.onFirstCall().resolves(undefined);
            installed.onSecondCall().resolves(undefined);
            installed.onThirdCall().resolves(installedRevision);
            const read = bundledDescription(bundledRevision);
            const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            const task = taskStub();

            assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), true);
            assert.strictEqual(prompt.calledOnce, true);
            assert.match(prompt.firstCall.args[0], /does not match this build/);
            assert.match(prompt.firstCall.args[0], /vscode-R-managed library/);
            assert.strictEqual(task.called, false);
        });
    }

    test('invalid bundled metadata reports a build problem without offering installation', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        const read = sandbox.stub(util, 'readFileSyncSafe').returns('Package: sess\nVersion: 0.1.0\n');
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), false);
        assert.strictEqual(installed.called, false);
        assert.match(errors.firstCall.args[0], /Rebuild or reinstall/);
        assert.strictEqual(prompt.called, false);
        assert.strictEqual(task.called, false);
    });

    test('waits for installation and verifies the exact managed source revision', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(undefined);
        installed.onSecondCall().resolves(undefined);
        installed.onThirdCall().resolves(preReleaseRevision);
        installed.onCall(3).resolves(preReleaseRevision);
        const read = bundledDescription(preReleaseRevision);
        sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        let finishTask!: () => void;
        const taskFinished = new Promise<void>(resolve => { finishTask = resolve; });
        let taskStarted!: () => void;
        const started = new Promise<void>(resolve => { taskStarted = resolve; });
        const task = sinon.stub<[string, string, string[], true, string?], Promise<void>>().callsFake(() => {
            taskStarted();
            return taskFinished;
        });

        let completed = false;
        const setup = util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider).then(result => {
            completed = true;
            return result;
        });
        await started;
        assert.strictEqual(completed, false);
        assert.strictEqual(installed.calledThrice, true);
        finishTask();
        assert.strictEqual(await setup, true);
        assert.strictEqual(installed.callCount, 4);
        assert.strictEqual(installed.getCall(3).args[1], preReleaseRevision);
        assert.strictEqual(installed.getCall(3).args[2], task.firstCall.args[2].at(-1));
        assert.strictEqual(errors.called, false);
    });

    test('failed installation and ineffective managed installs prevent startup', async () => {
        await enableSessionWatcher();
        const installed = sandbox.stub(util, 'getInstalledSessSourceRevision');
        installed.onFirstCall().resolves(undefined);
        installed.onSecondCall().resolves(undefined);
        installed.onThirdCall().resolves(preReleaseRevision);
        installed.onCall(3).resolves(undefined); // Task ended, but exact managed revision is still absent.
        const read = bundledDescription();
        sandbox.stub(vscode.window, 'showWarningMessage').resolves('Yes' as unknown as vscode.MessageItem);
        const errors = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const task = taskStub();

        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, task, identityProvider), false);
        assert.match(errors.firstCall.args[0], /not installed successfully/);
        assert.deepStrictEqual(installed.getCall(3).args.slice(0, 2), [undefined, stableRevision]);

        const failingTask = taskStub().rejects(new Error('Could not start installation task'));
        installed.onCall(4).resolves(undefined);
        installed.onCall(5).resolves(undefined);
        installed.onCall(6).resolves(preReleaseRevision);
        assert.strictEqual(await util.promptToInstallSessPackage(undefined, undefined, installed, read, failingTask, identityProvider), false);
        assert.match(errors.secondCall.args[0], /Could not start installation task/);
    }).timeout(15000);

    test('managed library path layout matches the platform, R version, and revision on common platforms', () => {
        const managedRoot = '/managed root/sess';
        const revisionHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const cases = [
            [{ platform: 'x86_64-w64-mingw32', version: '4.5' }, `x86_64-w64-mingw32/4.5/${revisionHash}/library`],
            [{ platform: 'aarch64-apple-darwin20', version: '4.5' }, `aarch64-apple-darwin20/4.5/${revisionHash}/library`],
            [{ platform: 'x86_64-pc-linux-gnu', version: '4.5' }, `x86_64-pc-linux-gnu/4.5/${revisionHash}/library`],
        ] as const;
        const normalize = (value: string) => value.replace(/\\/g, '/');

        for (const [runtimeIdentity, expectedSuffix] of cases) {
            const library = util.getSessManagedLibrary(managedRoot, runtimeIdentity, stableRevision);
            assert.strictEqual(normalize(library), `${normalize(managedRoot)}/${expectedSuffix}`);
        }
    });

    test('source revision parsing validates metadata and handles CRLF', () => {
        assert.strictEqual(util.readSessSourceRevision(description('9.0.0', stableRevision).replace(/\n/g, '\r\n')), stableRevision);
        for (const value of ['', 'unknown', 'git-tree:123', 'git-tree:' + 'A'.repeat(40)]) {
            assert.strictEqual(util.readSessSourceRevision(description('0.1.0', value)), undefined);
        }
    });
});
