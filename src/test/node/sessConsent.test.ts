import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessConsentChoice, SessConsentService } from '../../sessConsent';

const revision = `git-tree:${'a'.repeat(40)}`;
const nextRevision = `git-tree:${'c'.repeat(40)}`;

async function waitForFile(file: string): Promise<string> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try { return await fs.readFile(file, 'utf8'); }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    throw new Error(`Timed out waiting for ${file}`);
}

async function writeRequest(directory: string, id: string, reason: 'missing' | 'mismatch' = 'missing',
    requestRevision = revision): Promise<void> {
    await fs.writeFile(path.join(directory, `${id}.request`),
        `vscode-r-sess-consent-v1\n${id}\n${requestRevision}\nlinux-x86_64|4.5\n${reason}\n`);
}

suite('sess install consent bridge', () => {
    let directory: string;
    let dismissedRevision: string | undefined;
    let failPreferenceSave: boolean;
    const services: SessConsentService[] = [];

    setup(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-r-sess-consent-'));
        dismissedRevision = undefined;
        failPreferenceSave = false;
    });

    teardown(async () => {
        await Promise.all(services.splice(0).map(service => service.stop()));
        await fs.rm(directory, { recursive: true, force: true });
    });

    function service(prompt: (request: { reason: 'missing' | 'mismatch' }) => Promise<'install' | 'notNow' | 'dontAskAgain' | 'dismiss'>,
        isEnabled = () => true,
        expectedRevision = revision): SessConsentService {
        const result = new SessConsentService({
            directory, expectedRevision, prompt, isEnabled, intervalMs: 5,
            getDismissedRevision: () => dismissedRevision,
            rememberDismissedRevision: value => {
                if (failPreferenceSave) { return Promise.reject(new Error('storage unavailable')); }
                dismissedRevision = value;
                return Promise.resolve();
            },
        });
        services.push(result);
        return result;
    }

    test('writes a fresh approval only after the prompt accepts', async () => {
        const id = '1'.repeat(32);
        const prompt = (request: { reason: 'missing' | 'mismatch' }) => {
            assert.strictEqual(request.reason, 'missing');
            return Promise.resolve<SessConsentChoice>('install');
        };
        const broker = service(prompt);
        await broker.start();
        await writeRequest(directory, id);
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'approve\n');
        assert.strictEqual(dismissedRevision, undefined);
    });

    test('accepts the CRLF lines written by base R on Windows', async () => {
        const id = '7'.repeat(32);
        const broker = service(() => Promise.resolve('install'));
        await broker.start();
        await fs.writeFile(path.join(directory, `${id}.request`),
            `vscode-r-sess-consent-v1\r\n${id}\r\n${revision}\r\nwindows-x86_64|4.5\r\nmissing\r\n`);
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'approve\n');
    });

    test('does not prompt when the watcher is disabled before the request arrives', async () => {
        let prompts = 0;
        const broker = service(() => { prompts++; return Promise.resolve('install'); }, () => false);
        await broker.start();
        const id = '2'.repeat(32);
        await writeRequest(directory, id, 'mismatch');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts, 0);
    });

    test('Not now and dismissal do not suppress later prompts', async () => {
        let prompts = 0;
        const choices = ['notNow', 'dismiss'] as const;
        const broker = service(() => Promise.resolve(choices[prompts++]));
        await broker.start();
        for (const id of ['b'.repeat(32), 'd'.repeat(32)]) {
            await writeRequest(directory, id);
            assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        }
        assert.strictEqual(prompts, 2);
        assert.strictEqual(dismissedRevision, undefined);
    });

    test("Don't ask again stores only this revision and survives service restart", async () => {
        let prompts = 0;
        const first = service(() => { prompts++; return Promise.resolve('dontAskAgain'); });
        await first.start();
        const firstId = 'e'.repeat(32);
        await writeRequest(directory, firstId);
        assert.strictEqual(await waitForFile(path.join(directory, `${firstId}.response`)), 'decline\n');
        assert.strictEqual(dismissedRevision, revision);
        await first.stop();
        await fs.rm(path.join(directory, `${firstId}.request`), { force: true });
        await fs.rm(path.join(directory, `${firstId}.response`), { force: true });

        const restarted = service(() => { prompts++; return Promise.resolve('install'); });
        await restarted.start();
        const sameId = 'f'.repeat(32);
        await writeRequest(directory, sameId);
        assert.strictEqual(await waitForFile(path.join(directory, `${sameId}.response`)), 'decline\n');
        assert.strictEqual(prompts, 1);
        await restarted.stop();
        await fs.rm(path.join(directory, `${sameId}.request`), { force: true });
        await fs.rm(path.join(directory, `${sameId}.response`), { force: true });

        const changed = service(() => { prompts++; return Promise.resolve('install'); }, () => true, nextRevision);
        await changed.start();
        const changedId = 'c'.repeat(32);
        await writeRequest(directory, changedId, 'missing', nextRevision);
        assert.strictEqual(await waitForFile(path.join(directory, `${changedId}.response`)), 'approve\n');
        assert.strictEqual(prompts, 2);
        assert.strictEqual(dismissedRevision, revision);
    });

    test("a failed Don't ask again preference save never grants installation", async () => {
        failPreferenceSave = true;
        let prompts = 0;
        const broker = service(() => { prompts++; return Promise.resolve('dontAskAgain'); });
        await broker.start();
        const id = '9'.repeat(32);
        await writeRequest(directory, id);
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts, 1);
        assert.strictEqual(dismissedRevision, undefined);
    });

    test('shutdown while the prompt is pending cannot publish a late approval', async () => {
        let resolvePrompt!: (choice: 'install' | 'notNow' | 'dontAskAgain' | 'dismiss') => void;
        let prompts = 0;
        const broker = service(() => {
            prompts++;
            return new Promise<'install' | 'notNow' | 'dontAskAgain' | 'dismiss'>(resolve => { resolvePrompt = resolve; });
        });
        await broker.start();
        const id = '9'.repeat(32);
        await writeRequest(directory, id);
        const deadline = Date.now() + 3000;
        while (prompts === 0 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
        assert.strictEqual(prompts, 1);
        await broker.stop();
        const response = path.join(directory, `${id}.response`);
        assert.strictEqual(await waitForFile(response), 'decline\n');
        resolvePrompt('install');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(await fs.readFile(response, 'utf8'), 'decline\n');
    });

    test('a watcher disabled while the prompt is pending cannot approve install', async () => {
        let enabled = true;
        let resolvePrompt!: (choice: 'install' | 'notNow' | 'dontAskAgain' | 'dismiss') => void;
        let prompts = 0;
        const broker = service(() => {
            prompts++;
            return new Promise<'install' | 'notNow' | 'dontAskAgain' | 'dismiss'>(resolve => { resolvePrompt = resolve; });
        }, () => enabled);
        await broker.start();
        const id = 'a'.repeat(32);
        await writeRequest(directory, id);
        const deadline = Date.now() + 3000;
        while (prompts === 0 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
        assert.strictEqual(prompts, 1);
        enabled = false;
        resolvePrompt('install');
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
    });

    test('declines requests whose claimed revision differs from the bundled revision', async () => {
        let prompts = 0;
        const broker = service(() => { prompts++; return Promise.resolve('install'); }, () => true,
            `git-tree:${'b'.repeat(40)}`);
        await broker.start();
        const id = '6'.repeat(32);
        await writeRequest(directory, id);
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts, 0);
    });

    test('deduplicates a pending request and a later execution needs a new grant', async () => {
        let resolvePrompt!: (choice: 'install' | 'notNow' | 'dontAskAgain' | 'dismiss') => void;
        let prompts = 0;
        const broker = service(() => {
            prompts++;
            return prompts === 1
                ? new Promise<'install' | 'notNow' | 'dontAskAgain' | 'dismiss'>(resolve => { resolvePrompt = resolve; })
                : Promise.resolve('notNow');
        });
        await broker.start();
        const firstId = '3'.repeat(32);
        await writeRequest(directory, firstId);
        const firstResponse = path.join(directory, `${firstId}.response`);
        const deadline = Date.now() + 3000;
        while (prompts === 0 && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); }
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.strictEqual(prompts, 1);
        resolvePrompt('install');
        assert.strictEqual(await waitForFile(firstResponse), 'approve\n');

        const nextId = '4'.repeat(32);
        await writeRequest(directory, nextId);
        const nextResponse = path.join(directory, `${nextId}.response`);
        await waitForFile(nextResponse);
        assert.strictEqual(await fs.readFile(nextResponse, 'utf8'), 'decline\n');
        assert.strictEqual(prompts, 2);
    });

    test('malformed bounded requests are declined without showing UI', async () => {
        let prompts = 0;
        const broker = service(() => { prompts++; return Promise.resolve('install'); });
        await broker.start();
        const id = '5'.repeat(32);
        await fs.writeFile(path.join(directory, `${id}.request`), `${id}\n${'x'.repeat(400)}\n`);
        assert.strictEqual(await waitForFile(path.join(directory, `${id}.response`)), 'decline\n');
        assert.strictEqual(prompts, 0);
    });
});
