import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { AgentConfig, SessionManifest, identifier } from './protocol';
import { atomicJson } from './journal';
import { hostNodeRuntime, NodeRuntime } from './nodeExecutable';
import { prepareSupervisor } from './supervisor';
import { ensureStorageDirectory, prepareStorage, storageError } from './storage';
import { installSessRuntime } from './backends/sessPreparation';
export { prepareStorage } from './storage';

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
    delete result.ELECTRON_RUN_AS_NODE;
    if (result.VSCODE_INSPECTOR_OPTIONS) {
        delete result.NODE_OPTIONS;
        delete result.VSCODE_INSPECTOR_OPTIONS;
    }
    return result;
}

/** Only the Electron launcher and agent need this flag, not their R children. */
export function nodeEnvironment(runtime: NodeRuntime, environment = process.env): NodeJS.ProcessEnv {
    const result = agentEnvironment(environment);
    if (runtime.electron) { result.ELECTRON_RUN_AS_NODE = '1'; }
    return result;
}

/** Agent bundles are cached independently of any R backend or package library. */
export function installAgentBundle(extensionPath: string, root: string): string {
    prepareStorage(root);
    const bytes = fs.readFileSync(path.join(extensionPath, 'dist', 'interactive-agent.js'));
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    const agent = path.join(root, 'runtimes', `agent-${hash}.cjs`);
    if (!fs.existsSync(agent)) {
        const temporary = `${agent}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, bytes, { mode: 0o600 }); fs.renameSync(temporary, agent); }
        finally { fs.rmSync(temporary, { force: true }); }
    }
    return agent;
}

/** Convenience for existing callers preparing the shipped sess backend. */
export async function installRuntime(extensionPath: string, root: string, rPath: string,
    log: (text: string) => void): Promise<{ library: string; resources: string; agent: string }> {
    const runtime = await installSessRuntime(extensionPath, root, rPath, log);
    return { ...runtime, agent: installAgentBundle(extensionPath, root) };
}

/** Validate before building a runtime or stopping a session for restart. */
export async function prepareNodeRuntime(directory: string, runtime = hostNodeRuntime()): Promise<NodeRuntime> {
    const node = runtime.executable;
    const help = 'Reload VS Code to use its current runtime. If this persists, repair or update VS Code (VS Code Server on a remote host).';
    let version: string;
    try {
        version = (await run(node, ['-p', 'process.versions.node'], { env: nodeEnvironment(runtime), cwd: directory, timeout: 5000 })).stdout.trim();
    } catch (error) { throw new Error(`Cannot run VS Code's Node.js runtime “${node}”. ${help}`, { cause: error }); }
    const major = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version)?.[1];
    if (!major || Number(major) < 18) {
        throw new Error(`The session agent requires Node.js 18 or newer; “${node}” reported “${version}”. ${help}`);
    }
    return runtime;
}

export async function launchAgent(config: AgentConfig, agent: string, runtime = hostNodeRuntime(),
    log: (text: string) => void = () => undefined): Promise<SessionManifest> {
    const supervisor = prepareSupervisor(config.supervision, config.directory);
    runtime = await prepareNodeRuntime(config.directory, runtime);
    const node = runtime.executable;
    ensureStorageDirectory(config.storage, path.dirname(config.storage));
    const file = path.join(config.storage, 'config.json');
    const env = nodeEnvironment(runtime);
    config.supervision = supervisor.kind;
    atomicJson(file, config);
    if (supervisor.kind !== 'detached') {
        const args = supervisor.kind === 'tmux'
            ? ['new-session', '-d', '-s', `vscode-r-${config.id.slice(0, 8)}-${config.generation.slice(0, 8)}`,
                `${runtime.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${[node, agent, file].map(shellQuote).join(' ')} >>${shellQuote(path.join(config.storage, 'agent.log'))} 2>&1`]
            : ['--user', '--collect', '--unit', `vscode-r-${config.id}-${config.generation}`,
                ...(runtime.electron ? ['--setenv=ELECTRON_RUN_AS_NODE=1'] : []), '--', node, agent, file];
        try { await run(supervisor.executable, args, { env, cwd: config.directory, timeout: 10000 }); }
        catch (error) {
            // A failed command may already have started an agent. Falling back now
            // could create two R processes using the same session registry.
            throw new Error(`Could not start the ${supervisor.kind} session supervisor. Check ${supervisor.kind === 'systemd' ? 'the systemd user service' : 'tmux'} on the R host, ` +
                `or set r.interactive.supervision to "detached". ${String(error)}`, { cause: error });
        }
    } else {
        if (supervisor.notice) {
            log(supervisor.notice);
            fs.appendFileSync(path.join(config.storage, 'agent.log'), `${supervisor.notice}\n`, { mode: 0o600 });
        }
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
    }
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
