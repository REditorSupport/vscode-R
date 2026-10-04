import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import * as assert from 'assert';
import * as fs from 'fs-extra';

import { mockExtensionContext } from '../common';
import * as session from '../../session';
import * as workspace from '../../workspaceViewer';
import * as extension from '../../extension';

const extension_root: string = path.join(__dirname, '..', '..', '..');
const workspaceFile = path.join(extension_root, 'src', 'test', 'testdata', 'session', 'workspace.json');

suite('Workspace Viewer', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: workspace.WorkspaceDataProvider;
    let tree: vscode.TreeView<vscode.TreeItem>;
    let first: session.Session;
    let second: session.Session;
    const data = (name: string): session.WorkspaceData => ({ search: [], loaded_namespaces: [], globalenv: {
        [name]: { class: 'list', type: 'list', length: 1, str: name, has_children: true }
    } });
    const envNodes = async (): Promise<workspace.GlobalEnvItem[]> =>
        await provider.getChildren((await provider.getChildren()).find(item => item.id === 'globalenv')) as workspace.GlobalEnvItem[];

    setup(async () => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(extension_root, sandbox);
        sandbox.stub(vscode.commands, 'registerCommand').returns(new vscode.Disposable(() => undefined));
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        tree = { dispose: () => undefined } as vscode.TreeView<vscode.TreeItem>;
        sandbox.stub(vscode.window, 'createTreeView').returns(tree);
        provider = new workspace.WorkspaceDataProvider();
        sandbox.stub(extension, 'rWorkspace').value(provider);
        first = session.registerSessionTransport('workspace-first', 'host', '/first', () => Promise.resolve(first.workspaceData));
        second = session.registerSessionTransport('workspace-second', 'host', '/second', () => Promise.resolve(second.workspaceData));
        first.label = 'First'; first.pid = '101'; second.label = 'Second'; second.pid = '202';
        first.workspaceData = JSON.parse(fs.readFileSync(workspaceFile, 'utf8')) as session.WorkspaceData;
        second.workspaceData = data('second_only');
        first.execute = sandbox.stub().resolves(); second.execute = sandbox.stub().resolves();
        await session.activateSession(first);
    });
    teardown(() => {
        session.unregisterSessionTransport(first); session.unregisterSessionTransport(second);
        session.deferWorkspaceRefresh(); sandbox.restore();
    });

    test('shows namespace roots and environment with the selected session name and PID', async () => {
        const nodes = await provider.getChildren();
        assert.strictEqual(nodes.length, 3);
        assert.strictEqual((await provider.getChildren(nodes[0])).length, 10);
        assert.strictEqual((await provider.getChildren(nodes[1])).length, 14);
        assert.strictEqual((await envNodes()).length, 9);
        assert.strictEqual(tree.description, 'First · PID 101');
        assert.ok((await envNodes()).every(node => node.owner === first));
        await session.activateSession(second);
        assert.strictEqual(tree.description, 'Second · PID 202');
        assert.deepStrictEqual((await envNodes()).map(node => node.label), ['second_only']);
    });

    test('late child replies and old nodes cannot mix two session trees', async () => {
        second.workspaceData = data('same_name'); session.updateSessionWorkspace(first, data('same_name'));
        let reply!: (value: unknown) => void;
        const request = sandbox.stub().callsFake(() => new Promise(resolve => { reply = resolve; }));
        first.requester = request;
        const oldNode = (await envNodes())[0];
        const pending = provider.getChildren(oldNode);
        await session.activateSession(second);
        const secondRequest = sandbox.stub().resolves({ children: [{ str: 'second child', class: 'numeric', type: 'double', has_children: false }] });
        second.requester = secondRequest;
        reply({ children: [{ str: 'first child', class: 'numeric', type: 'double', has_children: false }], next_start: 501 });
        assert.deepStrictEqual(await pending, []);
        assert.deepStrictEqual(await provider.getChildren(oldNode), []);
        sinon.assert.notCalled(secondRequest);
        const children = await provider.getChildren((await envNodes())[0]);
        assert.strictEqual(children[0].description, 'second child');
        assert.strictEqual((children[0] as workspace.GlobalEnvItem).owner, second);
        sinon.assert.calledOnce(request); sinon.assert.calledOnce(secondRequest);
    });

    test('background workspace replies update their owner without selecting it', async () => {
        let reply!: (value: unknown) => void;
        first.requester = () => new Promise(resolve => { reply = resolve; });
        const pending = session.updateWorkspace();
        await session.activateSession(second);
        reply(data('first_late')); await pending;
        assert.strictEqual(session.activeSession, second);
        assert.deepStrictEqual((await envNodes()).map(node => node.label), ['second_only']);
        await session.activateSession(first);
        assert.deepStrictEqual((await envNodes()).map(node => node.label), ['first_late']);
    });

    test('readiness updates reenable workspace actions without another focus event', async () => {
        first.workspaceUnavailable = 'R is starting…';
        session.updateSessionWorkspace(first, first.workspaceData);
        assert.deepStrictEqual(await envNodes(), []);
        sinon.assert.calledWith(vscode.commands.executeCommand as sinon.SinonStub, 'setContext', 'rSessionActive', false);
        first.workspaceUnavailable = undefined;
        session.updateSessionWorkspace(first, data('ready'));
        assert.strictEqual(tree.message, undefined);
        assert.deepStrictEqual((await envNodes()).map(node => node.label), ['ready']);
        sinon.assert.calledWith(vscode.commands.executeCommand as sinon.SinonStub, 'setContext', 'rSessionActive', true);
    });

    test('View and Remove use the node owner and quote non-syntactic names', async () => {
        session.updateSessionWorkspace(first, data('odd " name'));
        const node = (await envNodes())[0];
        await session.activateSession(second);
        await workspace.viewItem(node); await workspace.removeItem(node);
        sinon.assert.calledWithExactly(first.execute as sinon.SinonStub, String.raw`View(get("odd \" name", envir = .GlobalEnv, inherits = FALSE), title = "odd \" name")`);
        sinon.assert.calledWithExactly(first.execute as sinon.SinonStub, 'rm(list = "odd \\" name", envir = .GlobalEnv)');
        sinon.assert.notCalled(second.execute as sinon.SinonStub);
    });

    test('clear confirmation captures the displayed session before switching', async () => {
        const prompt = sandbox.stub(vscode.window, 'showInformationMessage').callsFake(async () => {
            await session.activateSession(second);
            return 'Confirm' as unknown as vscode.MessageItem;
        });
        await workspace.clearWorkspace();
        sinon.assert.calledOnce(prompt);
        assert.match(String(prompt.firstCall.args[0]), /First.*101/);
        sinon.assert.calledOnce(first.execute as sinon.SinonStub);
        sinon.assert.notCalled(second.execute as sinon.SinonStub);
    });

    test('save and load dialogs keep the original owner and working directory', async () => {
        const saved = vscode.Uri.file(path.join(first.workingDir, 'saved.RData'));
        const save = sandbox.stub(vscode.window, 'showSaveDialog').callsFake(async options => {
            assert.strictEqual(options?.defaultUri?.toString(), vscode.Uri.file(path.join(first.workingDir, 'workspace.RData')).toString());
            await session.activateSession(second);
            return saved;
        });
        await workspace.saveWorkspace();
        sinon.assert.calledOnce(save);
        sinon.assert.calledWithExactly(first.execute as sinon.SinonStub, `save.image(${JSON.stringify(saved.fsPath)})`);
        const open = sandbox.stub(vscode.window, 'showOpenDialog').callsFake(async options => {
            assert.strictEqual(options?.defaultUri?.toString(), vscode.Uri.file(second.workingDir).toString());
            await session.activateSession(first);
            return [saved];
        });
        await workspace.loadWorkspace();
        sinon.assert.calledOnce(open);
        sinon.assert.calledWithExactly(second.execute as sinon.SinonStub, `load(${JSON.stringify(saved.fsPath)})`);
    });

    test('unavailable and detached sessions clear the tree and reject stale actions', async () => {
        const node = (await envNodes())[0];
        first.workspaceUnavailable = 'R session stopped.';
        provider.refresh();
        assert.deepStrictEqual(await envNodes(), []);
        assert.strictEqual(tree.message, 'R session stopped.');
        const warning = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        await workspace.removeItem(node);
        sinon.assert.calledOnce(warning); sinon.assert.notCalled(first.execute as sinon.SinonStub);
        session.unregisterSessionTransport(first);
        assert.strictEqual(session.activeSession, undefined);
        assert.strictEqual(provider.owner, undefined);
        assert.deepStrictEqual(await envNodes(), []);
        assert.match(tree.message ?? '', /Select an R Interactive window/);
        await session.activateSession(second);
        await workspace.removeItem(node);
        sinon.assert.notCalled(second.execute as sinon.SinonStub);
    });
});
