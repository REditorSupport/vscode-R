import * as assert from 'assert';
import { JGD_MINIMUM_VERSION } from '../../jgdVersion';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { createToolConsentService } from '../../toolConsentAdapter';

suite('Managed package consent persistence', () => {
    test('dismissal applies to the same minimum version and a changed minimum prompts again', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-tool-adapter-'));
        const sandbox = sinon.createSandbox();
        const values = new Map<string, unknown>([
            ['jgdInstallPromptDismissedMinimumVersion', JGD_MINIMUM_VERSION],
        ]);
        const globalState: vscode.Memento = {
            keys: () => [...values.keys()],
            get: <T>(key: string, fallback?: T) => (values.get(key) as T | undefined) ?? fallback,
            update: (key: string, value: unknown) => {
                values.set(key, value);
                return Promise.resolve();
            },
        };
        const update = sandbox.spy(globalState, 'update');
        const prompt = sandbox.stub(vscode.window, 'showWarningMessage');
        prompt.onFirstCall().resolves("Don't ask again" as never);
        prompt.onSecondCall().resolves('Install package' as never);
        const broker = createToolConsentService(directory, () => true, globalState, 5);
        try {
            await broker.start();
            assert.strictEqual(broker.canPrompt('auto'), false);
            assert.strictEqual(broker.canPrompt('jgd'), true);
            // A prior minimum's dismissal permits an offer for the current minimum.
            values.set('jgdInstallPromptDismissedMinimumVersion', '0.0.1');
            assert.strictEqual(broker.canPrompt('auto'), true);
            for (const [index, backend] of ['auto', 'jgd'].entries()) {
                const id = String(index + 1).repeat(32);
                const content = [
                    'vscode-r-package-consent-v1',
                    id,
                    'linux-x86_64|4.5',
                    backend,
                    '1',
                    'jgd',
                    JGD_MINIMUM_VERSION,
                    '1.2.0',
                    'https://cloud.r-project.org',
                    'source',
                    'yes',
                    '',
                ].join('\n');
                await fs.writeFile(path.join(directory, id + '.request'), content);
                const response = path.join(directory, id + '.response');
                const deadline = Date.now() + 3000;
                while (true) {
                    try {
                        assert.strictEqual(
                            await fs.readFile(response, 'utf8'),
                            backend === 'auto' ? 'decline\n' : 'approve\n',
                        );
                        break;
                    } catch (error) {
                        if (
                            (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
                            Date.now() > deadline
                        ) {
                            throw error;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                }
            }
            assert.deepStrictEqual(update.args, [
                ['jgdInstallPromptDismissedMinimumVersion', JGD_MINIMUM_VERSION],
            ]);
            assert.strictEqual(broker.canPrompt('auto'), false);
            assert.strictEqual(broker.canPrompt('jgd'), true);
            assert.strictEqual(prompt.callCount, 2);
        } finally {
            await broker.stop();
            sandbox.restore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
