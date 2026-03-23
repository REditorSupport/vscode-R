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

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
    });

    teardown(() => {
        sandbox.restore();
    });

    test('makeTerminalOptions sets session watcher environment variables', async () => {
        // Stub config to enable sessionWatcher
        const configStub = {
            get: (key: string) => {
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
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        sandbox.stub(util, 'getRterm').resolves(process.execPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const options = await rTerminal.makeTerminalOptions();

        assert.strictEqual(options.name, 'R Interactive');
        assert.ok(options.env);
        assert.ok(options.env['SESS_SOCKET_PATH']);
        assert.strictEqual(options.env['SESS_RSTUDIOAPI'], 'TRUE');
        assert.strictEqual(options.env['SESS_USE_HTTPGD'], 'TRUE');
        assert.ok(options.env['R_PROFILE_USER']);
        assert.ok(options.env['R_PROFILE_USER'].endsWith(path.join('R', 'profile.R')));
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

        assert.ok(options.env === undefined || options.env['SESS_SOCKET_PATH'] === undefined);
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

        // Spy on startSessionWatcher
        const startSessionWatcherSpy = sandbox.spy(session, 'startSessionWatcher');

        // First creation
        const result = await rTerminal.createRTerm(true);
        assert.ok(result, 'createRTerm should return true');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');
        const firstTerm = rTerminal.rTerm;

        // Verify startSessionWatcher was called
        const creationOptions = firstTerm.creationOptions as vscode.TerminalOptions;
        assert.ok(startSessionWatcherSpy.calledOnce, 'startSessionWatcher should be called');
        const firstSessionPath = creationOptions.env?.['SESS_SOCKET_PATH'] ?? undefined;
        assert.ok(startSessionWatcherSpy.calledWith(firstSessionPath), 'startSessionWatcher should be called with correct sessionPath');

        // Test restart
        await rTerminal.restartRTerminal();
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined after restart');
        assert.notStrictEqual(rTerminal.rTerm, firstTerm, 'Restarted terminal should be a different object');
        
        // Verify startSessionWatcher was called again
        assert.ok(startSessionWatcherSpy.calledTwice, 'startSessionWatcher should be called twice after restart');

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
            server: { sessionPath: '/tmp/vscode-r-mock.sock' },
            ws: {} as unknown as session.Session['ws']
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
