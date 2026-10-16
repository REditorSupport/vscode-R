import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LanguageService } from '../../languageService';
import * as session from '../../session';
import * as extension from '../../extension';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('Session package completion', () => {
    let sandbox: sinon.SinonSandbox;
    let service: LanguageService;
    let multiServer: boolean;
    const folder = { uri: vscode.Uri.file(path.join(os.tmpdir(), 'vscode-r-language-service', 'project')), name: 'project', index: 0 };
    const packages = (name: string) => ({ search: ['.GlobalEnv', `package:${name}`, 'package:base'], loaded_namespaces: [name, 'base'], globalenv: {} });

    // Keep the tests independent of installed R packages and server processes.
    type ServiceInternals = {
        startLanguageService(): Promise<void>;
        createClient(key: string, selector: vscode.DocumentFilter[], cwd: string,
            workspaceFolder: vscode.WorkspaceFolder | undefined, outputChannel: vscode.LogOutputChannel,
            resource?: vscode.Uri, sessionScope?: string): Promise<LanguageClient>;
        registerClient(key: string, client: { sendRequest: sinon.SinonStub; stop: sinon.SinonStub }, scope: string): Promise<void>;
        syncClientSessionState(key: string, force?: boolean): Promise<void>;
        clients: Map<string, { sendRequest: sinon.SinonStub; stop: sinon.SinonStub }>;
        clientScopes: Map<string, string>;
        outputChannel: vscode.LogOutputChannel;
    };
    function client(key: string, scope: string): sinon.SinonStub {
        const sendRequest = sandbox.stub().resolves(true);
        const internals = service as unknown as ServiceInternals;
        internals.clients.set(key, { sendRequest, stop: sandbox.stub().resolves() });
        internals.clientScopes.set(key, scope);
        return sendRequest;
    }

    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    function deferred() {
        let resolve!: (value: boolean) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.join(__dirname, '..', '..', '..'), sandbox);
        multiServer = false;
        sandbox.stub(LanguageService.prototype as unknown as ServiceInternals, 'startLanguageService').resolves();
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string) => key === 'lsp.multiServer' ? multiServer : undefined
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake(uri =>
            uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`)
                ? folder
                : undefined);
        service = new LanguageService();
        sandbox.stub(extension, 'rLanguageService').value(service);
    });

    teardown(async () => {
        await service.dispose();
        sandbox.restore();
    });

    test('global server follows active packages and ignores duplicate updates', async () => {
        const request = client('global', 'global');
        service.syncSessionState(packages('stats'), folder.uri, 'first');
        service.syncSessionState(packages('stats'), folder.uri, 'first');
        await settle();
        sinon.assert.calledOnceWithExactly(request, 'r/syncSessionState', {
            attachedPackages: ['stats', 'base'], loadedNamespaces: ['stats', 'base']
        });
        service.syncSessionState(packages('utils'), undefined, 'second');
        service.syncSessionState(undefined, folder.uri, 'first');
        await settle();
        assert.strictEqual(request.callCount, 2, 'closing an older session must not clear the active packages');
        service.syncSessionState(undefined, undefined, 'second');
        await settle();
        sinon.assert.calledWithExactly(request, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
    });

    test('client receives session updates while initial synchronization is pending', async () => {
        let resolveInitial!: () => void;
        const initial = new Promise<void>(resolve => { resolveInitial = resolve; });
        const request = sandbox.stub();
        request.onFirstCall().returns(initial);
        request.resolves(true);
        const fakeClient = { sendRequest: request, stop: sandbox.stub().resolves() };
        const internals = service as unknown as ServiceInternals;

        service.syncSessionState({
            search: ['.GlobalEnv', 'package:base'],
            loaded_namespaces: ['base'],
        }, folder.uri, 'session');

        const registering = internals.registerClient('global', fakeClient, 'global');
        await Promise.resolve();

        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        sinon.assert.calledOnceWithExactly(request, 'r/syncSessionState', {
            attachedPackages: ['base'], loadedNamespaces: ['base']
        });

        resolveInitial();
        await registering;
        sinon.assert.calledWithExactly(request, 'r/syncSessionState', {
            attachedPackages: ['dplyr', 'base'], loadedNamespaces: ['dplyr', 'base']
        });
        sinon.assert.calledTwice(request);
    });

    test('global server replays current packages after workspace folders change', async () => {
        sandbox.stub(util, 'getRpath').resolves('/usr/bin/R');
        sandbox.stub(LanguageClient.prototype, 'start').resolves();
        const request = sandbox.stub(LanguageClient.prototype, 'sendRequest').resolves(true);
        const internals = service as unknown as ServiceInternals;
        const client = await internals.createClient(
            'global', [{ scheme: 'file', language: 'r' }], folder.uri.fsPath,
            undefined, internals.outputChannel, folder.uri, 'global'
        );

        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        request.resetHistory();

        const middleware = client.middleware.workspace?.didChangeWorkspaceFolders;
        assert.ok(middleware);
        const event = { added: [folder], removed: [] };
        const next = sandbox.stub().resolves();
        await middleware(event, next);

        sinon.assert.calledOnceWithExactly(next, event);
        sinon.assert.calledOnceWithExactly(request, 'r/syncSessionState', {
            attachedPackages: ['dplyr', 'base'], loadedNamespaces: ['dplyr', 'base']
        });
        sinon.assert.callOrder(next, request);
    });

    test('completion retries failed session synchronization before requesting suggestions', async () => {
        sandbox.stub(util, 'getRpath').resolves('/usr/bin/R');
        sandbox.stub(LanguageClient.prototype, 'start').resolves();
        const request = sandbox.stub(LanguageClient.prototype, 'sendRequest').resolves(true);
        request.onFirstCall().rejects(new Error('transient failure'));
        const retry = deferred();
        request.onSecondCall().returns(retry.promise);
        const internals = service as unknown as ServiceInternals;
        const client = await internals.createClient(
            'global', [{ scheme: 'file', language: 'r' }], folder.uri.fsPath,
            undefined, internals.outputChannel, folder.uri, 'global'
        );
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        sinon.assert.calledOnce(request);

        const middleware = client.middleware.provideCompletionItem;
        assert.ok(middleware);
        const document = { uri: folder.uri } as vscode.TextDocument;
        const position = new vscode.Position(0, 0);
        const context = { triggerKind: vscode.CompletionTriggerKind.Invoke, triggerCharacter: undefined };
        const next = sandbox.stub().resolves([]);
        const cancellation = new vscode.CancellationTokenSource();
        try {
            const completing = middleware(document, position, context, cancellation.token, next);
            sinon.assert.calledTwice(request);
            await Promise.resolve();
            sinon.assert.notCalled(next);
            retry.resolve(true);
            await completing;
            sinon.assert.calledOnceWithExactly(next, document, position, context, cancellation.token);
            await middleware(document, position, context, cancellation.token, next);
            sinon.assert.calledTwice(request);
        } finally {
            cancellation.dispose();
        }
    });

    test('multi-server mode separates workspace and unscoped documents', async () => {
        multiServer = true;
        const project = client('project', folder.uri.toString(true));
        const untitled = client('untitled', 'unscoped');
        const externalFile = client('external', 'unscoped');
        service.syncSessionState(packages('stats'), folder.uri, 'project-session');
        await settle();
        sinon.assert.calledOnce(project);
        sinon.assert.notCalled(untitled);
        service.syncSessionState(packages('utils'), undefined, 'external-session');
        await settle();
        sinon.assert.calledOnce(project);
        sinon.assert.calledOnce(untitled);
        sinon.assert.calledOnce(externalFile);
    });

    test('inactive Interactive workspace updates reach only its bound language servers', async () => {
        const global = client('global', 'global');
        const input = client('input', 'session:interactive-packages');
        const notebook = client('notebook', 'session:interactive-packages');
        const target = session.registerSessionTransport('interactive-packages', 'host', folder.uri.fsPath, () => Promise.resolve(undefined));
        try {
            assert.strictEqual(target.resource?.toString(), folder.uri.toString());
            session.updateSessionWorkspace(target, packages('stats'));
            await settle();
            sinon.assert.notCalled(global);
            sinon.assert.calledOnce(input);
            sinon.assert.calledOnce(notebook);
            service.syncSessionState(packages('utils'), undefined, 'terminal');
            await settle();
            sinon.assert.calledOnce(input);
            sinon.assert.calledOnce(notebook);
            session.unregisterSessionTransport(target);
            await settle();
            sinon.assert.calledWithExactly(input, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
            sinon.assert.calledWithExactly(notebook, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
            sinon.assert.calledOnce(global);
        } finally {
            session.unregisterSessionTransport(target);
        }
    });

    test('unchanged refresh retries only the client whose synchronization failed', async () => {
        const healthy = client('healthy', 'global');
        const failed = client('failed', 'global');
        failed.onFirstCall().rejects(new Error('transient failure'));
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        sinon.assert.calledOnce(failed);

        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        sinon.assert.calledOnce(healthy);
        sinon.assert.calledTwice(failed);
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        sinon.assert.calledTwice(failed);
    });

    test('disconnect during initial synchronization replaces queued packages with a clear', async () => {
        const initial = deferred();
        const request = client('global', 'global');
        request.onFirstCall().returns(initial.promise);
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        service.syncSessionState(undefined, folder.uri, 'session');
        sinon.assert.calledOnce(request);
        initial.resolve(true);
        await settle();
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.lastCall.args, ['r/syncSessionState', {
            attachedPackages: [], loadedNamespaces: []
        }]);
    });

    test('failed disconnect clear is retained for the next synchronization attempt', async () => {
        const request = client('global', 'global');
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        await settle();
        request.onSecondCall().rejects(new Error('clear failed'));
        service.syncSessionState(undefined, folder.uri, 'session');
        await settle();
        sinon.assert.calledTwice(request);
        await (service as unknown as ServiceInternals).syncClientSessionState('global');
        sinon.assert.calledThrice(request);
        assert.deepStrictEqual(request.lastCall.args, ['r/syncSessionState', {
            attachedPackages: [], loadedNamespaces: []
        }]);
    });

    test('failed synchronization still delivers newer pending state', async () => {
        const initial = deferred();
        const request = client('global', 'global');
        request.onFirstCall().returns(initial.promise);
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        initial.reject(new Error('initial sync failed'));
        await settle();
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.lastCall.args[1], {
            attachedPackages: ['dplyr', 'base'], loadedNamespaces: ['dplyr', 'base']
        });
    });

    test('returning to previously acknowledged packages restores them after an in-flight change', async () => {
        const request = client('global', 'global');
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        await settle();
        const changing = deferred();
        request.onSecondCall().returns(changing.promise);
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        changing.resolve(true);
        await settle();
        sinon.assert.calledThrice(request);
        assert.deepStrictEqual(request.lastCall.args[1], {
            attachedPackages: ['stats', 'base'], loadedNamespaces: ['stats', 'base']
        });
    });

    test('updates arriving as a request settles are not lost', async () => {
        const initial = deferred();
        const request = client('global', 'global');
        request.onFirstCall().returns(initial.promise);
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        void initial.promise.then(() => service.syncSessionState(packages('dplyr'), folder.uri, 'session'));
        initial.resolve(true);
        await settle();
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.lastCall.args[1], {
            attachedPackages: ['dplyr', 'base'], loadedNamespaces: ['dplyr', 'base']
        });
    });

    test('replacement client receives current state without replaying updates to the old client', async () => {
        const initial = deferred();
        const old = client('global', 'global');
        old.onFirstCall().returns(initial.promise);
        service.syncSessionState(packages('stats'), folder.uri, 'session');
        const replacement = client('global', 'global');
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        initial.resolve(true);
        await settle();
        sinon.assert.calledOnce(old);
        sinon.assert.calledOnce(replacement);
        assert.deepStrictEqual(replacement.firstCall.args[1], {
            attachedPackages: ['dplyr', 'base'], loadedNamespaces: ['dplyr', 'base']
        });
    });

    test('workspace replay during an in-flight sync sends the state again after it completes', async () => {
        const initial = deferred();
        const request = client('global', 'global');
        request.onFirstCall().returns(initial.promise);
        service.syncSessionState(packages('dplyr'), folder.uri, 'session');
        const replay = (service as unknown as ServiceInternals).syncClientSessionState('global', true);
        initial.resolve(true);
        await replay;
        sinon.assert.calledTwice(request);
        assert.deepStrictEqual(request.firstCall.args, request.lastCall.args);
    });
});
