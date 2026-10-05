// Run after `pnpm run pretest`. Pass one or more VS Code executable paths.
// Each isolated editor exits fully before the next opens. With two versions,
// this also checks reconnection after switching editor versions.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { runTests } = require('@vscode/test-electron');
const { installRuntime, discoverSessions } = require('../../../out/interactive/launcher');
const { AgentClient } = require('../../../out/interactive/client');
const { resolveExecutable } = require('../../../out/interactive/executable');

const repository = path.resolve(__dirname, '../../..');
const editors = process.argv.slice(2).map(file => path.resolve(file));
if (!editors.length) { throw new Error('Pass a VS Code executable path (optionally followed by a newer version).'); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-editor-lifecycle-'));
const registry = path.join(root, 'registry');
const report = path.join(root, 'report.json');
const fixture = path.join(root, 'editor-tests.cjs');
const state = path.join(root, 'state.json');

async function stopAgent(client) {
    await client.request('stop');
    for (let i = 0; i < 400; i++) {
        if ((await client.snapshot()).manifest.status === 'exited') {
            await client.request('shutdown');
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('R did not stop');
}

async function main() {
    const rPath = resolveExecutable('R', repository);
    assert.ok(rPath, 'R must be installed');
    const runtime = await installRuntime(repository, registry, rPath, () => {});
    const arfPath = resolveExecutable(process.env.ARF_PATH ?? 'arf', repository);
    assert.ok(arfPath, 'arf must be installed');
    const config = { id: randomUUID(), generation: randomUUID(), label: 'Editor lifecycle test', directory: root,
        storage: '', rPath, library: runtime.library, resources: runtime.resources, provider: 'arf', arfPath, supervision: 'detached',
        plotBackend: 'standard', historyLimit: 10, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
    config.storage = path.join(registry, config.id);
    fs.writeFileSync(state, JSON.stringify({ config, agent: runtime.agent }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['uname', 'rm', 'mkdir', 'which', 'sed', 'sh', 'env', 'cat', 'cut', 'basename', 'dirname']) {
        const executable = resolveExecutable(name, repository);
        if (executable) { fs.symlinkSync(executable, path.join(bin, name)); }
    }
    const user = path.join(root, 'profile', 'User');
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
        'r.interactive.storagePath': registry, 'r.interactive.restore': false,
        'update.mode': 'none', 'extensions.autoUpdate': false,
    }));
    fs.writeFileSync(fixture, `
const vscode = require('vscode');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { launchAgent } = require(${JSON.stringify(require.resolve('../../../out/interactive/launcher'))});
const { hostNodeRuntime } = require(${JSON.stringify(require.resolve('../../../out/interactive/nodeExecutable'))});
const { AgentClient } = require(${JSON.stringify(require.resolve('../../../out/interactive/client'))});
const stateFile = ${JSON.stringify(state)};
const reportFile = ${JSON.stringify(report)};
${stopAgent.toString()}
async function execute(client, code) {
    const id = randomUUID();
    await client.request('submit', { submission: { id, code } });
    for (let i = 0; i < 400; i++) {
        const record = await client.request('execution', { id });
        if (record.state === 'success') { return; }
        assert.ok(!['error', 'interrupted'].includes(record.state), JSON.stringify(record));
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('R execution timed out');
}
exports.run = async () => {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const stage = Number(process.env.VSCR_LIFECYCLE_STAGE);
    const reports = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : [];
    // Use an absolute R path, and remove directories containing standalone Node.
    process.env.PATH = ${JSON.stringify(bin)};
    let client;
    try {
        if (stage > 0) {
            client = new AgentClient(state.manifest);
            await client.connect();
            assert.equal((await client.snapshot()).manifest.rPid, state.rPid);
            await execute(client, 'stopifnot(persisted == 42, Sys.getenv("ELECTRON_RUN_AS_NODE") == "")');
            reports.push({ stage, action: 'reconnected', vscode: vscode.version, rPid: state.rPid });
            await stopAgent(client);
            client.close();
            state.config.id = randomUUID();
            state.config.generation = randomUUID();
            state.config.storage = path.join(path.dirname(state.config.storage), state.config.id);
        }
        state.manifest = await launchAgent(state.config, state.agent);
        client = new AgentClient(state.manifest);
        await client.connect();
        await execute(client, 'stopifnot(Sys.getenv("ELECTRON_RUN_AS_NODE") == ""); persisted <- 42');
        state.rPid = (await client.snapshot()).manifest.rPid;
        reports.push({ stage, action: 'launched', vscode: vscode.version, runtime: hostNodeRuntime(), rPid: state.rPid });
        fs.writeFileSync(stateFile, JSON.stringify(state));
        fs.writeFileSync(reportFile, JSON.stringify(reports));
    } finally { client?.close(); }
};
`);
    // Reopen even when only one editor version was supplied.
    const versions = editors.length === 1 ? [editors[0], editors[0]] : editors;
    for (let stage = 0; stage < versions.length; stage++) {
        await runTests({
            vscodeExecutablePath: versions[stage], extensionDevelopmentPath: repository, extensionTestsPath: fixture,
            extensionTestsEnv: { VSCR_LIFECYCLE_STAGE: String(stage), ELECTRON_RUN_AS_NODE: '' },
            launchArgs: ['--user-data-dir', path.join(root, 'profile'), '--extensions-dir', path.join(repository, '.vscode-test/extensions'),
                '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates'],
        });
        // The main application has exited. Check the R process before reopening.
        const current = JSON.parse(fs.readFileSync(state, 'utf8'));
        process.kill(current.rPid, 0);
        const client = new AgentClient(current.manifest);
        try {
            await client.connect();
            assert.equal((await client.snapshot()).manifest.rPid, current.rPid);
            console.log(`Editor exited; R PID ${current.rPid} is still reachable`);
        } finally { client.close(); }
    }
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(report, 'utf8')), null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    let cleaned = true;
    for (const manifest of discoverSessions(registry)) {
        const client = new AgentClient(manifest);
        try { await client.connect(); await stopAgent(client); }
        catch (error) {
            try { process.kill(manifest.agentPid, 0); cleaned = false; console.error('Cleanup failed:', error); }
            catch { /* Already stopped. */ }
        }
        finally { client.close(); }
    }
    if (cleaned) { fs.rmSync(root, { recursive: true, force: true }); }
    else { console.error('Retained test state:', root); }
});
