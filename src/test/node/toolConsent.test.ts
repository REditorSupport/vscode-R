import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseToolConsentRequest,
    ToolConsentChoice,
    ToolConsentRequest,
    ToolConsentService,
} from '../../toolConsent';

function requestContent(id: string, backend: 'jgd' | 'auto', version = '1.2.0'): string {
    return [
        'vscode-r-package-consent-v1',
        id,
        'linux-x86_64|4.5',
        backend,
        '1',
        'jgd',
        '0.1.0',
        version,
        'https://cloud.r-project.org',
        'source',
        'yes',
        '',
    ].join('\n');
}

async function waitForFile(file: string): Promise<string> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try {
            return await fs.readFile(file, 'utf8');
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error(`Timed out waiting for ${file}`);
}

suite('managed package consent bridge', () => {
    let directory: string;
    let autoPromptEnabled: boolean;
    let failPreferenceSave: boolean;
    let choice: ToolConsentChoice;
    let prompts: ToolConsentRequest[];
    const services: ToolConsentService[] = [];

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-package-consent-'));
        autoPromptEnabled = true;
        failPreferenceSave = false;
        choice = 'install';
        prompts = [];
    });

    teardown(async () => {
        await Promise.all(services.splice(0).map((service) => service.stop()));
        await fs.rm(directory, { recursive: true, force: true });
    });

    function service(prompt?: (request: ToolConsentRequest) => Promise<ToolConsentChoice>): ToolConsentService {
        const result = new ToolConsentService({
            directory,
            isEnabled: () => true,
            isAutoPromptEnabled: () => autoPromptEnabled,
            rememberAutoPromptShown: async () => {
                if (failPreferenceSave) throw new Error('settings unavailable');
                autoPromptEnabled = false;
            },
            prompt: async (request) => {
                prompts.push(request);
                return prompt ? prompt(request) : choice;
            },
            intervalMs: 5,
        });
        services.push(result);
        return result;
    }

    async function writeRequest(id: string, backend: 'jgd' | 'auto', version?: string): Promise<string> {
        const request = path.join(directory, `${id}.request`);
        await fs.writeFile(request, requestContent(id, backend, version));
        return request;
    }

    test('explicit jgd asks on each request and does not alter automatic prompt preference', async () => {
        const broker = service();
        await broker.start();
        for (const id of ['1'.repeat(32), '2'.repeat(32)]) {
            await writeRequest(id, 'jgd');
            assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'approve\n');
            await fs.rm(path.join(directory, `${id}.request`), { force: true });
            await fs.rm(path.join(directory, `${id}.response`), { force: true });
        }
        assert.strictEqual(prompts.length, 2);
        assert.strictEqual(autoPromptEnabled, true);
        assert.deepStrictEqual(prompts[0].packages, [{
            name: 'jgd',
            minimumVersion: '0.1.0',
            version: '1.2.0',
            repository: 'https://cloud.r-project.org',
            packageType: 'source',
            sourceBuild: true,
        }]);
    });

    test('parses package plans written with Windows CRLF line endings', () => {
        const id = 'b'.repeat(32);
        const request = parseToolConsentRequest(id, requestContent(id, 'jgd').replace(/\n/g, '\r\n'));
        assert.strictEqual(request.backend, 'jgd');
        assert.strictEqual(request.packages[0].sourceBuild, true);
    });

    test('automatic prompt is remembered, explicit jgd still prompts, and settings can reset it', async () => {
        const first = service();
        await first.start();
        const firstId = '3'.repeat(32);
        await writeRequest(firstId, 'auto');
        assert.strictEqual(await waitForFile(path.join(directory, `${firstId}.response`)), 'approve\n');
        assert.strictEqual(autoPromptEnabled, false);
        await first.stop();

        await fs.rm(path.join(directory, `${firstId}.request`), { force: true });
        await fs.rm(path.join(directory, `${firstId}.response`), { force: true });
        const restarted = service();
        await restarted.start();
        const secondId = '4'.repeat(32);
        await writeRequest(secondId, 'auto');
        assert.strictEqual(await waitForFile(path.join(directory, `${secondId}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 1);

        const explicitId = '5'.repeat(32);
        await writeRequest(explicitId, 'jgd');
        assert.strictEqual(await waitForFile(path.join(directory, `${explicitId}.response`)), 'approve\n');
        assert.strictEqual(prompts.length, 2);
        assert.strictEqual(autoPromptEnabled, false);

        autoPromptEnabled = true;
        const resetId = '6'.repeat(32);
        await writeRequest(resetId, 'auto');
        assert.strictEqual(await waitForFile(path.join(directory, `${resetId}.response`)), 'approve\n');
        assert.strictEqual(prompts.length, 3);
    });

    test('parallel automatic requests show one prompt and a changed plan cannot be approved', async () => {
        let finishPrompt!: (value: ToolConsentChoice) => void;
        const broker = service(() => new Promise((resolve) => {
            finishPrompt = resolve;
        }));
        const firstId = '7'.repeat(32);
        const secondId = '8'.repeat(32);
        await writeRequest(firstId, 'auto');
        await writeRequest(secondId, 'auto');
        await broker.start();
        const secondResponse = waitForFile(path.join(directory, `${secondId}.response`));
        const deadline = Date.now() + 3000;
        while (prompts.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(prompts.length, 1);
        assert.strictEqual(prompts[0].id, firstId);
        assert.strictEqual(await secondResponse, 'decline\n');
        await fs.writeFile(path.join(directory, `${firstId}.request`), requestContent(firstId, 'auto', '1.3.0'));
        finishPrompt('install');
        assert.strictEqual(await waitForFile(path.join(directory, `${firstId}.response`)), 'decline\n');
    });

    test('automatic prompt is skipped when persisting the one-time setting fails', async () => {
        failPreferenceSave = true;
        const broker = service();
        await broker.start();
        const id = '9'.repeat(32);
        await writeRequest(id, 'auto');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 0);
        assert.strictEqual(autoPromptEnabled, true);
    });

    test('declined automatic choices are remembered without suppressing explicit jgd prompts', async () => {
        const broker = service();
        await broker.start();
        const automaticChoices: ToolConsentChoice[] = ['notNow', 'dismiss', 'dontAskAgain'];
        for (const [index, automaticChoice] of automaticChoices.entries()) {
            autoPromptEnabled = true;
            choice = automaticChoice;
            const automaticId = String(index + 1).repeat(31) + String(index + 1);
            await writeRequest(automaticId, 'auto');
            assert.strictEqual(
                await waitForFile(path.join(directory, `${automaticId}.response`)),
                'decline\n',
            );
            assert.strictEqual(autoPromptEnabled, false);

            choice = 'install';
            const explicitId = String(index + 4).repeat(31) + String(index + 4);
            await writeRequest(explicitId, 'jgd');
            assert.strictEqual(
                await waitForFile(path.join(directory, `${explicitId}.response`)),
                'approve\n',
            );
        }
        assert.deepStrictEqual(prompts.map((request) => request.backend), [
            'auto', 'jgd', 'auto', 'jgd', 'auto', 'jgd',
        ]);
    });

    test('shutdown during automatic preference save never opens the prompt', async () => {
        let finishSave!: () => void;
        let saveStarted!: () => void;
        const started = new Promise<void>((resolve) => { saveStarted = resolve; });
        const broker = new ToolConsentService({
            directory,
            isEnabled: () => true,
            isAutoPromptEnabled: () => true,
            rememberAutoPromptShown: () => new Promise((resolve) => {
                finishSave = resolve;
                saveStarted();
            }),
            prompt: async (request) => {
                prompts.push(request);
                return 'install';
            },
            intervalMs: 5,
        });
        services.push(broker);
        await broker.start();
        const id = 'a'.repeat(32);
        await writeRequest(id, 'auto');
        await started;
        await broker.stop();
        finishSave();
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 0);
    });
});
