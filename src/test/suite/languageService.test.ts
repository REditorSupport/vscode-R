import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { LanguageService } from '../../languageService';
import { connectTcpLanguageServer } from '../../languageServerTransport';
import * as util from '../../util';

suite('Language service startup lifecycle', () => {
    let sandbox: sinon.SinonSandbox;
    let appendLine: sinon.SinonStub;
    const prototype = LanguageService.prototype as unknown as {
        createClient: () => Promise<LanguageClient>;
        startMultiLanguageService: () => void;
        spawnServer: (
            client: LanguageClient,
            executable: string,
            args: string[],
            options: { cwd: string },
        ) => util.DisposableProcess;
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        appendLine = sandbox.stub();
        sandbox.stub(vscode.window, 'createOutputChannel').returns({
            appendLine,
        } as unknown as vscode.LogOutputChannel);
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: () => false,
        } as unknown as vscode.WorkspaceConfiguration);
    });
    teardown(() => sandbox.restore());

    test('an initial startup rejection is logged and does not block disposal', async () => {
        sandbox.stub(prototype, 'createClient').rejects(new Error('R exited before connecting'));
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const service = new LanguageService();
        await service.dispose();
        sinon.assert.calledWithMatch(appendLine, 'Failed to start language server:');
        sinon.assert.notCalled(register);
    });

    test('disposal during startup stops the eventual client without registering listeners', async () => {
        let finish!: (client: LanguageClient) => void;
        sandbox.stub(prototype, 'createClient').returns(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const stop = sandbox.stub().resolves();
        const service = new LanguageService();
        const disposal = service.dispose();
        finish({ stop } as unknown as LanguageClient);
        await disposal;
        sinon.assert.calledOnce(stop);
        sinon.assert.notCalled(register);
    });

    test('disposal cancels TCP startup while R remains alive without connecting', async () => {
        const disposeChild = sandbox.stub();
        const child = Object.assign(new EventEmitter(), {
            dispose: disposeChild,
        }) as unknown as util.DisposableProcess;
        let started!: () => void;
        const listening = new Promise<void>((resolve) => {
            started = resolve;
        });
        sandbox.stub(prototype, 'createClient').callsFake(function (this: LanguageService) {
            const cancellation = (this as unknown as { startupCancellation: AbortController })
                .startupCancellation;
            return connectTcpLanguageServer(() => {
                started();
                return child;
            }, cancellation.signal).then(() => {
                throw new Error('R never connected');
            });
        });
        const register = sandbox.stub(prototype, 'startMultiLanguageService');
        const service = new LanguageService();
        await listening;
        await service.dispose();
        sinon.assert.calledOnce(disposeChild);
        sinon.assert.notCalled(register);
    });

    test('a missing package still prompts for installation without stopping a starting client', () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        }) as unknown as util.DisposableProcess;
        sandbox.stub(util, 'spawn').returns(child);
        const install = sandbox.stub(util, 'promptToInstallRPackage').resolves();
        const stop = sandbox.stub().resolves();
        const client = {
            outputChannel: { appendLine, show: sandbox.stub() },
            isRunning: () => false,
            stop,
        } as unknown as LanguageClient;
        prototype.spawnServer(client, 'R', [], { cwd: '/project' });
        child.emit('exit', 10, null);
        sinon.assert.calledOnce(install);
        assert.strictEqual(install.firstCall.args[0], 'languageserver');
        sinon.assert.notCalled(stop);
    });

    test('a rejected stop after R exits is logged', async () => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
        }) as unknown as util.DisposableProcess;
        sandbox.stub(util, 'spawn').returns(child);
        const client = {
            outputChannel: { appendLine },
            isRunning: () => true,
            stop: sandbox.stub().rejects(new Error('shutdown failed')),
        } as unknown as LanguageClient;
        prototype.spawnServer(client, 'R', [], { cwd: '/project' });
        child.emit('exit', 0, null);
        await Promise.resolve();
        sinon.assert.calledWithMatch(
            appendLine,
            'Failed to stop language server: Error: shutdown failed',
        );
    });
});
