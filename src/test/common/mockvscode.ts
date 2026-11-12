import * as vscode from 'vscode';
import sinon = require('sinon');
import path = require('path');
import * as os from 'os';
import * as ext from '../../extension';

export function mockActiveTextEditor(document: vscode.TextDocument, sandbox: sinon.SinonSandbox) {
    return sandbox.stub(vscode.window, 'activeTextEditor').value({
        document,
    });
}

export function mockExtensionContext(extension_root: string, sandbox: sinon.SinonSandbox) {
    const mockExtensionContext = {
        environmentVariableCollection: {
            persistent: false,
            replace: sandbox.stub(),
            delete: sandbox.stub(),
        },
        extension: sandbox.stub(),
        extensionMode: sandbox.stub(),
        extensionPath: extension_root,
        extensionUri: vscode.Uri.file(extension_root),
        globalState: {
            get: sinon.stub().callsFake((key: string, defaultValue?: unknown) => defaultValue),
            update: sinon.stub().resolves(),
        },
        globalStorageUri: vscode.Uri.file(
            path.join(os.tmpdir(), 'vscode-r-test-global-storage', String(process.pid)),
        ),
        logUri: sandbox.stub(),
        secrets: {
            get: sandbox.stub().resolves(undefined),
            store: sandbox.stub().resolves(),
            delete: sandbox.stub().resolves(),
        },
        storageUri: sandbox.stub(),
        subscriptions: [],
        workspaceState: {
            get: sinon.stub().callsFake((key: string, defaultValue?: unknown) => defaultValue),
            update: sinon.stub().resolves(),
        },
        asAbsolutePath: (relativePath: string) => {
            return path.join(extension_root, relativePath);
        },
    };
    return sandbox.stub(ext, 'extensionContext').value(mockExtensionContext);
}
