import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as util from '../../util';
import { resolveBackend } from '../../plotViewer';

suite('Plot backend setting migration', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => { sandbox = sinon.createSandbox(); });
    teardown(() => { sandbox.restore(); });

    function settings(
        canonical: Record<string, unknown> = {},
        legacy: Record<string, unknown> = {}
    ): void {
        sandbox.stub(util, 'config').returns({
            get: (key: string) => key === 'plot.backend' ? 'auto' : false,
            inspect: (key: string) => key === 'plot.backend' ? canonical : legacy
        } as unknown as vscode.WorkspaceConfiguration);
    }

    const scopes = ['globalValue', 'workspaceValue', 'workspaceFolderValue'] as const;
    for (const canonicalScope of scopes) {
        for (const legacyScope of scopes) {
            test(`canonical ${canonicalScope} versus legacy ${legacyScope}`, () => {
                settings({ [canonicalScope]: 'standard' }, { [legacyScope]: true });
                assert.strictEqual(resolveBackend(),
                    scopes.indexOf(canonicalScope) >= scopes.indexOf(legacyScope) ? 'standard' : 'httpgd');
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
});
