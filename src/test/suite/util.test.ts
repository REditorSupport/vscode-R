import * as assert from 'assert';
import cp from 'child_process';
import { EventEmitter } from 'events';
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

    test('in-memory help state preserves falsy values and supports key deletion', async () => {
        const state = new util.DummyMemento();
        for (const value of [false, 0, '', null]) {
            await state.update('cached', value);
            assert.strictEqual(state.get('cached', 'fallback'), value);
            assert.deepStrictEqual(state.keys(), ['cached']);
        }
        await state.update('cached', undefined);
        assert.strictEqual(state.get('cached', 'fallback'), 'fallback');
        assert.deepStrictEqual(state.keys(), []);
    });

    test('R literals escape quotes, backslashes and control characters', () => {
        assert.strictEqual(
            util.ToRStringLiteral('a"b\'c\\d\n\r\t\b\f\v', '"'),
            String.raw`"a\"b'c\\d\n\r\t\b\f\v"`,
        );
        assert.strictEqual(util.ToRStringLiteral('a"b\'c', "'"), String.raw`'a"b\'c'`);
        // Editor-path templates can supply either kind of surrounding quote.
        assert.strictEqual(util.ToRStringLiteral('a"b\'c', ''), String.raw`a\"b\'c`);
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
