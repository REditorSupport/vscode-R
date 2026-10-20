import * as assert from 'assert';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import * as util from '../../util';
import { resolveBackend, jgdEnabled, CommonPlotManager } from '../../plotViewer';
import { HttpgdViewer } from '../../plotViewer/httpgdViewer';
import { JgdViewer } from '../../plotViewer/jgdViewer';
import { mockExtensionContext } from '../common/mockvscode';

suite('Plot backend setting migration', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    function settings(
        canonical: Record<string, unknown> = {},
        legacy: Record<string, unknown> = {},
    ): void {
        sandbox.stub(util, 'config').returns({
            get: (key: string) => (key === 'plot.backend' ? 'auto' : false),
            inspect: (key: string) => (key === 'plot.backend' ? canonical : legacy),
        } as unknown as vscode.WorkspaceConfiguration);
    }

    const scopes = ['globalValue', 'workspaceValue'] as const;
    for (const canonicalScope of scopes) {
        for (const legacyScope of scopes) {
            test(`canonical ${canonicalScope} versus legacy ${legacyScope}`, () => {
                settings({ [canonicalScope]: 'standard' }, { [legacyScope]: true });
                assert.strictEqual(
                    resolveBackend(),
                    scopes.indexOf(canonicalScope) >= scopes.indexOf(legacyScope)
                        ? 'standard'
                        : 'httpgd',
                );
            });
        }
    }

    test('auto permits the legacy httpgd preference', () => {
        settings({ workspaceValue: 'auto', globalValue: 'jgd' }, { globalValue: true });
        assert.strictEqual(resolveBackend(), 'httpgd');
    });

    test('false shadows a lower-scope legacy true without forcing a backend', () => {
        settings({}, { workspaceValue: false, globalValue: true });
        assert.strictEqual(resolveBackend(), 'auto');
    });

    test('defaults select auto', () => {
        settings();
        assert.strictEqual(resolveBackend(), 'auto');
    });

    test('native overrides the legacy httpgd preference and disables JGD', () => {
        settings({ workspaceValue: 'native' }, { globalValue: true });
        assert.strictEqual(resolveBackend(), 'native');
        assert.strictEqual(jgdEnabled(resolveBackend()), false);
    });

    test('auto prefers an available JGD viewer over httpgd', () => {
        settings({ workspaceValue: 'auto' });
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        const manager = new CommonPlotManager();
        const httpgd = { id: 'httpgd' } as HttpgdViewer;
        const jgd = { id: 'jgd' } as JgdViewer;
        sandbox.stub(manager.httpgdManager, 'getRecentViewer').returns(httpgd);
        sandbox.stub(manager.jgdManager, 'getViewer').returns(jgd);
        assert.strictEqual(manager.activeViewer, jgd);
    });

    test('backend changes replace or remove only the JGD socket mutation', () => {
        const canonical = { workspaceValue: 'jgd' };
        settings(canonical);
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(vscode.commands, 'registerCommand');
        sandbox.stub(vscode.commands, 'executeCommand').resolves();
        const onChange = sandbox.stub(vscode.workspace, 'onDidChangeConfiguration');
        const manager = new CommonPlotManager();
        sandbox.stub(manager.jgdManager, 'initialize');
        const start = sandbox.stub(manager.jgdManager, 'start');
        sandbox.stub(manager, 'getJgdEnvVars').returns({ JGD_SOCKET: 'test-jgd-socket' });
        const collection = extension.extensionContext.environmentVariableCollection as unknown as {
            replace: sinon.SinonStub;
            delete: sinon.SinonStub;
        };
        const replace = collection.replace;
        const remove = collection.delete;

        manager.initialize();
        sinon.assert.calledOnceWithExactly(replace, 'JGD_SOCKET', 'test-jgd-socket');
        sinon.assert.notCalled(remove);
        sinon.assert.calledOnce(start);

        const listener = onChange.firstCall.args[0] as (
            event: vscode.ConfigurationChangeEvent,
        ) => void;
        for (const backend of ['auto', 'native', 'standard', 'httpgd'] as const) {
            canonical.workspaceValue = backend;
            replace.resetHistory();
            remove.resetHistory();
            start.resetHistory();
            listener({
                affectsConfiguration: (key) => key === 'r.plot.backend',
            } as vscode.ConfigurationChangeEvent);
            if (backend === 'auto') {
                sinon.assert.calledOnceWithExactly(replace, 'JGD_SOCKET', 'test-jgd-socket');
                sinon.assert.notCalled(remove);
                sinon.assert.calledOnce(start);
            } else {
                sinon.assert.notCalled(replace);
                sinon.assert.calledOnceWithExactly(remove, 'JGD_SOCKET');
                sinon.assert.notCalled(start);
            }
        }
    });
});
