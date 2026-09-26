import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { mockExtensionContext } from '../common/mockvscode';

interface MenuItem {
    command: string;
    alt?: string;
    when?: string;
}

const extensionRoot = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
    contributes: {
        commands: { command: string }[];
        menus: Record<string, MenuItem[]>;
    };
};
const plotCommands = manifest.contributes.commands.filter(item => item.command.startsWith('r.plot.'));
const toolbarCommands = new Set(manifest.contributes.menus['editor/title']
    .flatMap(item => [item.command, item.alt])
    .filter((command): command is string => !!command?.startsWith('r.plot.')));

suite('Contextual plot commands', () => {
    test('all contributed plot commands are hidden from the Command Palette', () => {
        assert.ok(plotCommands.length > 0);
        for (const { command } of plotCommands) {
            const entries = manifest.contributes.menus.commandPalette.filter(item => item.command === command);
            assert.ok(entries.length > 0, `${command} needs a Command Palette rule`);
            assert.ok(entries.every(item => item.when === 'false'), `${command} must remain contextual`);
        }
        for (const command of toolbarCommands) {
            assert.ok(plotCommands.some(item => item.command === command), `${command} needs a contribution`);
        }
        assert.ok(!plotCommands.some(item => item.command === 'r.plot.showViewers'));
    });

    test('toolbar and webview commands remain registered and route to their httpgd viewer', () => {
        const sandbox = sinon.createSandbox();
        try {
            mockExtensionContext(extensionRoot, sandbox);
            const register = sandbox.stub(vscode.commands, 'registerCommand');
            sandbox.stub(vscode.commands, 'executeCommand').resolves();
            sandbox.stub(vscode.workspace, 'onDidChangeConfiguration');
            const manager = new CommonPlotManager();
            sandbox.stub(manager.jgdManager, 'initialize');
            sandbox.stub(manager.jgdManager, 'start');
            sandbox.stub(manager.jgdManager, 'getEnvVars').returns({});
            const viewer = sandbox.createStubInstance(HttpgdViewer);
            Object.defineProperty(viewer, 'host', { value: 'localhost:1234' });
            viewer.getPanelPath.returns('/plot-viewer');
            manager.httpgdManager.viewers.push(viewer);
            const fallback = sandbox.stub(manager.standardPlotViewer, 'handleCommand');
            sandbox.stub(manager, 'activeViewer').get(() => manager.standardPlotViewer);
            const openUrl = sandbox.stub(manager.httpgdManager, 'openUrl').resolves();
            manager.initialize();

            const invoke = (command: string, ...args: unknown[]) => {
                const registration = register.getCalls().find(call => call.args[0] === command);
                assert.ok(registration, `${command} must remain registered`);
                (registration.args[1] as (...args: unknown[]) => void)(...args);
            };
            for (const command of toolbarCommands) {
                viewer.handleCommand.resetHistory();
                invoke(command, vscode.Uri.parse('webview:/plot-viewer'));
                if (command === 'r.plot.openUrl') {
                    sinon.assert.calledOnce(openUrl);
                } else {
                    assert.strictEqual(viewer.handleCommand.callCount, 1);
                    assert.deepStrictEqual(viewer.handleCommand.firstCall.args, [command.slice('r.plot.'.length)]);
                }
            }
            for (const command of ['showIndex', 'hidePlot']) {
                viewer.handleCommand.resetHistory();
                invoke(`r.plot.${command}`, 'localhost:1234', 'plot-id');
                assert.strictEqual(viewer.handleCommand.callCount, 1);
                assert.deepStrictEqual(viewer.handleCommand.firstCall.args, [command, 'plot-id']);
            }
            sinon.assert.notCalled(fallback);
            assert.ok(!register.getCalls().some(call => call.args[0] === 'r.plot.showViewers'));
        } finally {
            sandbox.restore();
        }
    });
});
