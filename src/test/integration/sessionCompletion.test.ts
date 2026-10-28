import * as assert from 'assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
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
                createClient(
                    key: string,
                    selector: vscode.DocumentFilter[],
                    cwd: string,
                    workspaceFolder: vscode.WorkspaceFolder | undefined,
                    outputChannel: vscode.LogOutputChannel,
                    resource?: vscode.Uri,
                    sessionScope?: string,
                ): Promise<LanguageClient>;
                syncClientSessionState(key: string): Promise<void>;
                outputChannel: vscode.LogOutputChannel;
            };
            sandbox
                .stub(
                    LanguageService.prototype as unknown as ServiceInternals,
                    'startLanguageService',
                )
                .resolves();
            sandbox.stub(util, 'getRpath').resolves(rPath);
            const settings = {
                get: (key: string) => {
                    if (key === 'lsp.args') {
                        return ['--vanilla'];
                    }
                    if (key === 'lsp.lang') {
                        return '';
                    }
                    return undefined;
                },
            } as vscode.WorkspaceConfiguration;
            const getConfiguration = vscode.workspace.getConfiguration;
            sandbox
                .stub(vscode.workspace, 'getConfiguration')
                .callsFake((section, resource) =>
                    section === 'r' ? settings : getConfiguration(section, resource),
                );
            service = new LanguageService();
            const internals = service as unknown as ServiceInternals;
            client = await internals.createClient(
                'global',
                [{ scheme: 'file', language: 'r' }],
                root,
                undefined,
                internals.outputChannel,
                undefined,
                'global',
            );
            const languageClient = client;
            const middleware = client.middleware.workspace?.didChangeWorkspaceFolders;
            assert.ok(middleware);
            const protocolUri = (uri: vscode.Uri) =>
                languageClient.code2ProtocolConverter.asUri(uri);
            const documentUri = (folder: vscode.WorkspaceFolder) =>
                protocolUri(vscode.Uri.joinPath(folder.uri, 'completion.R'));

            const projects: vscode.WorkspaceFolder[] = [];
            for (const name of ['initial project', 'added project']) {
                const directory = path.join(root, name);
                await fs.mkdir(directory, { recursive: true });
                await fs.writeFile(path.join(directory, 'completion.R'), 'bs');
                projects.push({ uri: vscode.Uri.file(directory), name, index: projects.length });
            }
            const addFolder = (folder: vscode.WorkspaceFolder) =>
                middleware({ added: [folder], removed: [] }, (event) =>
                    languageClient.sendNotification('workspace/didChangeWorkspaceFolders', {
                        event: {
                            added: event.added.map((folder) => ({
                                uri: protocolUri(folder.uri),
                                name: folder.name,
                            })),
                            removed: [],
                        },
                    }),
                );
            const openDocument = (folder: vscode.WorkspaceFolder) =>
                languageClient.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri: documentUri(folder),
                        languageId: 'r',
                        version: 1,
                        text: 'bs',
                    },
                });
            type Completion = { label: string; data?: { package?: string } };
            const hasSplineCompletion = async (folder: vscode.WorkspaceFolder) => {
                const response = await languageClient.sendRequest<
                    Completion[] | { items: Completion[] } | null
                >('textDocument/completion', {
                    textDocument: { uri: documentUri(folder) },
                    position: { line: 0, character: 2 },
                });
                return (Array.isArray(response) ? response : (response?.items ?? [])).some(
                    (item) => item.label === 'bs' && item.data?.package === 'splines',
                );
            };

            await addFolder(projects[0]);
            await openDocument(projects[0]);
            assert.strictEqual(
                await hasSplineCompletion(projects[0]),
                false,
                'splines is not attached by default',
            );
            service.syncSessionState(
                {
                    search: ['package:splines', 'package:base'],
                    loaded_namespaces: ['splines', 'base'],
                },
                projects[0].uri,
                'session',
            );
            await internals.syncClientSessionState('global');
            assert.strictEqual(
                await hasSplineCompletion(projects[0]),
                true,
                'initial workspace receives session packages',
            );

            await addFolder(projects[1]);
            await openDocument(projects[1]);
            assert.strictEqual(
                await hasSplineCompletion(projects[1]),
                true,
                'new workspace receives replayed session packages',
            );

            // A package installed outside the language server's original
            // library paths must be resolved from its session-provided location.
            const library = path.join(root, 'private-library');
            const packageRoot = path.join(root, 'sessionfixture');
            await fs.mkdir(path.join(packageRoot, 'R'), { recursive: true });
            await fs.mkdir(library, { recursive: true });
            await fs.writeFile(
                path.join(packageRoot, 'DESCRIPTION'),
                [
                    'Package: sessionfixture',
                    'Title: Session Completion Fixture',
                    'Version: 0.0.1',
                    'Description: Exercises session-specific library resolution.',
                    'Authors@R: person("Test", "Runner", email="test@example.org", role=c("aut", "cre"))',
                    'License: MIT',
                    '',
                ].join('\n'),
            );
            await fs.writeFile(
                path.join(packageRoot, 'NAMESPACE'),
                'export(sessionOnlyFixture)\nexport(sessionGeneric)\nS3method(sessionGeneric, data.frame)\n',
            );
            await fs.writeFile(
                path.join(packageRoot, 'R', 'fixture.R'),
                [
                    'sessionOnlyFixture <- function() 1L',
                    'sessionGeneric <- function(x, ...) UseMethod("sessionGeneric")',
                    'sessionGeneric.data.frame <- function(x, sessionParameter = TRUE, ...) x',
                    '',
                ].join('\n'),
            );
            const install = spawnSync(
                rPath,
                ['CMD', 'INSTALL', '--no-multiarch', '-l', library, packageRoot],
                {
                    encoding: 'utf8',
                },
            );
            assert.strictEqual(
                install.status,
                0,
                `Could not install session completion fixture: ${install.stderr || install.error}`,
            );
            const packagePath = path.join(library, 'sessionfixture');
            const source = 'sessionOnlyFi';
            const fixtureUri = protocolUri(
                vscode.Uri.joinPath(projects[0].uri, 'session-fixture.R'),
            );
            await languageClient.sendNotification('textDocument/didOpen', {
                textDocument: { uri: fixtureUri, languageId: 'r', version: 1, text: source },
            });
            service.syncSessionState(
                {
                    search: ['package:sessionfixture', 'package:base'],
                    loaded_namespaces: ['sessionfixture', 'base'],
                    library_paths: [library],
                    package_paths: { sessionfixture: packagePath },
                },
                projects[0].uri,
                'session',
            );
            await internals.syncClientSessionState('global');
            const fixtureCompletions = await languageClient.sendRequest<
                Completion[] | { items: Completion[] } | null
            >('textDocument/completion', {
                textDocument: { uri: fixtureUri },
                position: { line: 0, character: source.length },
            });
            assert.ok(
                (Array.isArray(fixtureCompletions)
                    ? fixtureCompletions
                    : (fixtureCompletions?.items ?? [])
                ).some(
                    (item) =>
                        item.label === 'sessionOnlyFixture' &&
                        item.data?.package === 'sessionfixture',
                ),
                'a package in a session-specific library must offer editor completion',
            );

            const providerProbe = spawnSync(
                rPath,
                [
                    '--vanilla',
                    '--slave',
                    '-e',
                    'cat(exists("member_resolve_packages", asNamespace("languageserver"), inherits=FALSE))',
                ],
                { encoding: 'utf8' },
            );
            if (providerProbe.status === 0 && providerProbe.stdout.trim() === 'TRUE') {
                const call = 'sessionGeneric(data.frame(x = 1), )';
                await languageClient.sendNotification('textDocument/didChange', {
                    textDocument: { uri: fixtureUri, version: 2 },
                    contentChanges: [{ text: call }],
                });
                const signature = await languageClient.sendRequest<{
                    signatures?: Array<{ label: string }>;
                } | null>('textDocument/signatureHelp', {
                    textDocument: { uri: fixtureUri },
                    position: { line: 0, character: call.length - 1 },
                    context: { triggerKind: 1, isRetrigger: false },
                });
                assert.ok(
                    signature?.signatures?.some((item) => item.label.includes('sessionParameter')),
                    'S3 resolution must use session-attached package metadata',
                );
            }

            service.syncSessionState(undefined, projects[0].uri, 'session');
            await internals.syncClientSessionState('global');
            await languageClient.sendNotification('textDocument/didChange', {
                textDocument: { uri: fixtureUri, version: 3 },
                contentChanges: [{ text: source }],
            });
            const afterDetach = await languageClient.sendRequest<
                Completion[] | { items: Completion[] } | null
            >('textDocument/completion', {
                textDocument: { uri: fixtureUri },
                position: { line: 0, character: source.length },
            });
            assert.ok(
                !(Array.isArray(afterDetach) ? afterDetach : (afterDetach?.items ?? [])).some(
                    (item) =>
                        item.label === 'sessionOnlyFixture' &&
                        item.data?.package === 'sessionfixture',
                ),
                'a detached session must not leave private-library completions',
            );

            service.syncSessionState(undefined, projects[0].uri, 'session');
            await internals.syncClientSessionState('global');
            for (const project of projects) {
                assert.strictEqual(
                    await hasSplineCompletion(project),
                    false,
                    'disconnect removes session-only completions',
                );
            }
        } finally {
            try {
                await service?.dispose();
                await client?.dispose();
            } finally {
                sandbox.restore();
                // TCP shutdown can finish before R releases its working directory
                // on Windows. Retry transient locks instead of failing cleanup.
                await fs.rm(root, {
                    recursive: true,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 100,
                });
            }
        }
    }).timeout(120000);
});
