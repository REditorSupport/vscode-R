import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseToolConsentRequest,
    ToolConsentChoice,
    ToolConsentRequest,
    ToolConsentService,
    ToolConsentSessionState,
} from '../../toolConsent';

type Policy = 'always' | 'once';

function requestContent(
    id: string,
    policy: Policy,
    version = '1.2.0',
    packageName = 'jgd',
    minimumVersion = '0.1.0',
): string {
    return [
        'vscode-r-package-consent-v1',
        id,
        'linux-x86_64|4.5',
        policy,
        '1',
        packageName,
        minimumVersion,
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
    let dismissed: Set<string>;
    let failPreferenceSave: boolean;
    let choice: ToolConsentChoice;
    let prompts: ToolConsentRequest[];
    let sessionState: ToolConsentSessionState;
    const services: ToolConsentService[] = [];

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-package-consent-'));
        dismissed = new Set();
        failPreferenceSave = false;
        choice = 'install';
        prompts = [];
        sessionState = { promptedPackages: new Set() };
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
            isPromptEnabled: (name) => !dismissed.has(name),
            sessionState,
            rememberPromptDismissal: (name) => {
                if (failPreferenceSave) {
                    return Promise.reject(new Error('global state unavailable'));
                }
                dismissed.add(name);
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
        policy: Policy,
        version?: string,
        requestDirectory = directory,
        packageName?: string,
    ): Promise<string> {
        const request = path.join(requestDirectory, `${id}.request`);
        await fs.writeFile(request, requestContent(id, policy, version, packageName));
        return request;
    }

    test('explicit jgd asks on each request and does not alter automatic prompt preference', async () => {
        const broker = service();
        await broker.start();
        assert.strictEqual(broker.canPrompt(['jgd'], 'always'), true);
        assert.strictEqual(broker.canPrompt(['jgd'], 'once'), true);
        assert.strictEqual(broker.canPrompt(['unlisted'], 'always'), false);
        assert.strictEqual(broker.canPrompt([], 'always'), false);
        for (const id of ['1'.repeat(32), '2'.repeat(32)]) {
            await writeRequest(id, 'always');
            assert.strictEqual(
                await waitForFile(path.join(directory, `${id}.response`)),
                'approve\n',
            );
            await fs.rm(path.join(directory, `${id}.request`), { force: true });
            await fs.rm(path.join(directory, `${id}.response`), { force: true });
        }
        assert.strictEqual(prompts.length, 2);
        assert.strictEqual(dismissed.size, 0);
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
            requestContent(id, 'always').replace(/\n/g, '\r\n'),
        );
        assert.strictEqual(request.policy, 'always');
        assert.strictEqual(request.packages[0].sourceBuild, true);
    });

    test('automatic prompt is limited to one per host session across services', async () => {
        const first = service();
        await first.start();
        const firstId = '3'.repeat(32);
        choice = 'notNow';
        await writeRequest(firstId, 'once');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${firstId}.response`)),
            'decline\n',
        );
        assert.strictEqual(dismissed.size, 0);
        assert.deepStrictEqual([...sessionState.promptedPackages], ['jgd']);
        assert.strictEqual(first.canPrompt(['jgd'], 'once'), false);
        await first.stop();

        const secondDirectory = path.join(directory, 'another-service');
        await fs.mkdir(secondDirectory);
        const secondService = service(undefined, secondDirectory);
        await secondService.start();
        assert.strictEqual(secondService.canPrompt(['jgd'], 'once'), false);
        const secondId = '4'.repeat(32);
        await writeRequest(secondId, 'once', undefined, secondDirectory);
        assert.strictEqual(
            await waitForFile(path.join(secondDirectory, `${secondId}.response`)),
            'decline\n',
        );
        assert.strictEqual(prompts.length, 1);
        await secondService.stop();

        // A fresh state represents a new VS Code extension-host session.
        sessionState = { promptedPackages: new Set() };
        const newHostDirectory = path.join(directory, 'new-host');
        await fs.mkdir(newHostDirectory);
        const nextHost = service(undefined, newHostDirectory);
        await nextHost.start();
        assert.strictEqual(nextHost.canPrompt(['jgd'], 'once'), true);
        choice = 'install';
        const thirdId = '5'.repeat(32);
        await writeRequest(thirdId, 'once', undefined, newHostDirectory);
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
        assert.strictEqual(broker.canPrompt(['jgd'], 'once'), true);
        await writeRequest(firstId, 'once');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${firstId}.response`)),
            'decline\n',
        );
        assert.deepStrictEqual([...dismissed], ['jgd']);
        assert.strictEqual(broker.canPrompt(['jgd'], 'once'), false);
        assert.strictEqual(broker.canPrompt(['jgd'], 'always'), true);

        choice = 'install';
        const explicitId = '7'.repeat(32);
        await writeRequest(explicitId, 'always');
        assert.strictEqual(
            await waitForFile(path.join(directory, `${explicitId}.response`)),
            'approve\n',
        );
        assert.strictEqual(prompts.length, 2);
        await broker.stop();

        sessionState = { promptedPackages: new Set() };
        const nextHostDirectory = path.join(directory, 'next-host');
        await fs.mkdir(nextHostDirectory);
        const nextHost = service(undefined, nextHostDirectory);
        await nextHost.start();
        const suppressedId = '8'.repeat(32);
        await writeRequest(suppressedId, 'once', undefined, nextHostDirectory);
        assert.strictEqual(
            await waitForFile(path.join(nextHostDirectory, `${suppressedId}.response`)),
            'decline\n',
        );
        assert.strictEqual(prompts.length, 2);
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
        await writeRequest(firstId, 'once');
        await writeRequest(secondId, 'once');
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
            requestContent(promptedId, 'once', '1.3.0'),
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
        await writeRequest(id, 'once');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 1);
        assert.strictEqual(dismissed.size, 0);
    });

    test('Not now, dismiss, and install do not change persistent suppression', async () => {
        for (const [index, result] of (['notNow', 'dismiss', 'install'] as const).entries()) {
            dismissed.clear();
            choice = result;
            sessionState = { promptedPackages: new Set() };
            const hostDirectory = path.join(directory, `host-${index}`);
            await fs.mkdir(hostDirectory);
            const broker = service(undefined, hostDirectory);
            await broker.start();
            const id = String(index + 1).repeat(32);
            await writeRequest(id, 'once', undefined, hostDirectory);
            const expected = result === 'install' ? 'approve\n' : 'decline\n';
            assert.strictEqual(
                await waitForFile(path.join(hostDirectory, `${id}.response`)),
                expected,
            );
            assert.strictEqual(dismissed.size, 0);
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
            isPromptEnabled: () => true,
            sessionState,
            rememberPromptDismissal: () => {
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
        await writeRequest(id, 'once');
        await started;
        await broker.stop();
        finishPrompt('install');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts.length, 1);
        assert.strictEqual(dismissals, 0);
    });

    async function answerFor(
        id: string,
        policy: Policy,
        packageName: string,
        requestDirectory = directory,
    ): Promise<string> {
        await writeRequest(id, policy, undefined, requestDirectory, packageName);
        return waitForFile(path.join(requestDirectory, `${id}.response`));
    }

    test('automatic prompts are tracked per package within one host session', async () => {
        const broker = service();
        await broker.start();
        choice = 'notNow';
        assert.strictEqual(broker.canPrompt(['rstudioapi'], 'once'), true);
        assert.strictEqual(await answerFor('c'.repeat(32), 'once', 'jgd'), 'decline\n');
        // Offering jgd must not use up the offer for rstudioapi in the same startup.
        assert.strictEqual(broker.canPrompt(['jgd'], 'once'), false);
        assert.strictEqual(broker.canPrompt(['rstudioapi'], 'once'), true);
        choice = 'install';
        assert.strictEqual(await answerFor('d'.repeat(32), 'once', 'rstudioapi'), 'approve\n');
        assert.deepStrictEqual(
            prompts.map((request) => request.packages[0].name),
            ['jgd', 'rstudioapi'],
        );
        // Each package is offered once per host session.
        assert.strictEqual(await answerFor('e'.repeat(32), 'once', 'rstudioapi'), 'decline\n');
        assert.strictEqual(await answerFor('f'.repeat(32), 'once', 'jgd'), 'decline\n');
        assert.strictEqual(prompts.length, 2);
        assert.deepStrictEqual([...sessionState.promptedPackages].sort(), ['jgd', 'rstudioapi']);
    });

    test("Don't ask again is remembered only for its own package", async () => {
        const broker = service();
        await broker.start();
        choice = 'dontAskAgain';
        assert.strictEqual(await answerFor('1'.repeat(32), 'once', 'rstudioapi'), 'decline\n');
        assert.deepStrictEqual([...dismissed], ['rstudioapi']);
        assert.strictEqual(broker.canPrompt(['rstudioapi'], 'once'), false);
        assert.strictEqual(broker.canPrompt(['jgd'], 'once'), true);

        // A new host session still honors the remembered choice for rstudioapi only.
        sessionState = { promptedPackages: new Set() };
        const nextHostDirectory = path.join(directory, 'next-host');
        await fs.mkdir(nextHostDirectory);
        const nextHost = service(undefined, nextHostDirectory);
        await nextHost.start();
        assert.strictEqual(nextHost.canPrompt(['rstudioapi'], 'once'), false);
        assert.strictEqual(nextHost.canPrompt(['jgd'], 'once'), true);
        assert.strictEqual(
            await answerFor('2'.repeat(32), 'once', 'rstudioapi', nextHostDirectory),
            'decline\n',
        );
        assert.strictEqual(prompts.length, 1);
        choice = 'install';
        assert.strictEqual(
            await answerFor('3'.repeat(32), 'once', 'jgd', nextHostDirectory),
            'approve\n',
        );
        assert.strictEqual(prompts.length, 2);
    });

    test('packages outside the allowlist are declined without a prompt', async () => {
        const broker = service();
        await broker.start();
        assert.strictEqual(await answerFor('4'.repeat(32), 'always', 'unlisted'), 'decline\n');
        assert.strictEqual(prompts.length, 0);
    });

    test('the prompt request carries the package and policy', async () => {
        const broker = service();
        await broker.start();
        assert.strictEqual(await answerFor('5'.repeat(32), 'once', 'rstudioapi'), 'approve\n');
        assert.strictEqual(prompts[0].policy, 'once');
        assert.strictEqual(prompts[0].packages[0].name, 'rstudioapi');
    });
});
