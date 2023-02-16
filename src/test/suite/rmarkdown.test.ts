import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import * as assert from 'assert';
import * as fs from 'fs-extra';

import * as rmd from '../../rmarkdown';
import * as ext from '../../extension';


const extension_root: string = path.join(__dirname, '..', '..', '..');
const rmd_files_root: string = path.join(extension_root, 'test', 'rFiles', 'rmarkdown');


function mockActiveTextEditor(document: vscode.TextDocument, sandbox: sinon.SinonSandbox) {
    return sandbox.stub(vscode.window, 'activeTextEditor').value({
        document
    });
}

function mockExtensionContext(sandbox: sinon.SinonSandbox) {
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

suite('rmarkdown', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
        fs.readdirSync(rmd_files_root).forEach((file_path) => {
            if (path.extname(file_path) === '.html') {
                fs.removeSync(path.join(rmd_files_root, file_path));
            }
        });
    });

    test('basic knitting', async () => {
        const rmd_input: string = path.join(rmd_files_root, 'basic.rmd');
        const rmd_output: string = path.join(rmd_files_root, 'basic.html');
        mockActiveTextEditor({
            fileName: rmd_input,
            uri: {
                fsPath: rmd_input
            }
        } as vscode.TextDocument, sandbox);
        mockExtensionContext(sandbox);
        const manager = new rmd.RMarkdownKnitManager();
        await manager.knitRmd(false);
        assert(fs.existsSync(rmd_output));
    }
    ).timeout(10000);
});
