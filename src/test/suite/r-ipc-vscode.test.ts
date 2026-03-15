import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';
import * as path from 'path';

import { mockExtensionContext } from '../common/mockvscode';
import * as rTerminal from '../../rTerminal';
import * as util from '../../util';
import * as session from '../../session';

const extension_root: string = path.join(__dirname, '..', '..', '..');

async function waitFor<T>(condition: () => T | Promise<T>, timeout = 10000, interval = 100): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const result = await condition();
        if (result) {
            return result;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout after ${timeout}ms waiting for condition`);
}

suite('sess_app Communication', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
        session.deploySessionWatcher(extension_root);
    });

    teardown(async () => {
        if (rTerminal.rTerm) {
            const pid = await rTerminal.rTerm.processId;
            rTerminal.rTerm.dispose();
            
            // Explicitly invoke the extension's terminal cleanup logic
            // since the mocked VS Code environment won't fire onDidCloseTerminal
            rTerminal.deleteTerminal(rTerminal.rTerm);
            
            if (pid) {
                // Ensure the underlying websocket connections and activeSession 
                // are wiped clean so the next test waits properly.
                await session.cleanupSession(pid.toString());
            }
        }
        sandbox.restore();
    });

    test('communication: hello <- 1 updates workspace and provides completion', async () => {
        const configStub = {
            get: (key: string) => {
                if (key === 'sessionWatcher') {
                    return true;
                }
                if (key === 'rterm.option') {
                    return ['--no-save'];
                }
                return undefined;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        
        const rPath = await util.getRterm();
        assert.ok(rPath, 'R path should be found');
        sandbox.stub(util, 'getRterm').resolves(rPath);
        
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const result = await rTerminal.createRTerm(true);
        assert.ok(result, 'createRTerm should return true');
        assert.ok(rTerminal.rTerm, 'rTerminal.rTerm should be defined');
        
        await waitFor(() => session.activeSession, 15000, 200);
        assert.ok(session.activeSession, 'activeSession should be established');
        
        const term = rTerminal.rTerm;
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        term.sendText('my_list <- list(hello_vscode = 12345)\n');
        
        await waitFor(() => {
            const ge = session.workspaceData?.globalenv;
            return ge && ge['my_list'];
        }, 15000, 200);
        
        const listData = session.workspaceData.globalenv['my_list'];
        assert.ok(listData, 'my_list should be in workspaceData.globalenv');
        const className = Array.isArray(listData.class) ? listData.class[0] : listData.class;
        assert.strictEqual(className, 'list', 'my_list should be a list');
        
        const completionRequestParams = {
            expr: 'my_list',
            trigger: '$'
        };
        const completionResult = await session.sessionRequest(session.activeSession.server, {
            method: 'completion',
            params: completionRequestParams
        }) as Record<string, unknown>[];
        
        assert.ok(Array.isArray(completionResult), 'completion result should be an array');
        const hasHello = completionResult.some((item) => item.name === 'hello_vscode');
        assert.ok(hasHello, 'completion result should contain hello_vscode');
    }).timeout(30000);

    test('communication: plot(0) with various devices and View() events', async () => {
        const configStub = {
            get: (key: string, defaultValue?: unknown) => {
                if (key === 'sessionWatcher') { return true; }
                if (key === 'rterm.option') { return ['--no-save']; }
                if (key === 'plot.useHttpgd') { return false; }
                if (key === 'session.data.pageSize') { return 500; }
                if (key === 'session.viewers.viewColumn') { return {
                    plot: 'Two',
                    browser: 'Active',
                    viewer: 'Two',
                    pageViewer: 'Active',
                    view: 'Two',
                    helpPanel: 'Two'
                }; }
                if (key === 'session.viewers.viewColumn.plot') { return 'Two'; }
                return defaultValue;
            }
        };
        sandbox.stub(util, 'config').returns(configStub as unknown as vscode.WorkspaceConfiguration);
        
        const rPath = await util.getRterm();
        assert.ok(rPath, 'R path should be found');
        sandbox.stub(util, 'getRterm').resolves(rPath);
        sandbox.stub(util, 'promptToInstallSessPackage').resolves();

        const result = await rTerminal.createRTerm(true);
        assert.ok(result);
        await waitFor(() => session.activeSession, 15000, 200);
        
        const term = rTerminal.rTerm;
        assert.ok(term, 'rTerminal.rTerm should be defined');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 1. Test svglite
        term.sendText('plot(0, main="svglite")\n');
        await new Promise(resolve => setTimeout(resolve, 2000));

        assert.ok(session.activeSession, 'activeSession should be defined');
        const svgliteResp = await session.sessionRequest(session.activeSession.server, {
            method: 'plot_latest',
            params: { width: 800, height: 600, format: 'svglite' }
        }) as { data?: string, format?: string, error?: unknown };
        
        assert.ok(svgliteResp.data, 'svglite data should be returned');
        assert.strictEqual(svgliteResp.format, 'svglite', 'format should be svglite');

        // 2. Test png
        term.sendText('plot(1, main="png")\n');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const pngResp = await session.sessionRequest(session.activeSession.server, {
            method: 'plot_latest',
            params: { width: 800, height: 600, format: 'png' }
        }) as { data?: string, format?: string };

        assert.ok(pngResp.data, 'png data should be returned');
        assert.strictEqual(pngResp.format, 'png', 'format should be png');

        // Spy on WebviewPanel creation to catch dataview / webview rendering attempts
        // Note: we set up the spy after activeSession to not intercept early setups if any, 
        // though it's safe to do it here for View() testing.
        const createWebviewPanelSpy = sandbox.spy(vscode.window, 'createWebviewPanel');

        // 3. Test View() -> dataview
        term.sendText('View(mtcars)\n');
        await waitFor(() => createWebviewPanelSpy.calledWith('dataview'), 10000, 200);
        
        assert.ok(createWebviewPanelSpy.calledWith('dataview'), 'dataview should be triggered');

        // 4. Test webview
        term.sendText('tf <- tempfile(fileext=".html"); writeLines("test", tf); getOption("viewer")(tf)\n');
        await waitFor(() => createWebviewPanelSpy.calledWith('webview'), 10000, 200);

        assert.ok(createWebviewPanelSpy.calledWith('webview'), 'webview should be triggered for html file');

    }).timeout(45000);
});
