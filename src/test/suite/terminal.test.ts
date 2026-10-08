import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';

import { mockExtensionContext } from '../common/mockvscode';
import * as rTerminal from '../../rTerminal';
import * as util from '../../util';
import * as session from '../../session';
import * as executionTarget from '../../interactive/executionTarget';

const extension_root: string = path.join(__dirname, '..', '..', '..');

async function waitForDiscoveryRemoval(filePath: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
        if (!await fs.pathExists(filePath)) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for discovery file removal: ${filePath}`);
}

suite('R Terminal', () => {
    let sandbox: sinon.SinonSandbox;

    function configuration(values: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}, workspaceFolderScope = false): vscode.WorkspaceConfiguration {
        return {
            get: (key: string, defaultValue?: unknown) => values[key] ?? defaults[key] ?? defaultValue,
            inspect: (key: string) => values[key] === undefined
                ? undefined
                : workspaceFolderScope ? { workspaceFolderValue: values[key] } : { globalValue: values[key] }
        } as unknown as vscode.WorkspaceConfiguration;
    }

    async function sendDelayFor(
        values: Record<string, unknown>,
        defaults: Record<string, unknown> = {},
        settings = configuration(values, defaults)
    ): Promise<number> {
        const resource = vscode.Uri.file(path.join(path.sep, 'workspace', 'project'));
        sandbox.stub(util, 'getCurrentWorkspaceFolder').returns({ uri: resource } as vscode.WorkspaceFolder);
        sandbox.stub(util, 'config').returns(settings);
        const terminal = {
            name: 'R Interactive',
            show: () => undefined,
            sendText: () => undefined
        };
        sandbox.stub(vscode.window, 'terminals').value([terminal as unknown as vscode.Terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal as unknown as vscode.Terminal);
        const delayStub = sandbox.stub(util, 'delay').resolves();
        await rTerminal.runTextInTerm('first\nsecond');
        return delayStub.firstCall.args[0];
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
    });

    teardown(() => {
        sandbox.restore();
    });

    for (const scenario of [
        { watcher: true, args: [], integrated: true, createTarget: false },
        { watcher: true, args: [], integrated: true, createTarget: true },
        { watcher: false, args: [], integrated: false },
        { watcher: true, args: ['--vanilla'], integrated: false },
        { watcher: true, args: ['--no-init-file'], integrated: false },
    ]) {
        const { watcher, args, integrated } = scenario;
        const createTarget = scenario.createTarget ?? false;
        test(`initial sends share terminal creation and readiness (watcher: ${String(watcher)}, args: ${args.join(' ')}, target picker: ${String(createTarget)})`, async () => {
            // Offer creation only while no terminal exists, as the default
            // execution target picker does after choosing a terminal.
            const target = sandbox.stub(executionTarget, 'tryInteractiveExecution')
                .callsFake((_code, _resource, _source, offerTarget) => Promise.resolve(createTarget && offerTarget ? 'createTerminal' : false));
            let resolveReady!: (ready: boolean) => void;
            const readiness = new Promise<boolean>(resolve => { resolveReady = resolve; });
            let startedWaiting!: () => void;
            const waiting = new Promise<void>(resolve => { startedWaiting = resolve; });
            const readyStub = sandbox.stub(session, 'waitForTerminalReady').callsFake(() => {
                startedWaiting();
                return readiness;
            });
            const delayStub = sandbox.stub(util, 'delay').callsFake(async () => {
                startedWaiting();
                await readiness;
            });
            sandbox.stub(util, 'config').returns(configuration({
                sessionWatcher: watcher, consoleArgs: args, bracketedPaste: true, 'source.focus': 'none'
            }));
            sandbox.stub(util, 'getRterm').resolves(process.execPath);
            sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
            sandbox.stub(session, 'getGlobalPipePath').resolves('unused-test-endpoint');
            sandbox.stub(session, 'createSessionDiscoveryFile').resolves('/unused-test-discovery');
            const sent: string[] = [];
            const terminal = {
                name: 'R Interactive', processId: Promise.resolve(undefined),
                show: () => undefined, dispose: () => undefined,
                sendText: (text: string) => sent.push(text),
            } as unknown as vscode.Terminal;
            const create = sandbox.stub(vscode.window, 'createTerminal').returns(terminal);
            const terminals = sandbox.stub(vscode.window, 'terminals').value([]);
            sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
            const first = rTerminal.runTextInTerm('first');
            const second = rTerminal.runTextInTerm('second');
            // Let both commands reach the shared wait, then expose the terminal
            // as VS Code would before a third Ctrl+Enter.
            await waiting;
            terminals.value([terminal]);
            const third = rTerminal.runTextInTerm('third');
            for (let i = 0; i < 20; i++) { await Promise.resolve(); }
            assert.deepStrictEqual(sent, []);
            sinon.assert.calledOnce(create);
            if (integrated) {
                sinon.assert.calledOnceWithExactly(readyStub, terminal);
                sinon.assert.notCalled(delayStub);
            } else {
                sinon.assert.notCalled(readyStub);
                sinon.assert.calledOnceWithExactly(delayStub, 200);
            }
            resolveReady(true);
            await Promise.all([first, second, third]);
            assert.deepStrictEqual(sent, ['\x1b[200~first\x1b[201~', '\x1b[200~second\x1b[201~', '\x1b[200~third\x1b[201~']);
            await rTerminal.runTextInTerm('fourth');
            assert.strictEqual(sent.length, 4);
            sinon.assert.calledOnce(create);
            assert.strictEqual(target.thirdCall.args[3], false);
            assert.strictEqual(target.lastCall.args[3], false);
            rTerminal.deleteTerminal(terminal);
        });
    }

    test('failed readiness does not send code and allows retry', async () => {
        sandbox.stub(util, 'config').returns(configuration({ sessionWatcher: true, bracketedPaste: true, 'source.focus': 'none' }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
        sandbox.stub(session, 'getGlobalPipePath').resolves('unused-test-endpoint');
        sandbox.stub(session, 'createSessionDiscoveryFile').resolves('/unused-test-discovery');
        const ready = sandbox.stub(session, 'waitForTerminalReady');
        ready.onFirstCall().resolves(false);
        ready.onSecondCall().resolves(true);
        const sendText = sandbox.stub();
        const terminal = {
            name: 'R Interactive', processId: Promise.resolve(undefined),
            show: () => undefined, sendText,
        } as unknown as vscode.Terminal;
        sandbox.stub(vscode.window, 'createTerminal').returns(terminal);
        sandbox.stub(vscode.window, 'terminals').value([terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal);
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        await rTerminal.createRTerm();
        await rTerminal.runTextInTerm('first');
        sinon.assert.notCalled(sendText);
        sinon.assert.calledOnce(warning);
        assert.ok(String(warning.firstCall.args[0]).includes('r.sessionWatcher'),
            'the warning should explain how to opt out of session integration');
        assert.ok(String(warning.firstCall.args[0]).includes('reload VS Code'),
            'the warning should explain how to apply the setting to an existing terminal');
        await rTerminal.runTextInTerm('retry');
        sinon.assert.calledOnceWithExactly(sendText, '\x1b[200~retry\x1b[201~', true);
        rTerminal.deleteTerminal(terminal);
    });

    test('execution target discovery ignores exited and hidden terminals without creating one', () => {
        const stopped = { name: 'R', exitStatus: { code: 0 } } as vscode.Terminal;
        const hidden = { name: 'R Deactivate' } as vscode.Terminal;
        const live = { name: 'R Interactive' } as vscode.Terminal;
        const terminals = sandbox.stub(vscode.window, 'terminals').value([stopped, hidden, live]);
        sandbox.stub(vscode.window, 'activeTerminal').value(stopped);
        sandbox.stub(util, 'config').returns(configuration());
        const create = sandbox.spy(vscode.window, 'createTerminal');
        assert.strictEqual(rTerminal.findTerminal(), live);
        terminals.value([stopped, hidden]);
        assert.strictEqual(rTerminal.findTerminal(), undefined);
        sinon.assert.notCalled(create);

    });

    test('makeTerminalOptions respects legacy plot.useHttpgd configurations', async () => {
        // Leave plot.backend at its default to verify the legacy boolean still selects httpgd.
        const configStub = {
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                if (key === 'session.emulateRStudioAPI') {
                    return true;
                }
                if (key === 'plot.useHttpgd') {
                    return true;
                }
                if (key === 'rterm.option') {
                    return ['--no-save'];
                }
                return defaultValue;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();
        const discoveryFile = options.env?.['SESS_DISCOVERY_FILE'];
        try {
            assert.strictEqual(options.name, 'R Interactive');
            assert.ok(options.env);
            assert.ok(discoveryFile);
            assert.strictEqual(options.env['SESS_ENDPOINT'], null);
            assert.strictEqual(options.env['SESS_RSTUDIOAPI'], 'TRUE');
            assert.strictEqual(options.env['SESS_PLOT_BACKEND'], 'httpgd');
            assert.ok(options.env['R_PROFILE_USER']);
            assert.ok(options.env['R_PROFILE_USER'].endsWith(path.join('R', 'profile.R')));
            if (typeof discoveryFile !== 'string') {
                throw new Error('SESS_DISCOVERY_FILE should be a string path');
            }
            const discovery: unknown = await fs.readJson(discoveryFile);
            assert.deepStrictEqual(discovery, { version: 1, endpoint: session.globalPipePath, jgdSocket: '' });
        } finally {
            if (typeof discoveryFile === 'string') {
                await fs.remove(discoveryFile);
            }
        }
    });

    test('deleteTerminal removes only its discovery file after an explicit terminal close', async () => {
        const endpoint = await session.getGlobalPipePath();
        const discoveryFile = await session.createSessionDiscoveryFile(endpoint);
        const unrelatedFile = await session.createSessionDiscoveryFile(endpoint);
        const terminal = {
            name: 'R Interactive',
            processId: Promise.resolve(45239),
            creationOptions: {
                name: 'R Interactive',
                env: { SESS_DISCOVERY_FILE: discoveryFile },
            },
            exitStatus: { code: undefined, reason: vscode.TerminalExitReason.User },
        } as unknown as vscode.Terminal;

        try {
            rTerminal.deleteTerminal(terminal);
            await waitForDiscoveryRemoval(discoveryFile);
            assert.strictEqual(await fs.pathExists(unrelatedFile), true);
        } finally {
            await fs.remove(discoveryFile);
            await fs.remove(unrelatedFile);
        }
    });

    test('deleteTerminal keeps discovery files for shutdown and uncertain exits', async () => {
        const endpoint = await session.getGlobalPipePath();
        const shutdownFile = await session.createSessionDiscoveryFile(endpoint);
        const unknownFile = await session.createSessionDiscoveryFile(endpoint);
        const shutdownTerminal = {
            name: 'R Interactive',
            processId: Promise.resolve(45241),
            creationOptions: { name: 'R Interactive', env: { SESS_DISCOVERY_FILE: shutdownFile } },
            exitStatus: { code: undefined, reason: vscode.TerminalExitReason.Shutdown },
        } as unknown as vscode.Terminal;
        const unknownTerminal = {
            name: 'R Interactive',
            processId: Promise.resolve(45243),
            creationOptions: { name: 'R Interactive', env: { SESS_DISCOVERY_FILE: unknownFile } },
            exitStatus: { code: undefined, reason: vscode.TerminalExitReason.Unknown },
        } as unknown as vscode.Terminal;

        try {
            rTerminal.deleteTerminal(shutdownTerminal);
            rTerminal.deleteTerminal(unknownTerminal);
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.strictEqual(await fs.pathExists(shutdownFile), true);
            assert.strictEqual(await fs.pathExists(unknownFile), true);
        } finally {
            await fs.remove(shutdownFile);
            await fs.remove(unknownFile);
        }
    });

    test('deleteTerminal finds a restored R terminal discovery file by terminal PID metadata', async () => {
        const endpoint = await session.getGlobalPipePath();
        const discoveryFile = await session.createSessionDiscoveryFile(endpoint);
        const terminalPid = 45245;
        await session.updateSessionDiscoveryFile(discoveryFile, endpoint, terminalPid);
        const terminal = {
            name: 'R Interactive',
            processId: Promise.resolve(terminalPid),
            creationOptions: { name: 'R Interactive' },
            exitStatus: { code: undefined, reason: vscode.TerminalExitReason.Process },
        } as unknown as vscode.Terminal;

        try {
            rTerminal.deleteTerminal(terminal);
            await waitForDiscoveryRemoval(discoveryFile);
        } finally {
            await fs.remove(discoveryFile);
        }
    });

    test('makeTerminalOptions prefers an explicit plot.backend over legacy plot.useHttpgd', async () => {
        const configStub = {
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                if (key === 'plot.backend') {
                    return 'standard';
                }
                if (key === 'plot.useHttpgd') {
                    return true;
                }
                return defaultValue;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();

        assert.ok(options.env);
        assert.strictEqual(options.env['SESS_PLOT_BACKEND'], 'standard');
    });

    test('makeTerminalOptions passes native to sess without a JGD socket', async () => {
        sandbox.stub(util, 'config').returns(configuration({
            sessionWatcher: true,
            'plot.backend': 'native',
            'plot.useHttpgd': true,
        }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        const options = await rTerminal.makeTerminalOptions();
        const discoveryFile = options.env?.['SESS_DISCOVERY_FILE'];
        try {
            assert.strictEqual(options.env?.['SESS_PLOT_BACKEND'], 'native');
            assert.strictEqual(options.env?.['JGD_SOCKET'], undefined);
        } finally {
            if (typeof discoveryFile === 'string') {
                await fs.remove(discoveryFile);
            }
        }
    });

    test('makeTerminalOptions does not set session watcher env if disabled', async () => {
        const configStub = {
            get: (key: string) => {
                if (key === 'sessionWatcher') {
                    return false;
                }
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();

        assert.ok(options.env === undefined || options.env['SESS_DISCOVERY_FILE'] === undefined);
    });

    test('makeTerminalOptions prefers canonical consoleArgs to legacy rterm.option', async () => {
        sandbox.stub(util, 'config').returns(configuration({
            consoleArgs: ['--vanilla'],
            'rterm.option': ['--no-save']
        }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();

        assert.deepStrictEqual(options.shellArgs, ['--vanilla']);
    });

    test('makeTerminalOptions uses customized legacy console args when canonical setting is unset', async () => {
        sandbox.stub(util, 'config').returns(configuration({ 'rterm.option': ['--no-save', '--quiet'] }, {
            consoleArgs: ['--no-save', '--no-restore']
        }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();

        assert.deepStrictEqual(options.shellArgs, ['--no-save', '--quiet']);
    });

    test('runTextInTerm uses customized legacy send delay when canonical setting is unset', async () => {
        const sendDelay = await sendDelayFor({ rtermSendDelay: 23 }, { consoleSendDelay: 8 });

        assert.strictEqual(sendDelay, 23);
    });

    test('runTextInTerm keeps the existing send delay default when neither setting is explicit', async () => {
        const sendDelay = await sendDelayFor({}, { consoleSendDelay: 8 });

        assert.strictEqual(sendDelay, 8);
    });

    test('makeTerminalOptions keeps existing console args defaults when neither setting is explicit', async () => {
        sandbox.stub(util, 'config').returns(configuration({}, { consoleArgs: ['--no-save', '--no-restore'] }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        const options = await rTerminal.makeTerminalOptions();

        assert.deepStrictEqual(options.shellArgs, ['--no-save', '--no-restore']);
    });

    const scopes = ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const;
    for (const canonicalScope of scopes) {
        for (const legacyScope of scopes) {
            for (const setting of ['args', 'delay'] as const) {
                test(`console ${setting}: canonical ${canonicalScope} versus legacy ${legacyScope}`, async () => {
                    const canonicalKey = setting === 'args' ? 'consoleArgs' : 'consoleSendDelay';
                    const legacyKey = setting === 'args' ? 'rterm.option' : 'rtermSendDelay';
                    // Empty arguments and zero delay are explicit values, not fallbacks.
                    const canonicalValue = setting === 'args' ? [] : 0;
                    const legacyValue = setting === 'args' ? ['--vanilla'] : 23;
                    const settings = configuration();
                    sandbox.stub(settings, 'inspect').callsFake((key: string) => ({
                        key,
                        ...(key === canonicalKey ? { [canonicalScope]: canonicalValue }
                            : key === legacyKey ? { [legacyScope]: legacyValue } : {})
                    }));
                    const expected = scopes.indexOf(canonicalScope) >= scopes.indexOf(legacyScope)
                        ? canonicalValue : legacyValue;
                    if (setting === 'args') {
                        sandbox.stub(util, 'config').returns(settings);
                        sandbox.stub(util, 'getRterm').resolves(process.execPath);
                        assert.deepStrictEqual((await rTerminal.makeTerminalOptions()).shellArgs, expected);
                    } else {
                        assert.strictEqual(await sendDelayFor({}, {}, settings), expected);
                    }
                });
            }
        }
    }

    for (const hasWorkspace of [true, false]) {
        test(`file resource uses workspace cwd (workspace present: ${String(hasWorkspace)})`, async () => {
            const folder = vscode.Uri.file(path.join(path.sep, 'workspace', 'project'));
            const file = vscode.Uri.file(path.join(folder.fsPath, 'script.R'));
            // Variable substitution also inspects the active editor. Keep this
            // explicit-resource test independent of preceding editor suites.
            sandbox.stub(vscode.window, 'activeTextEditor').value(undefined);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value(
                hasWorkspace ? [{ uri: folder } as vscode.WorkspaceFolder] : undefined
            );
            sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake(resource => {
                assert.strictEqual(resource, file);
                return hasWorkspace ? { uri: folder } as vscode.WorkspaceFolder : undefined;
            });
            const configStub = sandbox.stub(util, 'config').returns(configuration({
                consoleArgs: hasWorkspace ? ['--project=${workspaceFolder}'] : ['--quiet']
            }));
            const pathStub = sandbox.stub(util, 'getRterm').resolves(process.execPath);

            const options = await rTerminal.makeTerminalOptions(file);

            assert.strictEqual(options.cwd, hasWorkspace ? folder.fsPath : undefined);
            assert.deepStrictEqual(options.shellArgs, hasWorkspace ? [`--project=${folder.fsPath}`] : ['--quiet']);
            assert.ok(configStub.calledWithExactly(file));
            assert.ok(pathStub.calledWithExactly(file));
        });
    }

    test('createRTerm reports an invalid legacy console path setting only once', async () => {
        const legacySetting = util.getRPathConfigEntry(true);
        const settings: Record<string, string> = { consolePath: '', [legacySetting]: '/missing/r-console', executablePath: '' };
        const configStub = {
            get: (key: string) => key === 'sessionWatcher' ? false : settings[key]
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
        const errorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

        assert.strictEqual(await rTerminal.createRTerm(), false);

        assert.strictEqual(errorStub.callCount, 1);
        assert.ok(String(errorStub.firstCall.args[0]).includes(`r.${legacySetting}`));
    });

    test('getRterm reports an invalid canonical consolePath setting clearly', async () => {
        const legacySetting = util.getRPathConfigEntry(true);
        const settings: Record<string, string> = { consolePath: '/missing/canonical-console', [legacySetting]: '/legacy/r-console' };
        const configStub = {
            get: (key: string) => settings[key]
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        const errorStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

        assert.strictEqual(await util.getRterm(), undefined);

        assert.strictEqual(errorStub.callCount, 1);
        assert.ok(String(errorStub.firstCall.args[0]).includes('r.consolePath'));
    });

    test('console arguments, substitution, and send delay use the R terminal workspace resource', async () => {
        const consoleSendDelay = 17;
        const resource = vscode.Uri.file(path.join(path.sep, 'workspace', 'project'));
        sandbox.stub(util, 'getCurrentWorkspaceFolder').returns({ uri: resource } as vscode.WorkspaceFolder);
        const requestedResources: Array<vscode.Uri | undefined> = [];
        const configStub = configuration({
            consoleArgs: ['--project=${workspaceFolder}'],
            'rterm.option': ['--legacy'],
            consoleSendDelay,
            rtermSendDelay: 4
        }, {}, true);
        sandbox.stub(util, 'config').callsFake((requestedResource?: vscode.Uri) => {
            requestedResources.push(requestedResource);
            return configStub;
        });
        sandbox.stub(util, 'getRterm').callsFake(requestedResource => {
            assert.strictEqual(requestedResource, resource);
            return Promise.resolve(process.execPath);
        });
        sandbox.stub(util, 'substituteVariables').callsFake((value, requestedResource) => {
            assert.strictEqual(requestedResource, resource);
            return value.replace('${workspaceFolder}', resource.fsPath);
        });
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
        const sent: string[] = [];
        const fakeTerminal = {
            name: 'R Interactive',
            processId: Promise.resolve(undefined),
            show: () => undefined,
            dispose: () => undefined,
            sendText: (text: string) => sent.push(text)
        };
        sandbox.stub(vscode.window, 'createTerminal').returns(fakeTerminal as unknown as vscode.Terminal);
        sandbox.stub(vscode.window, 'terminals').value([fakeTerminal as unknown as vscode.Terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(fakeTerminal as unknown as vscode.Terminal);
        const delayStub = sandbox.stub(util, 'delay').resolves();

        assert.strictEqual(await rTerminal.createRTerm(), true);
        const options = await rTerminal.makeTerminalOptions();
        await rTerminal.runTextInTerm('first\nsecond');

        assert.deepStrictEqual(options.shellArgs, [`--project=${resource.fsPath}`]);
        assert.ok(requestedResources.includes(resource), 'configuration should be requested for the R terminal resource');
        assert.deepStrictEqual(delayStub.args, [[200], [consoleSendDelay]],
            'startup fallback should be followed by the explicit canonical per-line send delay');
        assert.deepStrictEqual(sent, ['first', 'second']);
        rTerminal.deleteTerminal(fakeTerminal as unknown as vscode.Terminal);
    });

    for (const scheme of ['file', 'vscode-remote']) {
        const authority = scheme === 'vscode-remote' ? 'ssh-remote+test-host' : '';
        test(`profile R terminal send delay preserves its ${scheme} workspace URI`, async () => {
            const folderA = { uri: vscode.Uri.file(path.join(path.sep, 'workspace', 'a')).with({ scheme, authority }) } as vscode.WorkspaceFolder;
            const folderB = { uri: vscode.Uri.file(path.join(path.sep, 'workspace', 'b')).with({ scheme, authority }) } as vscode.WorkspaceFolder;
            sandbox.stub(vscode.window, 'activeTextEditor').value({ document: { uri: folderB.uri } } as vscode.TextEditor);
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([folderA, folderB]);
            sandbox.stub(vscode.workspace, 'getWorkspaceFolder').callsFake(resource =>
                [folderA, folderB].find(folder => folder.uri.toString() === resource.toString()));
            const requestedResources: Array<vscode.Uri | undefined> = [];
            sandbox.stub(util, 'config').callsFake((resource?: vscode.Uri) => {
                requestedResources.push(resource);
                if (resource?.toString() === folderA.uri.toString()) {
                    return configuration({ consoleSendDelay: 31 }, {}, true);
                }
                if (resource?.toString() === folderB.uri.toString()) {
                    return configuration({ consoleSendDelay: 47 }, {}, true);
                }
                return configuration({}, { bracketedPaste: false, 'source.focus': 'none' });
            });
            const terminal = {
                name: 'R Interactive',
                creationOptions: { name: 'R Interactive', cwd: folderA.uri.fsPath },
                show: () => undefined,
                sendText: () => undefined
            };
            sandbox.stub(vscode.window, 'terminals').value([terminal as unknown as vscode.Terminal]);
            sandbox.stub(vscode.window, 'activeTerminal').value(terminal as unknown as vscode.Terminal);
            const delayStub = sandbox.stub(util, 'delay').resolves();

            await rTerminal.runTextInTerm('first\nsecond');

            assert.ok(requestedResources.includes(folderA.uri), 'configuration should use the workspace containing the profile terminal cwd');
            assert.strictEqual(delayStub.firstCall.args[0], 31);
        });
    }

    test('createRTerm and restartRTerminal integration test', async () => {
        const configStub = {
            get: (key: string) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        let finishSetup!: (result: boolean) => void;
        const setupFinished = new Promise<boolean>(resolve => { finishSetup = resolve; });
        let setupStarted!: () => void;
        const started = new Promise<void>(resolve => { setupStarted = resolve; });
        sandbox.stub(util, 'promptToInstallSessPackage').callsFake(() => {
            setupStarted();
            return setupFinished;
        });
        const createTerminal = sandbox.spy(vscode.window, 'createTerminal');

        const creation = rTerminal.createRTerm(true);
        await started;
        assert.strictEqual(createTerminal.called, false, 'terminal must wait for sess setup');
        finishSetup(true);
        const result = await creation;
        assert.ok(result, 'createRTerm should return true');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');

        // Clean up
        rTerminal.rTerm?.dispose();
    });

    test('createRTerm removes its discovery file when the configured executable is invalid', async () => {
        const createdDiscoveryFiles: string[] = [];
        const createDiscoveryFile = session.createSessionDiscoveryFile;
        sandbox.stub(session, 'createSessionDiscoveryFile').callsFake(async endpoint => {
            const filePath = await createDiscoveryFile(endpoint);
            createdDiscoveryFiles.push(filePath);
            return filePath;
        });
        const configStub = {
            get: (key: string) => key === 'sessionWatcher' ? true : undefined,
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(`${process.execPath}.does-not-exist`);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        try {
            assert.strictEqual(await rTerminal.createRTerm(), false);
            assert.strictEqual(createdDiscoveryFiles.length, 1);
            assert.strictEqual(await fs.pathExists(createdDiscoveryFiles[0]), false);
        } finally {
            await Promise.all(createdDiscoveryFiles.map(filePath => fs.remove(filePath)));
        }
    });

    test('createRTerm removes its discovery file when VS Code terminal creation throws', async () => {
        const createdDiscoveryFiles: string[] = [];
        const createDiscoveryFile = session.createSessionDiscoveryFile;
        sandbox.stub(session, 'createSessionDiscoveryFile').callsFake(async endpoint => {
            const filePath = await createDiscoveryFile(endpoint);
            createdDiscoveryFiles.push(filePath);
            return filePath;
        });
        const configStub = {
            get: (key: string) => key === 'sessionWatcher' ? true : undefined,
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
        sandbox.stub(vscode.window, 'createTerminal').throws(new Error('terminal creation failed'));

        try {
            await assert.rejects(rTerminal.createRTerm(), /terminal creation failed/);
            assert.strictEqual(createdDiscoveryFiles.length, 1);
            assert.strictEqual(await fs.pathExists(createdDiscoveryFiles[0]), false);
        } finally {
            await Promise.all(createdDiscoveryFiles.map(filePath => fs.remove(filePath)));
        }
    });

    test('createRTerm removes its discovery file when sess installation fails', async () => {
        const createdDiscoveryFiles: string[] = [];
        const createDiscoveryFile = session.createSessionDiscoveryFile;
        sandbox.stub(session, 'createSessionDiscoveryFile').callsFake(async endpoint => {
            const filePath = await createDiscoveryFile(endpoint);
            createdDiscoveryFiles.push(filePath);
            return filePath;
        });
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'sessionWatcher' ? true : undefined,
        } as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(false);
        const createTerminal = sandbox.stub(vscode.window, 'createTerminal');
        try {
            assert.strictEqual(await rTerminal.createRTerm(), false);
            assert.strictEqual(createTerminal.called, false);
            assert.strictEqual(createdDiscoveryFiles.length, 1);
            assert.strictEqual(await fs.pathExists(createdDiscoveryFiles[0]), false);
        } finally {
            await Promise.all(createdDiscoveryFiles.map(filePath => fs.remove(filePath)));
        }
    });

    test('createRTerm records process IDs for all managed terminals when they resolve out of order', async () => {
        function deferred<T>() {
            let resolve!: (value: T) => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
            return { promise, resolve, reject };
        }

        let resolveFirst!: (pid: number | undefined) => void;
        let resolveSecond!: (pid: number | undefined) => void;
        const firstProcessId = new Promise<number | undefined>(resolve => { resolveFirst = resolve; });
        const secondProcessId = new Promise<number | undefined>(resolve => { resolveSecond = resolve; });
        const firstTerminal = {
            name: 'R Interactive', processId: firstProcessId,
            show: () => undefined, dispose: () => undefined,
        } as unknown as vscode.Terminal;
        const secondTerminal = {
            name: 'R Interactive', processId: secondProcessId,
            show: () => undefined, dispose: () => undefined,
        } as unknown as vscode.Terminal;
        const firstWrite = deferred<{ terminal: vscode.Terminal; filePath: string; pid: number | undefined }>();
        const secondWrite = deferred<{ terminal: vscode.Terminal; filePath: string; pid: number | undefined }>();
        const updateDiscoveryFile = session.updateTerminalSessionDiscoveryFile;
        const pendingWrites: Promise<void>[] = [];
        sandbox.stub(session, 'updateTerminalSessionDiscoveryFile').callsFake((terminal, filePath, endpoint, pid) => {
            const writing = updateDiscoveryFile(terminal, filePath, endpoint, pid).then(() => {
                const write = { terminal, filePath, pid };
                if (terminal === firstTerminal) { firstWrite.resolve(write); }
                if (terminal === secondTerminal) { secondWrite.resolve(write); }
            }, error => {
                if (terminal === firstTerminal) { firstWrite.reject(error); }
                if (terminal === secondTerminal) { secondWrite.reject(error); }
                throw error;
            });
            pendingWrites.push(writing);
            return writing;
        });
        const configStub = {
            get: (key: string) => key === 'sessionWatcher' ? true : undefined,
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);
        const createTerminalStub = sandbox.stub(vscode.window, 'createTerminal');
        createTerminalStub.onFirstCall().returns(firstTerminal);
        createTerminalStub.onSecondCall().returns(secondTerminal);

        let firstDiscoveryFile: string | undefined;
        let secondDiscoveryFile: string | undefined;
        try {
            assert.strictEqual(await rTerminal.createRTerm(), true);
            assert.strictEqual(await rTerminal.createRTerm(), true);
            const firstOptions = createTerminalStub.firstCall.args[0] as vscode.TerminalOptions;
            const secondOptions = createTerminalStub.secondCall.args[0] as vscode.TerminalOptions;
            const firstPath = firstOptions.env?.['SESS_DISCOVERY_FILE'];
            const secondPath = secondOptions.env?.['SESS_DISCOVERY_FILE'];
            if (typeof firstPath !== 'string' || typeof secondPath !== 'string') {
                throw new Error('Managed terminals should receive discovery-file paths');
            }
            firstDiscoveryFile = firstPath;
            secondDiscoveryFile = secondPath;
            assert.notStrictEqual(firstDiscoveryFile, secondDiscoveryFile);

            resolveSecond(45249);
            const secondWriteResult = await secondWrite.promise;
            assert.strictEqual(secondWriteResult.terminal, secondTerminal);
            assert.strictEqual(secondWriteResult.filePath, secondDiscoveryFile);
            assert.strictEqual(secondWriteResult.pid, 45249);
            resolveFirst(45247);
            const firstWriteResult = await firstWrite.promise;
            assert.strictEqual(firstWriteResult.terminal, firstTerminal);
            assert.strictEqual(firstWriteResult.filePath, firstDiscoveryFile);
            assert.strictEqual(firstWriteResult.pid, 45247);

            const firstDiscovery: unknown = await fs.readJson(firstDiscoveryFile);
            const secondDiscovery: unknown = await fs.readJson(secondDiscoveryFile);
            assert.strictEqual(typeof firstDiscovery, 'object');
            assert.strictEqual(typeof secondDiscovery, 'object');
            assert.strictEqual((firstDiscovery as { terminalPid?: number }).terminalPid, 45247);
            assert.strictEqual((secondDiscovery as { terminalPid?: number }).terminalPid, 45249);
        } finally {
            await Promise.allSettled(pendingWrites);
            if (firstDiscoveryFile) {
                await fs.remove(firstDiscoveryFile);
            }
            if (secondDiscoveryFile) {
                await fs.remove(secondDiscoveryFile);
            }
        }
    });

    test('active R session PID matches terminal PID', async () => {
        const configStub = {
            get: (key: string) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves(true);

        // We need to mock the terminal and its processId
        const fakeTerminal = {
            name: 'R Interactive',
            processId: Promise.resolve(1234),
            show: () => { /* empty */ },
            dispose: () => { /* empty */ },
            sendText: () => { /* empty */ }
        };
        const createTerminalStub = sandbox.stub(vscode.window, 'createTerminal').returns(fakeTerminal as unknown as vscode.Terminal);

        const result = await rTerminal.createRTerm(true);
        assert.ok(result);

        // Manually trigger session activation as if the R process connected back
        const fakeSession = {
            pid: '1234',
            rVer: '4.0.0',
            info: { version: '4.0.0', command: 'R', start_time: '2021-01-01T00:00:00Z' },
            sessionDir: '',
            workingDir: '',
            workspaceData: { search: [], loaded_namespaces: [], globalenv: {} },
            pipePath: '',
            socket: { destroyed: true, destroy: () => undefined } as unknown as session.Session['socket']
        };

        await session.activateSession(fakeSession as unknown as session.Session);

        assert.ok(session.activeSession, 'Active session should be defined');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');
        const terminalPid = await rTerminal.rTerm.processId;
        assert.strictEqual(session.activeSession.pid, String(terminalPid), 'Session PID should match terminal PID');

        // Clean up
        rTerminal.rTerm?.dispose();
        createTerminalStub.restore();
    });
});
