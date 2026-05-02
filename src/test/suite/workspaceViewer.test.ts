import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import * as assert from 'assert';
import * as fs from 'fs-extra';

import { mockExtensionContext } from '../common';
import * as session from '../../session';
import * as workspace from '../../workspaceViewer';

const extension_root: string = path.join(__dirname, '..', '..', '..');
const workspaceFile = path.join(extension_root, 'src', 'test', 'testdata', 'session', 'workspace.json');

function mockWorkspaceData(sandbox: sinon.SinonSandbox) {
    const content = fs.readFileSync(workspaceFile, 'utf8');
    const workspaceData = JSON.parse(content) as session.WorkspaceData;
    return sandbox.stub(session, 'workspaceData').value(workspaceData);
}

suite('Workspace Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let workspaceViewer: workspace.WorkspaceDataProvider;
    let nodes: vscode.TreeItem[];

    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    test('has 3 nodes', async () => {
        mockExtensionContext(extension_root, sandbox);
        mockWorkspaceData(sandbox);
        workspaceViewer = new workspace.WorkspaceDataProvider();
        workspaceViewer.refresh();
        nodes = await workspaceViewer.getChildren();
        assert.strictEqual(nodes.length, 3);
    });

    test('search node', async () => {
        const search = await workspaceViewer.getChildren(nodes[0]);
        assert.strictEqual(search.length, 10);
    });

    test('attached node', async () => {
        const attached = await workspaceViewer.getChildren(nodes[1]);
        assert.strictEqual(attached.length, 14);
    });

    test('env node', async () => {
        const env: workspace.GlobalEnvItem[] = await workspaceViewer.getChildren(nodes[2]) as workspace.GlobalEnvItem[];
        assert.strictEqual(env.length, 9);
    });
});