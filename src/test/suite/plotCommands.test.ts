import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommonPlotManager } from '../../plotViewer';
import { HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { JgdViewer } from '../../plotViewer/jgdViewer';
import { mockExtensionContext } from '../common/mockvscode';

interface MenuItem {
    command: string;
    alt?: string;
    when?: string;
}

const extensionRoot = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')) as {
    contributes: {
        commands: { command: string; title?: string; category?: string; icon?: string }[];
        menus: Record<string, MenuItem[]>;
    };
};
const plotCommands = manifest.contributes.commands.filter(item => item.command.startsWith('r.plot.'));
const toolbarCommands = new Set(manifest.contributes.menus['editor/title']
    .flatMap(item => [item.command, item.alt])
    .filter((command): command is string => !!command?.startsWith('r.plot.')));

suite('Contextual plot commands', () => {
    test('contextual plot commands are hidden while Show Viewers remains discoverable', () => {
        assert.ok(plotCommands.length > 0);
        for (const { command } of plotCommands) {
            if (command === 'r.plot.showViewers') {
                continue;
            }
            const entries = manifest.contributes.menus.commandPalette.filter(item => item.command === command);
            assert.ok(entries.length > 0, `${command} needs a Command Palette rule`);
            assert.ok(entries.every(item => item.when === 'false'), `${command} must remain contextual`);
        }
        for (const command of toolbarCommands) {
            assert.ok(plotCommands.some(item => item.command === command), `${command} needs a contribution`);
        }
        const showViewers = plotCommands.find(item => item.command === 'r.plot.showViewers');
        assert.deepStrictEqual(showViewers, {
            title: 'Show Viewers',
            category: 'R Plot',
            command: 'r.plot.showViewers',
            icon: '$(versions)'
        });
        assert.ok(!manifest.contributes.menus.commandPalette.some(item => item.command === 'r.plot.showViewers'));
    });

    test('plot commands remain registered and route to the appropriate viewers', () => {
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
            const showJgdViewer = sandbox.stub();
            const jgdViewer = { show: showJgdViewer, handleCommand: sandbox.stub() } as unknown as JgdViewer;
            sandbox.stub(manager.jgdManager, 'getViewer').returns(jgdViewer);
            const viewer = sandbox.createStubInstance(HttpgdViewer);
            Object.defineProperty(viewer, 'host', { value: 'localhost:1234' });
            viewer.getPanelPath.returns('/plot-viewer');
            manager.httpgdManager.viewers.push(viewer);
            const showStandardViewer = sandbox.stub(manager.standardPlotViewer, 'show');
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
            invoke('r.plot.showViewers');
            assert.strictEqual(viewer.show.callCount, 1);
            assert.deepStrictEqual(viewer.show.firstCall.args, [true]);
            sinon.assert.calledOnceWithExactly(showJgdViewer, true);
            sinon.assert.calledOnceWithExactly(showStandardViewer, true);
            sinon.assert.notCalled(fallback);
        } finally {
            sandbox.restore();
        }
    });
});
