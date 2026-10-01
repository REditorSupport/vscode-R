import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { AgentConfig, SessionManifest, identifier } from './protocol';
import { atomicJson } from './journal';

const run = promisify(execFile);

export function defaultStorage(platform = process.platform, home = os.homedir(), environment = process.env): string {
    const xdg = environment.XDG_STATE_HOME;
    // XDG paths must be absolute; an empty value is equivalent to being unset.
    if (xdg && path.isAbsolute(xdg)) { return path.join(xdg, 'vscode-r', 'interactive'); }
    const legacy = path.join(home, '.local', 'state', 'vscode-r', 'interactive');
    // Keep existing agents and their on-disk paths discoverable without moving live storage.
    if (platform !== 'darwin' || fs.existsSync(legacy)) { return legacy; }
    return path.join(home, 'Library', 'Application Support', 'vscode-r', 'interactive');
}

function storageError(root: string, error: unknown): unknown {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) { return error; }
    return new Error(`Cannot access persistent session storage "${root}". Set r.interactive.storagePath to an absolute, writable directory on the R host and reload VS Code. ${String(error)}`, { cause: error });
}

function ensureStorageDirectory(directory: string, root: string): void {
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch (error) { throw storageError(root, error); }
}

/** Check storage before probing R or building the private runtime. Never redirect an existing registry. */
export function prepareStorage(root: string): void {
    ensureStorageDirectory(root, root);
    ensureStorageDirectory(path.join(root, 'runtimes'), root);
}

export function discoverSessions(root: string): SessionManifest[] {
    let names: string[];
    try { names = fs.readdirSync(root); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
        throw storageError(root, error);
    }
    const sessions: SessionManifest[] = [];
    for (const name of names) {
        if (name === 'runtimes') { continue; }
        try {
            identifier(name);
            const file = path.join(root, name, 'manifest.json');
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) { continue; }
            const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionManifest;
            if (manifest.id !== name || manifest.host !== os.hostname()) { continue; }
            sessions.push(manifest);
        } catch { /* Ignore partial, foreign, and unrecognized registry entries. */ }
    }
    return sessions.sort((a, b) => b.created - a.created);
}

/** Cheap rejection of stale registry entries; a socket still needs an authenticated probe. */
export function hasSessionEndpoint(manifest: SessionManifest): boolean {
    if (!Number.isSafeInteger(manifest.agentPid) || manifest.agentPid <= 0 ||
        typeof manifest.endpoint !== 'string' || !path.isAbsolute(manifest.endpoint)) { return false; }
    try {
        process.kill(manifest.agentPid, 0);
        return fs.statSync(manifest.endpoint).isSocket();
    } catch { return false; }
}

/** Shell quoting is used only for tmux/system service launch commands, never for R code. */
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

/** Debugger auto-attach must not make the persistent agent part of the editor's debug session. */
export function agentEnvironment(environment = process.env): NodeJS.ProcessEnv {
    const result = { ...environment };
    if (result.VSCODE_INSPECTOR_OPTIONS) {
        delete result.NODE_OPTIONS;
        delete result.VSCODE_INSPECTOR_OPTIONS;
    }
    return result;
}

export async function installRuntime(extensionPath: string, root: string, rPath: string,
    log: (text: string) => void): Promise<{ library: string; resources: string; agent: string }> {
    prepareStorage(root);
    const hash = createHash('sha256');
    const sources = ['sess/DESCRIPTION', 'sess/NAMESPACE', 'dist/interactive-agent.js',
        'R/interactive-worker.R', 'R/interactive-metrics.R'];
    for (const directory of ['sess/R', 'sess/src']) {
        for (const name of fs.readdirSync(path.join(extensionPath, directory)).sort()) {
            if (/\.(R|c|h)$/.test(name)) { sources.push(`${directory}/${name}`); }
        }
    }
    for (const file of sources) { hash.update(file).update(fs.readFileSync(path.join(extensionPath, file))); }
    const version = await run(rPath, ['--vanilla', '--slave', '-e', 'cat(R.version$platform, R.version$major, R.version$minor)']);
    hash.update(version.stdout);
    const runtime = path.join(root, 'runtimes', hash.digest('hex').slice(0, 20));
    const library = path.join(runtime, 'library');
    const resources = path.join(runtime, 'R');
    const agent = path.join(runtime, 'agent.cjs');
    if (fs.existsSync(path.join(runtime, 'ready'))) { return { library, resources, agent }; }
    const lock = `${runtime}.lock`;
    const deadline = Date.now() + 120000;
    for (;;) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            if (fs.existsSync(path.join(runtime, 'ready'))) { return { library, resources, agent }; }
            if (Date.now() >= deadline) { throw new Error(`Runtime installation is locked. If its installer has exited, remove ${lock} and retry.`); }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    try {
        fs.mkdirSync(library, { recursive: true, mode: 0o700 });
        fs.mkdirSync(resources, { recursive: true, mode: 0o700 });
        const packagePath = path.join(runtime, 'sess');
        fs.cpSync(path.join(extensionPath, 'sess'), packagePath, { recursive: true,
            filter: source => !/\.(o|so|dll)$/.test(source) });
        for (const file of ['interactive-worker.R', 'interactive-metrics.R']) {
            fs.copyFileSync(path.join(extensionPath, 'R', file), path.join(resources, file));
        }
        fs.copyFileSync(path.join(extensionPath, 'dist', 'interactive-agent.js'), agent);
        await new Promise<void>((resolve, reject) => {
            const child = spawn(rPath, ['CMD', 'INSTALL', '--clean', `--library=${library}`, packagePath], { stdio: ['ignore', 'pipe', 'pipe'] });
            child.stdout.on('data', (data: Buffer) => log(data.toString()));
            child.stderr.on('data', (data: Buffer) => log(data.toString()));
            child.on('error', reject);
            child.on('exit', code => code === 0 ? resolve() : reject(new Error('Could not build the private sess runtime. See R Interactive output for R dependency/compiler diagnostics.')));
        });
        fs.writeFileSync(path.join(runtime, 'ready'), version.stdout, { mode: 0o600 });
        return { library, resources, agent };
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export async function launchAgent(config: AgentConfig, agent: string, node: string): Promise<SessionManifest> {
    ensureStorageDirectory(config.storage, path.dirname(config.storage));
    const file = path.join(config.storage, 'config.json');
    if (process.platform === 'win32') { throw new Error('Persistent Interactive native console support currently requires Linux or macOS'); }
    const env = agentEnvironment();
    const nodeVersion = await run(node, ['--version'], { env });
    if (Number(nodeVersion.stdout.trim().replace(/^v/, '').split('.')[0]) < 18) {
        throw new Error('The session agent requires a standalone Node.js 18 or newer runtime');
    }
    if (config.supervision === 'auto') { config.supervision = process.platform === 'linux' ? 'tmux' : 'detached'; }
    atomicJson(file, config);
    if (config.supervision === 'tmux') {
        await run('tmux', ['new-session', '-d', '-s', `vscode-r-${config.id.slice(0, 8)}-${config.generation.slice(0, 8)}`,
            `exec ${[node, agent, file].map(shellQuote).join(' ')} >>${shellQuote(path.join(config.storage, 'agent.log'))} 2>&1`], { env });
    } else if (config.supervision === 'systemd') {
        await run('systemd-run', ['--user', '--collect', '--unit', `vscode-r-${config.id}-${config.generation}`, '--', node, agent, file], { env });
    } else if (config.supervision === 'detached') {
        // setsid/unref alone leaves the agent in the extension host's process tree.
        // Wait for a short-lived launcher to exit so tree-based editor/debugger cleanup
        // cannot reach the agent. The agent owns its log and has no inherited IPC or stdio.
        const bootstrap = `
            const fs = require('fs');
            const log = fs.openSync(${JSON.stringify(path.join(config.storage, 'agent.log'))}, 'a', 0o600);
            const child = require('child_process').spawn(process.execPath, process.argv.slice(1),
                { detached: true, stdio: ['ignore', log, log] });
            child.once('error', error => { console.error(error); process.exitCode = 1; });
            child.unref();
            fs.closeSync(log);
        `;
        await run(node, ['-e', bootstrap, agent, file], { env });
    } else { throw new Error('Unknown session supervisor'); }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(config.storage, 'manifest.json'), 'utf8')) as SessionManifest;
            if (manifest.generation === config.generation) { return manifest; }
        } catch { /* Atomic manifest is published after the endpoints are ready. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Session agent did not become ready. See ${path.join(config.storage, 'agent.log')}`);
}

export function newIdentity(): { id: string; generation: string } { return { id: randomUUID(), generation: randomUUID() }; }
