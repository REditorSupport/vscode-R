import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { createToolConsentService } from '../../toolConsentAdapter';
import { TOOL_MINIMUM_VERSIONS } from '../../toolVersions';

suite('Managed package consent persistence', () => {
    test('dismissal applies to the same minimum version and a changed minimum prompts again', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-tool-adapter-'));
        const sandbox = sinon.createSandbox();
        const values = new Map<string, unknown>([
            ['jgdInstallPromptDismissedMinimumVersion', TOOL_MINIMUM_VERSIONS.jgd],
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
            assert.strictEqual(broker.canPrompt(['jgd'], 'once'), false);
            assert.strictEqual(broker.canPrompt(['jgd'], 'always'), true);
            // A prior minimum's dismissal permits an offer for the current minimum.
            values.set('jgdInstallPromptDismissedMinimumVersion', '0.0.1');
            assert.strictEqual(broker.canPrompt(['jgd'], 'once'), true);
            for (const [index, policy] of (['once', 'always'] as const).entries()) {
                const id = String(index + 1).repeat(32);
                const content = [
                    'vscode-r-package-consent-v1',
                    id,
                    'linux-x86_64|4.5',
                    policy,
                    '1',
                    'jgd',
                    TOOL_MINIMUM_VERSIONS.jgd,
                    '1.2.0',
                    'https://cloud.r-project.org',
                    policy === 'once' ? 'source' : 'win.binary',
                    policy === 'once' ? 'yes' : 'no',
                    '',
                ].join('\n');
                await fs.writeFile(path.join(directory, id + '.request'), content);
                const response = path.join(directory, id + '.response');
                const deadline = Date.now() + 3000;
                while (true) {
                    try {
                        assert.strictEqual(
                            await fs.readFile(response, 'utf8'),
                            policy === 'once' ? 'decline\n' : 'approve\n',
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
                ['jgdInstallPromptDismissedMinimumVersion', TOOL_MINIMUM_VERSIONS.jgd],
            ]);
            assert.strictEqual(broker.canPrompt(['jgd'], 'once'), false);
            assert.strictEqual(broker.canPrompt(['jgd'], 'always'), true);
            assert.strictEqual(prompt.callCount, 2);
            assert.ok(prompt.firstCall.args[0].includes('(source; minimum '));
            assert.ok(prompt.secondCall.args[0].includes('(binary; minimum '));
        } finally {
            await broker.stop();
            sandbox.restore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('rstudioapi has its own dismissal key and prompt text', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-tool-adapter-'));
        const sandbox = sinon.createSandbox();
        const values = new Map<string, unknown>([
            ['jgdInstallPromptDismissedMinimumVersion', TOOL_MINIMUM_VERSIONS.jgd],
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
        const broker = createToolConsentService(directory, () => true, globalState, 5);
        try {
            await broker.start();
            // The remembered jgd choice does not hide the rstudioapi offer.
            assert.strictEqual(broker.canPrompt(['jgd'], 'once'), false);
            assert.strictEqual(broker.canPrompt(['rstudioapi'], 'once'), true);
            const id = '3'.repeat(32);
            await fs.writeFile(
                path.join(directory, id + '.request'),
                [
                    'vscode-r-package-consent-v1',
                    id,
                    'linux-x86_64|4.5',
                    'once',
                    '1',
                    'rstudioapi',
                    TOOL_MINIMUM_VERSIONS.rstudioapi,
                    '0.17.1',
                    'https://cloud.r-project.org',
                    'source',
                    'no',
                    '',
                ].join('\n'),
            );
            const response = path.join(directory, id + '.response');
            const deadline = Date.now() + 3000;
            while (!(await fs.stat(response).catch(() => undefined)) && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.strictEqual(await fs.readFile(response, 'utf8'), 'decline\n');
            assert.deepStrictEqual(update.args, [
                [
                    'rstudioapiInstallPromptDismissedMinimumVersion',
                    TOOL_MINIMUM_VERSIONS.rstudioapi,
                ],
            ]);
            assert.strictEqual(broker.canPrompt(['rstudioapi'], 'once'), false);
            assert.strictEqual(prompt.callCount, 1);
            const text = prompt.firstCall.args[0] as string;
            assert.ok(text.includes('rstudioapi 0.17.1'));
            assert.ok(text.includes('RStudio API emulation is optional'));
            assert.ok(!/plot/i.test(text));
        } finally {
            await broker.stop();
            sandbox.restore();
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
