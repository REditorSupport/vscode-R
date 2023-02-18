import * as vscode from 'vscode';
import sinon = require('sinon');
import path = require('path');
import * as ext from '../../extension';

export function mockActiveTextEditor(document: vscode.TextDocument, sandbox: sinon.SinonSandbox) {
    return sandbox.stub(vscode.window, 'activeTextEditor').value({
        document
    });
}

export function mockExtensionContext(extension_root: string, sandbox: sinon.SinonSandbox) {
    const mockExtensionContext = {
        environmentVariableCollection: sandbox.stub(),
        extension: sandbox.stub(),
        extensionMode: sandbox.stub(),
        extensionPath: sandbox.stub(),
        extensionUri: sandbox.stub(),
        globalState: {
            get: sinon.stub(),
            set: sinon.stub()
        },
        globalStorageUri: sandbox.stub(),
        logUri: sandbox.stub(),
        secrets: sandbox.stub(),
        storageUri: sandbox.stub(),
        subscriptions: [],
        workspaceState: {
            get: sinon.stub(),
            update: sinon.stub()
        },
        asAbsolutePath: (relativePath: string) => {
            return path.join(extension_root, relativePath);
        }
    };
    return sandbox.stub(ext, 'extensionContext').value(mockExtensionContext);
}
