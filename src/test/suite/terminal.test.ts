import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';

import { mockExtensionContext } from '../common/mockvscode';
import * as rTerminal from '../../rTerminal';
import * as util from '../../util';
import * as session from '../../session';

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
        const discoveryFile = options.env?.['SESS_DISCOVERY_FILE'];
        try {
            assert.strictEqual(options.name, 'R Interactive');
            assert.ok(options.env);
            assert.ok(discoveryFile);
            assert.strictEqual(options.env['SESS_ENDPOINT'], null);
            assert.strictEqual(options.env['SESS_RSTUDIOAPI'], 'TRUE');
            assert.strictEqual(options.env['SESS_USE_HTTPGD'], 'TRUE');
            assert.strictEqual(options.env['SESS_PLOT_BACKEND'], 'httpgd');
            assert.ok(options.env['R_PROFILE_USER']);
            assert.ok(options.env['R_PROFILE_USER'].endsWith(path.join('R', 'profile.R')));
            if (typeof discoveryFile !== 'string') {
                throw new Error('SESS_DISCOVERY_FILE should be a string path');
            }
            const discovery: unknown = await fs.readJson(discoveryFile);
            assert.deepStrictEqual(discovery, { version: 1, endpoint: session.globalPipePath });
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

        assert.ok(options.env === undefined || options.env['SESS_DISCOVERY_FILE'] === undefined);
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
