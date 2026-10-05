import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LanguageService } from '../../languageService';
import * as session from '../../session';
import * as extension from '../../extension';

suite('Session package completion', () => {
    let sandbox: sinon.SinonSandbox;
    let service: LanguageService;
    let multiServer: boolean;
    const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
    const packages = (name: string) => ({ search: ['.GlobalEnv', `package:${name}`, 'package:base'], loaded_namespaces: [name, 'base'], globalenv: {} });

    // Keep the tests independent of installed R packages and server processes.
    type ServiceInternals = {
        startLanguageService(): Promise<void>;
        clients: Map<string, { sendRequest: sinon.SinonStub; stop: sinon.SinonStub }>;
        clientScopes: Map<string, string>;
    };
    function client(key: string, scope: string): sinon.SinonStub {
        const sendRequest = sandbox.stub().resolves(true);
        const internals = service as unknown as ServiceInternals;
        internals.clients.set(key, { sendRequest, stop: sandbox.stub().resolves() });
        internals.clientScopes.set(key, scope);
        return sendRequest;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        multiServer = false;
        sandbox.stub(LanguageService.prototype as unknown as ServiceInternals, 'startLanguageService').resolves();
        sandbox.stub(vscode.workspace, 'getConfiguration').returns({
            get: (key: string) => key === 'lsp.multiServer' ? multiServer : undefined
        } as vscode.WorkspaceConfiguration);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake(uri => uri.fsPath.startsWith('/project') ? folder : undefined);
        service = new LanguageService();
        sandbox.stub(extension, 'rLanguageService').value(service);
    });

    teardown(async () => {
        await service.dispose();
        sandbox.restore();
    });

    test('global server follows active packages and ignores duplicate updates', () => {
        const request = client('global', 'global');
        service.syncSessionState(packages('stats'), folder.uri, 'first');
        service.syncSessionState(packages('stats'), folder.uri, 'first');
        sinon.assert.calledOnceWithExactly(request, 'r/syncSessionState', {
            attachedPackages: ['stats', 'base'], loadedNamespaces: ['stats', 'base']
        });
        service.syncSessionState(packages('utils'), undefined, 'second');
        service.syncSessionState(undefined, folder.uri, 'first');
        assert.strictEqual(request.callCount, 2, 'closing an older session must not clear the active packages');
        service.syncSessionState(undefined, undefined, 'second');
        sinon.assert.calledWithExactly(request, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
    });

    test('multi-server mode separates workspace and unscoped documents', () => {
        multiServer = true;
        const project = client('project', folder.uri.toString(true));
        const untitled = client('untitled', 'unscoped');
        const externalFile = client('external', 'unscoped');
        service.syncSessionState(packages('stats'), folder.uri, 'project-session');
        sinon.assert.calledOnce(project);
        sinon.assert.notCalled(untitled);
        service.syncSessionState(packages('utils'), undefined, 'external-session');
        sinon.assert.calledOnce(project);
        sinon.assert.calledOnce(untitled);
        sinon.assert.calledOnce(externalFile);
    });

    test('inactive Interactive workspace updates reach only its bound language servers', () => {
        const global = client('global', 'global');
        const input = client('input', 'session:interactive-packages');
        const notebook = client('notebook', 'session:interactive-packages');
        const target = session.registerSessionTransport('interactive-packages', 'host', '/project', () => Promise.resolve(undefined));
        try {
            assert.strictEqual(target.resource?.toString(), folder.uri.toString());
            session.updateSessionWorkspace(target, packages('stats'));
            sinon.assert.notCalled(global);
            sinon.assert.calledOnce(input);
            sinon.assert.calledOnce(notebook);
            service.syncSessionState(packages('utils'), undefined, 'terminal');
            sinon.assert.calledOnce(input);
            sinon.assert.calledOnce(notebook);
            session.unregisterSessionTransport(target);
            sinon.assert.calledWithExactly(input, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
            sinon.assert.calledWithExactly(notebook, 'r/syncSessionState', { attachedPackages: [], loadedNamespaces: [] });
            sinon.assert.calledOnce(global);
        } finally {
            session.unregisterSessionTransport(target);
        }
    });
});
