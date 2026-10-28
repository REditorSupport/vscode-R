import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getWordOrSelection } from '../../selection';

suite('Word execution selection', () => {
    test('a cursor outside a word never selects the entire document', () => {
        const sandbox = sinon.createSandbox();
        const getText = sandbox.stub().returns('dangerous_full_document()');
        sandbox.stub(vscode.window, 'activeTextEditor').value({
            selection: new vscode.Selection(0, 0, 0, 0),
            document: { getWordRangeAtPosition: () => undefined, getText },
        });
        try {
            assert.strictEqual(getWordOrSelection(), undefined);
            sinon.assert.notCalled(getText);
        } finally {
            sandbox.restore();
        }
    });
});
