import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import * as path from 'path';

import { mockExtensionContext } from '../common/mockvscode';
import * as rTerminal from '../../rTerminal';
import * as util from '../../util';
import * as session from '../../session';

const extension_root: string = path.join(__dirname, '..', '..', '..');

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

    async function sendDelayFor(values: Record<string, unknown>, defaults: Record<string, unknown> = {}): Promise<number> {
        const resource = vscode.Uri.file(path.join(path.sep, 'workspace', 'project'));
        sandbox.stub(util, 'getCurrentWorkspaceFolder').returns({ uri: resource } as vscode.WorkspaceFolder);
        sandbox.stub(util, 'config').returns(configuration(values, defaults));
        const terminal = {
            name: 'R Interactive',
            show: () => undefined,
            sendText: () => undefined
        };
        sandbox.stub(vscode.window, 'terminals').value([terminal as unknown as vscode.Terminal]);
        sandbox.stub(vscode.window, 'activeTerminal').value(terminal as unknown as vscode.Terminal);
        const delayStub = sandbox.stub(util, 'delay').resolves();
        await rTerminal.runTextInTerm('first\nsecond');
        return delayStub.firstCall.args[0] as number;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
    });

    teardown(() => {
        sandbox.restore();
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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.strictEqual(options.name, 'R Interactive');
        assert.ok(options.env);
        assert.ok(options.env['SESS_PIPE']);
        assert.strictEqual(options.env['SESS_RSTUDIOAPI'], 'TRUE');
        assert.strictEqual(options.env['SESS_USE_HTTPGD'], 'TRUE');
        assert.strictEqual(options.env['SESS_PLOT_BACKEND'], 'httpgd');
        assert.ok(options.env['R_PROFILE_USER']);
        assert.ok(options.env['R_PROFILE_USER'].endsWith(path.join('R', 'profile.R')));
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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.ok(options.env);
        assert.strictEqual(options.env['SESS_USE_HTTPGD'], 'FALSE');
        assert.strictEqual(options.env['SESS_PLOT_BACKEND'], 'standard');
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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.ok(options.env === undefined || options.env['SESS_PIPE'] === undefined);
    });

    test('makeTerminalOptions prefers canonical consoleArgs to legacy rterm.option', async () => {
        sandbox.stub(util, 'config').returns(configuration({
            consoleArgs: ['--vanilla'],
            'rterm.option': ['--no-save']
        }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.deepStrictEqual(options.shellArgs, ['--vanilla']);
    });

    test('makeTerminalOptions uses customized legacy console args when canonical setting is unset', async () => {
        sandbox.stub(util, 'config').returns(configuration({ 'rterm.option': ['--no-save', '--quiet'] }, {
            consoleArgs: ['--no-save', '--no-restore']
        }));
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.deepStrictEqual(options.shellArgs, ['--no-save', '--no-restore']);
    });

    test('createRTerm reports an invalid legacy console path setting only once', async () => {
        const legacySetting = util.getRPathConfigEntry(true);
        const settings: Record<string, string> = { consolePath: '', [legacySetting]: '/missing/r-console', executablePath: '' };
        const configStub = {
            get: (key: string) => key === 'sessionWatcher' ? false : settings[key]
        };
        sandbox.stub(vscode.workspace, 'getConfiguration').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();
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
        const resource = vscode.Uri.file(path.join(path.sep, 'workspace', 'project'));
        sandbox.stub(util, 'getCurrentWorkspaceFolder').returns({ uri: resource } as vscode.WorkspaceFolder);
        const requestedResources: Array<vscode.Uri | undefined> = [];
        const configStub = configuration({
            consoleArgs: ['--project=${workspaceFolder}'],
            'rterm.option': ['--legacy'],
            consoleSendDelay: 17,
            rtermSendDelay: 4
        }, {}, true);
        sandbox.stub(util, 'config').callsFake((requestedResource?: vscode.Uri) => {
            requestedResources.push(requestedResource);
            return configStub;
        });
        sandbox.stub(util, 'getRterm').callsFake(async requestedResource => {
            assert.strictEqual(requestedResource, resource);
            return process.execPath;
        });
        sandbox.stub(util, 'substituteVariables').callsFake((value, requestedResource) => {
            assert.strictEqual(requestedResource, resource);
            return value.replace('${workspaceFolder}', resource.fsPath);
        });
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();
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
        assert.strictEqual(delayStub.firstCall.args[0], 17, 'explicit canonical send delay should be used');
        assert.deepStrictEqual(sent, ['first', 'second']);
        rTerminal.deleteTerminal(fakeTerminal as unknown as vscode.Terminal);
    });

    test('profile R terminal send delay follows its workspace cwd instead of the active editor workspace', async () => {
        const folderA = { uri: vscode.Uri.file(path.join(path.sep, 'workspace', 'a')) } as vscode.WorkspaceFolder;
        const folderB = { uri: vscode.Uri.file(path.join(path.sep, 'workspace', 'b')) } as vscode.WorkspaceFolder;
        sandbox.stub(vscode.window, 'activeTextEditor').value({ document: { uri: folderB.uri } } as vscode.TextEditor);
        sandbox.stub(util, 'getCurrentWorkspaceFolder').callsFake((resource?: vscode.Uri) => {
            if (resource?.fsPath === folderA.uri.fsPath) {
                return folderA;
            }
            return folderB;
        });
        const requestedResources: Array<vscode.Uri | undefined> = [];
        sandbox.stub(util, 'config').callsFake((resource?: vscode.Uri) => {
            requestedResources.push(resource);
            if (resource?.fsPath === folderA.uri.fsPath) {
                return configuration({ consoleSendDelay: 31 }, {}, true);
            }
            if (resource?.fsPath === folderB.uri.fsPath) {
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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        // First creation
        const result = await rTerminal.createRTerm(true);
        assert.ok(result, 'createRTerm should return true');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');

        // Clean up
        rTerminal.rTerm?.dispose();
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
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

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
