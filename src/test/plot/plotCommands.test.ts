import * as assert from 'assert';
import * as session from '../../session';
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
const plotCommands = manifest.contributes.commands.filter((item) =>
    item.command.startsWith('r.plot.'),
);
const toolbarCommands = new Set(
    manifest.contributes.menus['editor/title']
        .flatMap((item) => [item.command, item.alt])
        .filter((command): command is string => !!command?.startsWith('r.plot.')),
);

suite('Contextual plot commands', () => {
    test('contextual plot commands are hidden while Show Viewers remains discoverable', () => {
        assert.ok(plotCommands.length > 0);
        for (const { command } of plotCommands) {
            if (command === 'r.plot.showViewers') {
                continue;
            }
            const entries = manifest.contributes.menus.commandPalette.filter(
                (item) => item.command === command,
            );
            assert.ok(entries.length > 0, `${command} needs a Command Palette rule`);
            assert.ok(
                entries.every((item) => item.when === 'false'),
                `${command} must remain contextual`,
            );
        }
        for (const command of toolbarCommands) {
            assert.ok(
                plotCommands.some((item) => item.command === command),
                `${command} needs a contribution`,
            );
        }
        const showViewers = plotCommands.find((item) => item.command === 'r.plot.showViewers');
        assert.deepStrictEqual(showViewers, {
            title: 'Show Viewers',
            category: 'R Plot',
            command: 'r.plot.showViewers',
            icon: '$(versions)',
        });
        assert.ok(
            !manifest.contributes.menus.commandPalette.some(
                (item) => item.command === 'r.plot.showViewers',
            ),
        );
    });

    test('plot commands remain registered and route to the appropriate viewers', async () => {
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
            const source = {
                sessionId: 'focused',
                host: 'host',
                pid: '123',
                processExited: false,
            } as session.Session;
            sandbox.stub(session, 'activeSession').value(source);
            sandbox.stub(session, 'resolvePlotSession').returns(source);
            const showForSession = sandbox.stub(manager.jgdManager, 'showForSession').returns(true);
            const handleJgdCommand = sandbox.stub();
            const jgdViewer = {
                show: showJgdViewer,
                handleCommand: handleJgdCommand,
            } as unknown as JgdViewer;
            sandbox.stub(manager.jgdManager, 'getViewers').returns([jgdViewer]);
            const viewer = sandbox.createStubInstance(HttpgdViewer);
            Object.defineProperty(viewer, 'host', { value: 'localhost:1234' });
            Object.defineProperty(viewer, 'connection', {
                value: { url: 'http://localhost:1234' },
            });
            Object.defineProperty(viewer, 'connections', {
                value: [{ url: 'http://localhost:1234' }],
            });
            const focused = sandbox.stub(viewer, 'isActive').get(() => true);
            manager.httpgdManager.registerViewer(viewer);
            sandbox.stub(manager, 'activeViewer').get(() => jgdViewer);
            const openUrl = sandbox.stub(manager.httpgdManager, 'openUrl').resolves();
            await manager.initialize();

            const invoke = (command: string, ...args: unknown[]) => {
                const registration = register.getCalls().find((call) => call.args[0] === command);
                assert.ok(registration, `${command} must remain registered`);
                return (registration.args[1] as (...args: unknown[]) => Promise<void>)(...args);
            };
            for (const command of toolbarCommands) {
                viewer.handleCommand.resetHistory();
                await invoke(
                    command,
                    vscode.Uri.parse('webview-panel:webview-panel/webview-RPlot-live-panel'),
                );
                if (command === 'r.plot.openUrl') {
                    sinon.assert.calledOnce(openUrl);
                } else {
                    assert.strictEqual(viewer.handleCommand.callCount, 1);
                    assert.deepStrictEqual(viewer.handleCommand.firstCall.args, [
                        command.slice('r.plot.'.length),
                    ]);
                }
            }
            for (const command of ['showIndex', 'hidePlot']) {
                viewer.handleCommand.resetHistory();
                await invoke(`r.plot.${command}`, 'localhost:1234', 'plot-id');
                assert.strictEqual(viewer.handleCommand.callCount, 1);
                assert.deepStrictEqual(viewer.handleCommand.firstCall.args, [command, 'plot-id']);
            }
            viewer.handleCommand.resetHistory();
            await invoke('r.plot.nextPlot', 'httpgd:ended-session');
            focused.get(() => false);
            await invoke(
                'r.plot.prevPlot',
                vscode.Uri.parse('webview-panel:webview-panel/webview-RPlot-ended-panel'),
            );
            assert.strictEqual(viewer.handleCommand.callCount, 0);
            sinon.assert.notCalled(handleJgdCommand);
            await invoke('r.plot.showViewers');
            sinon.assert.calledOnceWithExactly(showForSession, source);
            assert.strictEqual(viewer.show.callCount, 0);
            sinon.assert.notCalled(showJgdViewer);
            sinon.assert.notCalled(handleJgdCommand);
        } finally {
            sandbox.restore();
        }
    });
});
