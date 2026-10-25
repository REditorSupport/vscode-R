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
    let sessionState: { autoPrompted: boolean };
    const services: ToolConsentService[] = [];

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-package-consent-'));
        autoPromptEnabled = true;
        failPreferenceSave = false;
        choice = 'install';
        prompts = [];
        sessionState = { autoPrompted: false };
    });

    teardown(async () => {
        await Promise.all(services.splice(0).map((service) => service.stop()));
        await fs.rm(directory, { recursive: true, force: true });
    });

    function service(
        prompt?: (request: ToolConsentRequest) => Promise<ToolConsentChoice>,
        requestDirectory = directory,
    ): ToolConsentService {
        const result = new ToolConsentService({
            directory: requestDirectory,
            isEnabled: () => true,
            isAutoPromptEnabled: () => autoPromptEnabled,
            sessionState,
            rememberAutoPromptDismissal: () => {
                if (failPreferenceSave) {
                    return Promise.reject(new Error('settings unavailable'));
                }
                autoPromptEnabled = false;
                return Promise.resolve();
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

    async function writeRequest(
        id: string,
        backend: 'jgd' | 'auto',
        version?: string,
        requestDirectory = directory,
    ): Promise<string> {
        const request = path.join(requestDirectory, `${id}.request`);
        await fs.writeFile(request, requestContent(id, backend, version));
        return request;
    }

    test('explicit jgd asks on each request and does not alter automatic prompt preference', async () => {
        const broker = service();
        await broker.start();
        assert.strictEqual(broker.canPrompt('jgd'), true);
        assert.strictEqual(broker.canPrompt('auto'), true);
        assert.strictEqual(broker.canPrompt('httpgd'), false);
        for (const id of ['1'.repeat(32), '2'.repeat(32)]) {
            await writeRequest(id, 'jgd');
            assert.strictEqual(
                await waitForFile(path.join(directory, `${id}.response`)),
                'approve\n',
            );
            await fs.rm(path.join(directory, `${id}.request`), { force: true });
            await fs.rm(path.join(directory, `${id}.response`), { force: true });
        }
        assert.strictEqual(prompts.length, 2);
        assert.strictEqual(autoPromptEnabled, true);
        assert.deepStrictEqual(prompts[0].packages, [
            {
                name: 'jgd',
                minimumVersion: '0.1.0',
                version: '1.2.0',
                repository: 'https://cloud.r-project.org',
                packageType: 'source',
                sourceBuild: true,
            },
        ]);
    });

    test('parses package plans written with Windows CRLF line endings', () => {
        const id = 'b'.repeat(32);
        const request = parseToolConsentRequest(
            id,
            requestContent(id, 'jgd').replace(/\n/g, '\r\n'),
        );
        assert.strictEqual(request.backend, 'jgd');
        assert.strictEqual(request.packages[0].sourceBuild, true);
    });

    test('automatic prompt is limited to one per host session across services', async () => {
        const first = service();
        await first.start();
        const firstId = '3'.repeat(32);
        choice = 'notNow';
        await writeRequest(firstId, 'auto');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${firstId}.response`)),
            'decline\n',
        );
        assert.strictEqual(autoPromptEnabled, true);
        assert.strictEqual(sessionState.autoPrompted, true);
        assert.strictEqual(first.canPrompt('auto'), false);
        await first.stop();

        const secondDirectory = path.join(directory, 'another-service');
        await fs.mkdir(secondDirectory);
        const secondService = service(undefined, secondDirectory);
        await secondService.start();
        assert.strictEqual(secondService.canPrompt('auto'), false);
        const secondId = '4'.repeat(32);
        await writeRequest(secondId, 'auto', undefined, secondDirectory);
        assert.strictEqual(
            await waitForFile(path.join(secondDirectory, `${secondId}.response`)),
            'decline\n',
        );
        assert.strictEqual(prompts.length, 1);
        await secondService.stop();

        // A fresh state represents a new VS Code extension-host session.
        sessionState = { autoPrompted: false };
        const newHostDirectory = path.join(directory, 'new-host');
        await fs.mkdir(newHostDirectory);
        const nextHost = service(undefined, newHostDirectory);
        await nextHost.start();
        assert.strictEqual(nextHost.canPrompt('auto'), true);
        choice = 'install';
        const thirdId = '5'.repeat(32);
        await writeRequest(thirdId, 'auto', undefined, newHostDirectory);
        assert.strictEqual(
            await waitForFile(path.join(newHostDirectory, `${thirdId}.response`)),
            'approve\n',
        );
        assert.strictEqual(prompts.length, 2);
    });

    test("only Don't ask again persists suppression; explicit requests ignore it", async () => {
        const broker = service();
        await broker.start();
        choice = 'dontAskAgain';
        const firstId = '6'.repeat(32);
        assert.strictEqual(broker.canPrompt('auto'), true);
        await writeRequest(firstId, 'auto');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${firstId}.response`)),
            'decline\n',
        );
        assert.strictEqual(autoPromptEnabled, false);
        assert.strictEqual(broker.canPrompt('auto'), false);
        assert.strictEqual(broker.canPrompt('jgd'), true);

        choice = 'install';
        const explicitId = '7'.repeat(32);
        await writeRequest(explicitId, 'jgd');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${explicitId}.response`)),
            'approve\n',
        );
        assert.strictEqual(prompts.length, 2);
        await broker.stop();

        sessionState = { autoPrompted: false };
        const nextHostDirectory = path.join(directory, 'next-host');
        await fs.mkdir(nextHostDirectory);
        const nextHost = service(undefined, nextHostDirectory);
        await nextHost.start();
        const suppressedId = '8'.repeat(32);
        await writeRequest(suppressedId, 'auto', undefined, nextHostDirectory);
        assert.strictEqual(
            await waitForFile(path.join(nextHostDirectory, `${suppressedId}.response`)),
            'decline\n',
        );
        assert.strictEqual(prompts.length, 2);

        autoPromptEnabled = true;
        sessionState = { autoPrompted: false };
        const resetHostDirectory = path.join(directory, 'reset-host');
        await fs.mkdir(resetHostDirectory);
        const resetHost = service(undefined, resetHostDirectory);
        await resetHost.start();
        const resetId = '9'.repeat(32);
        await writeRequest(resetId, 'auto', undefined, resetHostDirectory);
        assert.strictEqual(
            await waitForFile(path.join(resetHostDirectory, `${resetId}.response`)),
            'approve\n',
        );
        assert.strictEqual(prompts.length, 3);
    });

    test('parallel automatic requests show one prompt and a changed plan cannot be approved', async () => {
        let finishPrompt!: (value: ToolConsentChoice) => void;
        const broker = service(
            () =>
                new Promise((resolve) => {
                    finishPrompt = resolve;
                }),
        );
        const firstId = '7'.repeat(32);
        const secondId = '8'.repeat(32);
        await writeRequest(firstId, 'auto');
        await writeRequest(secondId, 'auto');
        await broker.start();
        const deadline = Date.now() + 3000;
        while (prompts.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(prompts.length, 1);
        const promptedId = prompts[0].id;
        const declinedId = promptedId === firstId ? secondId : firstId;
        assert.strictEqual(
            await waitForFile(path.join(directory, `${declinedId}.response`)),
            'decline\n',
        );
        await fs.writeFile(
            path.join(directory, `${promptedId}.request`),
            requestContent(promptedId, 'auto', '1.3.0'),
        );
        finishPrompt('install');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${promptedId}.response`)),
            'decline\n',
        );
    });

    test('a failed automatic dismissal save never grants installation', async () => {
        failPreferenceSave = true;
        choice = 'dontAskAgain';
        const broker = service();
        await broker.start();
        const id = '9'.repeat(32);
        await writeRequest(id, 'auto');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 1);
        assert.strictEqual(autoPromptEnabled, true);
    });

    test('Not now, dismiss, and install do not change the persistent setting', async () => {
        for (const [index, result] of (['notNow', 'dismiss', 'install'] as const).entries()) {
            autoPromptEnabled = true;
            choice = result;
            sessionState = { autoPrompted: false };
            const hostDirectory = path.join(directory, `host-${index}`);
            await fs.mkdir(hostDirectory);
            const broker = service(undefined, hostDirectory);
            await broker.start();
            const id = String(index + 1).repeat(32);
            await writeRequest(id, 'auto', undefined, hostDirectory);
            const expected = result === 'install' ? 'approve\n' : 'decline\n';
            assert.strictEqual(
                await waitForFile(path.join(hostDirectory, `${id}.response`)),
                expected,
            );
            assert.strictEqual(autoPromptEnabled, true);
        }
    });

    test('shutdown while an automatic prompt is pending cannot publish a late approval', async () => {
        let finishPrompt!: (value: ToolConsentChoice) => void;
        let promptStarted!: () => void;
        let dismissals = 0;
        const started = new Promise<void>((resolve) => {
            promptStarted = resolve;
        });
        const broker = new ToolConsentService({
            directory,
            isEnabled: () => true,
            isAutoPromptEnabled: () => true,
            sessionState,
            rememberAutoPromptDismissal: () => {
                dismissals++;
                return Promise.resolve();
            },
            prompt: async (request) => {
                prompts.push(request);
                promptStarted();
                return new Promise((resolve) => {
                    finishPrompt = resolve;
                });
            },
            intervalMs: 5,
        });
        services.push(broker);
        await broker.start();
        const id = 'a'.repeat(32);
        await writeRequest(id, 'auto');
        await started;
        await broker.stop();
        finishPrompt('install');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 1);
        assert.strictEqual(dismissals, 0);
    });
});
