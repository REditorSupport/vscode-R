import * as assert from 'assert';
import cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('R command utilities', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
    });
    teardown(() => sandbox.restore());

    test('R literals escape quotes, backslashes and control characters', () => {
        assert.strictEqual(
            util.ToRStringLiteral('a"b\'c\\d\n\r\t\b\f\v', '"'),
            String.raw`"a\"b'c\\d\n\r\t\b\f\v"`,
        );
        assert.strictEqual(util.ToRStringLiteral('a"b\'c', "'"), String.raw`'a"b\'c'`);
        // Editor-path templates can supply either kind of surrounding quote.
        assert.strictEqual(util.ToRStringLiteral('a"b\'c', ''), String.raw`a\"b\'c`);
    });

    test('package installation creates a user library when the default is read-only', async function () {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            this.skip(); // Requires enforced POSIX write permissions.
        }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-install-'));
        const library = path.join(root, 'system');
        const userLibrary = path.join(root, 'user');
        const profile = path.join(root, '.Rprofile');
        fs.mkdirSync(library);
        try {
            fs.writeFileSync(
                profile,
                `
                .libPaths(${util.ToRStringLiteral(library, "'")}, include.site=FALSE)
                install.packages <- function(pkgs, lib=.libPaths()[1L], ...) {
                    stopifnot(pkgs == 'languageserver', dir.exists(lib), lib == Sys.getenv('R_LIBS_USER'))
                }
            `,
            );
            fs.chmodSync(library, 0o555);
            sandbox.stub(vscode.window, 'showErrorMessage').resolves('Yes' as never);
            const task = sandbox
                .stub(vscode.tasks, 'executeTask')
                .resolves({} as vscode.TaskExecution);
            sandbox.stub(vscode.tasks, 'onDidEndTask').returns(new vscode.Disposable(() => {}));
            await util.promptToInstallRPackage('languageserver', 'lsp.promptToInstall', root);
            assert.ok(task.calledOnce);
            const execution = task.firstCall.args[0].execution as vscode.ProcessExecution;
            const result = cp.spawnSync(execution.process, execution.args, {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, R_PROFILE_USER: profile, R_LIBS_USER: userLibrary },
            });
            assert.strictEqual(result.status, 0, result.stdout + result.stderr);
            assert.ok(fs.existsSync(userLibrary));
        } finally {
            fs.chmodSync(library, 0o755);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a failed executable settles with its spawn error', async () => {
        const result = await Promise.race([
            util.spawnAsync(path.join(os.tmpdir(), 'vscode-r-nonexistent-executable')),
            new Promise<undefined>((resolve) => setTimeout(resolve, 500)),
        ]);
        assert.ok(result, 'spawnAsync must finish when spawning fails');
        assert.strictEqual((result.error as NodeJS.ErrnoException).code, 'ENOENT');
        assert.notStrictEqual(result.status, 0);
    });

    test('collects all output through close and preserves fragmented UTF-8', async () => {
        const child = Object.assign(new EventEmitter(), {
            pid: 123,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: sandbox.stub(),
        });
        sandbox.stub(cp, 'spawn').returns(child as unknown as cp.ChildProcessWithoutNullStreams);
        const result = util.spawnAsync('R');
        const bytes = Buffer.from('你好');
        child.stdout.emit('data', bytes.subarray(0, 2));
        child.emit('exit', 0, null);
        child.stdout.emit('data', bytes.subarray(2));
        child.stderr.emit('data', Buffer.from('diagnostic'));
        child.emit('close', 0, null);
        assert.strictEqual((await result).stdout, '你好');
        assert.strictEqual((await result).stderr, 'diagnostic');
    });

    test('progress propagates synchronous callback exceptions', async () => {
        sandbox
            .stub(vscode.window, 'withProgress')
            .callsFake((_options, task) =>
                task({ report: () => undefined }, new vscode.CancellationTokenSource().token),
            );
        const clock = sandbox.useFakeTimers();
        const error = new Error('refresh failed');
        const result = util.doWithProgress(() => {
            throw error;
        });
        const rejected = assert.rejects(result, (candidate) => candidate === error);
        assert.doesNotThrow(() => clock.tick(1));
        await rejected;
    });
});
