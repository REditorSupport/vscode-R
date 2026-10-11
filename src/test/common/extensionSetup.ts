import * as assert from 'assert';
import * as path from 'path';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export async function mochaGlobalSetup(): Promise<void> {
    const extension = vscode.extensions.getExtension('REditorSupport.r');
    assert.ok(extension);
    // Startup activation and the initial language client otherwise race tests
    // that temporarily replace VS Code's configuration and workspace APIs.
    await extension.activate();
    const { extensionContext } = createRequire(__filename)(path.join(extension.extensionPath, 'dist/extension')) as {
        extensionContext: vscode.ExtensionContext;
    };
    const service = extensionContext.subscriptions.find(item =>
        (item as { clients?: unknown }).clients instanceof Map) as { clients: Map<string, LanguageClient> } | undefined;
    assert.ok(service, 'Language service must be registered before extension tests');
    const deadline = Date.now() + 20000;
    while (![...service.clients.values()].some(client => client.isRunning())) {
        assert.ok(Date.now() < deadline, 'Timed out starting the initial R language server before extension tests');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
