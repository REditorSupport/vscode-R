import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';

import * as session from '../../session';
import { HoverProvider, LiveCompletionItemProvider } from '../../completions';

suite('Session hover and completion', () => {
    let sandbox: sinon.SinonSandbox;
    let sessionRequest: sinon.SinonStub;

    const content = 'rm(list = ls())\n# comment\nx <- list(a = 1)\nf()$\n';

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(session, 'workspaceData').value({ search: [], loaded_namespaces: [], globalenv: {} });
        sandbox.stub(session, 'activeSession').value({ workspaceData: { search: [], loaded_namespaces: [], globalenv: {} } });
        sandbox.stub(session, 'globalPipePath').value('/tmp/vscode-r-test.sock');
        sessionRequest = sandbox.stub(session, 'sessionRequest').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    async function openDocument(): Promise<vscode.TextDocument> {
        return vscode.workspace.openTextDocument({ language: 'r', content });
    }

    test('hover on a word sends only that expression', async () => {
        const document = await openDocument();
        await new HoverProvider().provideHover(document, new vscode.Position(2, 0));

        sinon.assert.calledOnceWithExactly(sessionRequest, { method: 'hover', params: { expr: 'x' } });
    });

    test('hover on punctuation sends no request', async () => {
        const document = await openDocument();
        const hover = await new HoverProvider().provideHover(document, new vscode.Position(1, 0));

        assert.strictEqual(hover, null);
        sinon.assert.notCalled(sessionRequest);
    });

    test('completion after a call result sends no request', async () => {
        const document = await openDocument();
        const token = new vscode.CancellationTokenSource().token;
        const items = await new LiveCompletionItemProvider().provideCompletionItems(
            document,
            new vscode.Position(3, 4),
            token,
            { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '$' }
        );

        assert.deepStrictEqual(items, []);
        sinon.assert.notCalled(sessionRequest);
    });
});
