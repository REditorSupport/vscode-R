import * as assert from 'assert';
import * as vscode from 'vscode';

export async function mochaGlobalSetup(): Promise<void> {
    const extension = vscode.extensions.getExtension('REditorSupport.r');
    assert.ok(extension);
    // Finish activation before tests temporarily replace VS Code's APIs.
    await extension.activate();
}
