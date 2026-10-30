import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as path from 'path';
import { HelpPanel } from '../../helpViewer/panel';
import type { RHelp } from '../../helpViewer';
import * as util from '../../util';
import { mockExtensionContext } from '../common/mockvscode';

suite('Help panel navigation', () => {
    let sandbox: sinon.SinonSandbox;
    let panel: vscode.WebviewPanel;
    let help: HelpPanel;
    let closed: vscode.EventEmitter<void>;

    setup(async () => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        sandbox
            .stub(util, 'config')
            .returns({ get: () => 'Two' } as unknown as vscode.WorkspaceConfiguration);
        closed = new vscode.EventEmitter<void>();
        panel = {
            active: true,
            reveal: sandbox.stub(),
            dispose: () => closed.fire(),
            onDidDispose: closed.event,
            onDidChangeViewState: sandbox.stub(),
            webview: {
                html: '',
                asWebviewUri: (uri: vscode.Uri) => uri,
                onDidReceiveMessage: sandbox.stub(),
                postMessage: sandbox.stub().resolves(true),
            },
        } as unknown as vscode.WebviewPanel;
        help = new HelpPanel(
            { webviewScriptPath: '/help.js', webviewStylePath: '/help.css' },
            {} as RHelp,
            panel,
        );
        await help.showHelpFile({ requestPath: '/first', html: '<body>First</body>' });
        await help.showHelpFile({ requestPath: '/second', html: '<body>Second</body>' });
    });

    teardown(() => {
        try {
            help?.dispose();
            closed?.dispose();
        } finally {
            sandbox.restore();
        }
    });

    test('Back still works when a webview cannot acknowledge its scroll position', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = help.goBack();
        await clock.tickAsync(1000);
        await pending;
        assert.match(panel.webview.html, /First/);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('closing the panel settles pending navigation without waiting for a timeout', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = help.goBack();
        panel.dispose();
        await pending;
        assert.strictEqual(help.panel, undefined);
        assert.strictEqual(clock.countTimers(), 0);
    });

    test('failed delivery falls back immediately instead of waiting for the scroll timeout', async () => {
        const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        (panel.webview.postMessage as sinon.SinonStub).resolves(false);
        await help.goBack();
        await clock.tickAsync(0);
        assert.match(panel.webview.html, /First/);
        assert.strictEqual(clock.countTimers(), 0);
    });
});
