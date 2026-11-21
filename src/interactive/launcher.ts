import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { probeSession } from './client';
import { AgentConfig, SessionManifest, identifier } from './protocol';
import { atomicJson } from './journal';
import { hostNodeRuntime, NodeRuntime } from './nodeExecutable';
import { prepareSupervisor } from './supervisor';
import { ensureStorageDirectory, prepareStorage, storageError } from './storage';
import { installSessRuntime } from './backends/sessPreparation';
export { prepareStorage } from './storage';

const run = promisify(execFile);

export function defaultStorage(
    platform = process.platform,
    home = os.homedir(),
    environment = process.env,
): string {
    if (platform === 'win32') {
        return path.win32.join(
            environment.LOCALAPPDATA && path.win32.isAbsolute(environment.LOCALAPPDATA)
                ? environment.LOCALAPPDATA
                : path.win32.join(home, 'AppData', 'Local'),
            'vscode-r',
            'interactive',
        );
    }
    const xdg = environment.XDG_STATE_HOME;
    // XDG paths must be absolute; an empty value is equivalent to being unset.
    if (xdg && path.isAbsolute(xdg)) {
        return path.join(xdg, 'vscode-r', 'interactive');
    }
    const legacy = path.join(home, '.local', 'state', 'vscode-r', 'interactive');
    // Keep existing agents and their on-disk paths discoverable without moving live storage.
    if (platform !== 'darwin' || fs.existsSync(legacy)) {
        return legacy;
    }
    return path.join(home, 'Library', 'Application Support', 'vscode-r', 'interactive');
}

/**
 * Working directory for a new session. Without a workspace, use the user's home
 * (USERPROFILE on Windows) rather than HOME or the extension host's cwd, which
 * can be the editor's installation directory.
 */
export function defaultSessionDirectory(workspace: string | undefined): string {
    return workspace ?? os.homedir();
}

export function readSessionManifest(
    storage: string,
    id: string,
    generation?: string,
): SessionManifest | undefined {
    try {
        identifier(id);
        const file = path.join(storage, 'manifest.json');
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionManifest;
        if (
            manifest.id === id &&
            manifest.host === os.hostname() &&
            (generation === undefined || manifest.generation === generation)
        ) {
            return manifest;
        }
    } catch {
        // Ignore partial, foreign, and unrecognized registry entries.
    }
}

export function discoverSessions(root: string): SessionManifest[] {
    let names: string[];
    try {
        names = fs.readdirSync(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw storageError(root, error);
    }
    const sessions: SessionManifest[] = [];
    for (const name of names) {
        if (name === 'runtimes') {
            continue;
        }
        const manifest = readSessionManifest(path.join(root, name), name);
        if (manifest) {
            sessions.push(manifest);
        }
    }
    return sessions.sort((a, b) => b.created - a.created);
}

/** Cheap stale-entry rejection only; an authenticated probe still establishes liveness. */
export function hasSessionEndpoint(
    manifest: SessionManifest,
    platform = process.platform,
): boolean {
    if (
        !Number.isSafeInteger(manifest.agentPid) ||
        manifest.agentPid <= 0 ||
        typeof manifest.endpoint !== 'string' ||
        !(platform === 'win32'
            ? manifest.endpoint.startsWith('\\\\.\\pipe\\')
            : path.isAbsolute(manifest.endpoint))
    ) {
        return false;
    }
    try {
        process.kill(manifest.agentPid, 0);
        // Named pipes have no socket-file entry. Do not open or stat the pipe here.
        return platform === 'win32' || fs.statSync(manifest.endpoint).isSocket();
    } catch {
        return false;
    }
}

/** Shell quoting is used only for tmux/system service launch commands, never for R code. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

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
export function nodeEnvironment(
    runtime: NodeRuntime,
    environment = process.env,
): NodeJS.ProcessEnv {
    const result = agentEnvironment(environment);
    if (runtime.electron) {
        result.ELECTRON_RUN_AS_NODE = '1';
    }
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
        try {
            fs.writeFileSync(temporary, bytes, { mode: 0o600 });
            fs.renameSync(temporary, agent);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
    return agent;
}

/** Convenience for existing callers preparing the shipped sess backend. */
export async function installRuntime(
    extensionPath: string,
    root: string,
    rPath: string,
    log: (text: string) => void,
): Promise<{ library: string; resources: string; agent: string }> {
    const runtime = await installSessRuntime(extensionPath, root, rPath, log);
    return { ...runtime, agent: installAgentBundle(extensionPath, root) };
}

/** Validate before building a runtime or stopping a session for restart. */
export async function prepareNodeRuntime(
    directory: string,
    runtime = hostNodeRuntime(),
): Promise<NodeRuntime> {
    const node = runtime.executable;
    const help =
        "Set r.interactive.nodePath to a Node.js 18+ executable on the R host, or clear it to use VS Code's runtime. Reload VS Code to refresh the automatic runtime; repair or update VS Code (VS Code Server on a remote host) if needed.";
    let version: string;
    try {
        version = (
            await run(node, ['-p', 'process.versions.node'], {
                env: nodeEnvironment(runtime),
                cwd: directory,
                timeout: 5000,
            })
        ).stdout.trim();
    } catch (error) {
        throw new Error(`Cannot run the Node.js runtime “${node}”. ${help}`, { cause: error });
    }
    const major = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version)?.[1];
    if (!major || Number(major) < 18) {
        throw new Error(
            `The session agent requires Node.js 18 or newer; “${node}” reported “${version}”. ${help}`,
        );
    }
    return runtime;
}

export async function launchAgent(
    config: AgentConfig,
    agent: string,
    runtime = hostNodeRuntime(),
    log: (text: string) => void = () => undefined,
): Promise<SessionManifest> {
    const supervisor = prepareSupervisor(config.supervision, config.directory);
    runtime = await prepareNodeRuntime(config.directory, runtime);
    const node = runtime.executable;
    ensureStorageDirectory(config.storage, path.dirname(config.storage));
    const file = path.join(config.storage, 'config.json');
    const env = nodeEnvironment(runtime);
    config.supervision = supervisor.kind;
    atomicJson(file, config);
    if (supervisor.kind !== 'detached') {
        const args =
            supervisor.kind === 'tmux'
                ? [
                      'new-session',
                      '-d',
                      '-s',
                      `vscode-r-${config.id.slice(0, 8)}-${config.generation.slice(0, 8)}`,
                      `${runtime.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${[node, agent, file].map(shellQuote).join(' ')} >>${shellQuote(path.join(config.storage, 'agent.log'))} 2>&1`,
                  ]
                : [
                      '--user',
                      '--collect',
                      '--unit',
                      `vscode-r-${config.id}-${config.generation}`,
                      ...(runtime.electron ? ['--setenv=ELECTRON_RUN_AS_NODE=1'] : []),
                      '--',
                      node,
                      agent,
                      file,
                  ];
        try {
            await run(supervisor.executable, args, { env, cwd: config.directory, timeout: 10000 });
        } catch (error) {
            // A failed command may already have started an agent. Falling back now
            // could create two R processes using the same session registry.
            throw new Error(
                `Could not start the ${supervisor.kind} session supervisor. Check ${supervisor.kind === 'systemd' ? 'the systemd user service' : 'tmux'} on the R host, ` +
                    `or set r.interactive.supervision to "detached". ${String(error)}`,
                { cause: error },
            );
        }
    } else if (process.platform === 'win32') {
        // Detached avoids libuv's kill-child-on-parent-exit job and console inheritance.
        // libuv does not request CREATE_BREAKAWAY_FROM_JOB: an enclosing job that
        // disallows breakaway still controls lifetime, even with a second launcher.
        // No editor-owned stdio/IPC handles are inherited, including with Electron.
        const descriptor = fs.openSync(path.join(config.storage, 'agent.log'), 'a', 0o600);
        try {
            const child = spawn(node, [agent, file], {
                detached: true,
                windowsHide: true,
                cwd: config.directory,
                env,
                stdio: ['ignore', descriptor, descriptor],
            });
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('spawn', resolve);
            });
            child.unref();
        } finally {
            fs.closeSync(descriptor);
        }
    } else {
        if (supervisor.notice) {
            log(supervisor.notice);
            fs.appendFileSync(path.join(config.storage, 'agent.log'), `${supervisor.notice}\n`, {
                mode: 0o600,
            });
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
        const manifest = readSessionManifest(config.storage, config.id, config.generation);
        if (manifest) {
            if (manifest.startupError) {
                throw new Error(manifest.startupError);
            }
            const live = await probeSession(manifest);
            if (live) {
                return live;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Session agent did not become ready. See ${path.join(config.storage, 'agent.log')}`,
    );
}

export function newIdentity(): { id: string; generation: string } {
    return { id: randomUUID(), generation: randomUUID() };
}
