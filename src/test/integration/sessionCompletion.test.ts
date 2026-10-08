import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { LanguageService } from '../../languageService';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('Session completion with real R language server', () => {
    test('new workspace folders receive packages and disconnect restores default completions', async () => {
        const sandbox = sinon.createSandbox();
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r session completion '));
        let service: LanguageService | undefined;
        let client: LanguageClient | undefined;
        try {
            const rPath = await util.getRpathFromSystem();
            assert.ok(rPath, 'R must be installed to run the language server integration test');
            mockExtensionContext(path.join(__dirname, '..', '..', '..'), sandbox);
            type ServiceInternals = {
                startLanguageService(): Promise<void>;
                createClient(key: string, selector: vscode.DocumentFilter[], cwd: string,
                    workspaceFolder: vscode.WorkspaceFolder | undefined, outputChannel: vscode.LogOutputChannel,
                    resource?: vscode.Uri, sessionScope?: string): Promise<LanguageClient>;
                syncClientSessionState(key: string): Promise<void>;
                outputChannel: vscode.LogOutputChannel;
            };
            sandbox.stub(LanguageService.prototype as unknown as ServiceInternals, 'startLanguageService').resolves();
            sandbox.stub(util, 'getRpath').resolves(rPath);
            const settings = { get: (key: string) => {
                if (key === 'lsp.args') { return ['--vanilla']; }
                if (key === 'lsp.lang') { return ''; }
                return undefined;
            } } as vscode.WorkspaceConfiguration;
            const getConfiguration = vscode.workspace.getConfiguration;
            sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section, resource) =>
                section === 'r' ? settings : getConfiguration(section, resource));
            service = new LanguageService();
            const internals = service as unknown as ServiceInternals;
            client = await internals.createClient('global', [{ scheme: 'file', language: 'r' }],
                root, undefined, internals.outputChannel, undefined, 'global');
            const languageClient = client;
            const middleware = client.middleware.workspace?.didChangeWorkspaceFolders;
            assert.ok(middleware);
            const protocolUri = (uri: vscode.Uri) => languageClient.code2ProtocolConverter.asUri(uri);
            const documentUri = (folder: vscode.WorkspaceFolder) => protocolUri(vscode.Uri.joinPath(folder.uri, 'completion.R'));

            const projects: vscode.WorkspaceFolder[] = [];
            for (const name of ['initial project', 'added project']) {
                const directory = path.join(root, name);
                await fs.ensureDir(directory);
                await fs.writeFile(path.join(directory, 'completion.R'), 'bs');
                projects.push({ uri: vscode.Uri.file(directory), name, index: projects.length });
            }
            const addFolder = (folder: vscode.WorkspaceFolder) => middleware({ added: [folder], removed: [] },
                event => languageClient.sendNotification('workspace/didChangeWorkspaceFolders', {
                    event: {
                        added: event.added.map(folder => ({ uri: protocolUri(folder.uri), name: folder.name })),
                        removed: []
                    }
                }));
            const openDocument = (folder: vscode.WorkspaceFolder) => languageClient.sendNotification('textDocument/didOpen', {
                textDocument: {
                    uri: documentUri(folder),
                    languageId: 'r', version: 1, text: 'bs'
                }
            });
            type Completion = { label: string; data?: { package?: string } };
            const hasSplineCompletion = async (folder: vscode.WorkspaceFolder) => {
                const response = await languageClient.sendRequest<Completion[] | { items: Completion[] } | null>(
                    'textDocument/completion', {
                        textDocument: { uri: documentUri(folder) },
                        position: { line: 0, character: 2 }
                    });
                return (Array.isArray(response) ? response : response?.items ?? [])
                    .some(item => item.label === 'bs' && item.data?.package === 'splines');
            };

            await addFolder(projects[0]);
            await openDocument(projects[0]);
            assert.strictEqual(await hasSplineCompletion(projects[0]), false, 'splines is not attached by default');
            service.syncSessionState({ search: ['package:splines', 'package:base'], loaded_namespaces: ['splines', 'base'] },
                projects[0].uri, 'session');
            await internals.syncClientSessionState('global');
            assert.strictEqual(await hasSplineCompletion(projects[0]), true, 'initial workspace receives session packages');

            await addFolder(projects[1]);
            await openDocument(projects[1]);
            assert.strictEqual(await hasSplineCompletion(projects[1]), true, 'new workspace receives replayed session packages');

            service.syncSessionState(undefined, projects[0].uri, 'session');
            await internals.syncClientSessionState('global');
            for (const project of projects) {
                assert.strictEqual(await hasSplineCompletion(project), false, 'disconnect removes session-only completions');
            }
        } finally {
            try {
                await service?.dispose();
                await client?.dispose();
            } finally {
                sandbox.restore();
                await fs.remove(root);
            }
        }
    }).timeout(60000);
});
