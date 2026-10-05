import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionAgent } from '../../interactive/agentMain';
import { rString } from '../../interactive/backends/rCode';
import { AgentClient } from '../../interactive/client';
import { installRuntime } from '../../interactive/launcher';
import { SessionEvent } from '../../interactive/protocol';

const run = promisify(execFile);

(process.platform === 'win32' ? suite.skip : suite)('Interactive library isolation', function () {
    this.timeout(120000);
    let root: string;
    let runtime: Awaited<ReturnType<typeof installRuntime>>;
    let userLibrary: string;
    let probe: string;

    function makePackage(name: string): string {
        const directory = path.join(root, name);
        fs.mkdirSync(path.join(directory, 'R'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'DESCRIPTION'), `Package: ${name}\nVersion: 0.0.1\nTitle: Library Test Fixture\nDescription: A disposable package for library destination tests.\nLicense: MIT\nAuthor: R Test\nMaintainer: R Test <test@example.org>\n`);
        fs.writeFileSync(path.join(directory, 'NAMESPACE'), 'export(answer)\n');
        fs.writeFileSync(path.join(directory, 'R', 'answer.R'), 'answer <- function() 42\n');
        return directory;
    }

    suiteSetup(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-libraries-')));
        runtime = await installRuntime(process.cwd(), path.join(root, 'registry'), 'R', () => undefined);
        userLibrary = path.join(root, 'user-library'); fs.mkdirSync(userLibrary);
        probe = makePackage('vscrlibprobe');
        await run('R', ['CMD', 'INSTALL', `--library=${userLibrary}`, makePackage('vscrglobalprobe')]);
    });
    suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

    const startup = '\nstartup_library_paths <- .libPaths()\nstartup_library_env <- Sys.getenv(c("R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"))\n';
    async function check(directory: string, renv: boolean): Promise<void> {
        const previous = { R_PROFILE_USER: process.env.R_PROFILE_USER, R_LIBS: process.env.R_LIBS,
            RENV_PATHS_ROOT: process.env.RENV_PATHS_ROOT };
        // Let R discover this project's profile normally. Forcing R_PROFILE_USER
        // into R CMD INSTALL children makes renv recursively source that profile.
        delete process.env.R_PROFILE_USER;
        process.env.R_LIBS = [userLibrary, previous.R_LIBS].filter(Boolean).join(path.delimiter);
        process.env.RENV_PATHS_ROOT = path.join(root, 'renv-state');
        const id = randomUUID();
        const agent = new SessionAgent({ id, generation: randomUUID(), label: 'Library test', directory,
            storage: path.join(root, id), rPath: 'R', library: runtime.library, resources: runtime.resources,
            provider: 'arf', arfPath: process.env.ARF_PATH ?? 'arf',
            supervision: 'test', plotBackend: 'auto', historyLimit: 10, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
        let client: AgentClient | undefined;
        const events: SessionEvent[] = [];
        const until = async (predicate: () => boolean, timeout = 20000): Promise<void> => {
            const deadline = Date.now() + timeout;
            while (!predicate()) {
                if (Date.now() > deadline) { assert.fail(JSON.stringify(events.slice(-10))); }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        };
        try {
            client = new AgentClient(await agent.start()); await client.connect();
            client.on('event', (event: SessionEvent) => events.push(event)); await client.subscribe(0);
            await until(() => events.some(event => event.type === 'state' && event.data.status === 'idle'));
            const execute = async (code: string): Promise<void> => {
                const execution = randomUUID();
                await client?.request('submit', { submission: { id: execution, code } });
                // R/renv installations involve subprocesses and can take longer
                // on shared CI runners than ordinary cell evaluation.
                await until(() => events.some(event => event.type === 'finished' && event.executionId === execution), 60000);
                const record = await client?.request<{ state: string }>('execution', { id: execution });
                assert.strictEqual(record?.state, 'success', JSON.stringify(events.filter(event => event.executionId === execution)));
            };
            const libraries = (await client.snapshot()).manifest.libraryPaths;
            assert.ok(libraries?.length);
            assert.ok(!libraries.includes(runtime.library));
            await execute(`stopifnot(identical(.libPaths(), startup_library_paths),
  identical(Sys.getenv(c("R_LIBS", "R_LIBS_USER", "R_LIBS_SITE")), startup_library_env),
  normalizePath(getNamespaceInfo("sess", "path")) == normalizePath(${rString(path.join(runtime.library, 'sess'))}))
stopifnot(${renv ? '!' : ''}requireNamespace("vscrglobalprobe", quietly = TRUE))
install.packages(${rString(probe)}, repos = NULL, type = "source")
stopifnot(file.exists(file.path(startup_library_paths[[1L]], "vscrlibprobe", "DESCRIPTION")),
  identical(.libPaths(), startup_library_paths), vscrlibprobe::answer() == 42)
plot(1:3, main = "Libraries preserved")`);
            assert.ok(events.some(event => event.data.kind === 'plot' || event.data.kind === 'image'));
            if (renv) {
                // The bridge must be able to use dependencies loaded lazily by
                // processx on Linux without exposing the whole host library.
                await execute('stopifnot(ps::ps_pid() == Sys.getpid(), identical(.libPaths(), startup_library_paths))');
                // Record the local fixture's source so this also tests a real
                // offline restore, rather than forcing an unreproducible lockfile.
                await execute(`renv::install(${rString(probe)}, rebuild = TRUE, prompt = FALSE)
renv::snapshot(type = "all", prompt = FALSE)
packages <- names(renv::lockfile_read("renv.lock")$Packages)
stopifnot("vscrlibprobe" %in% packages, !"sess" %in% packages, !"ps" %in% packages, !"vscrglobalprobe" %in% packages)
unloadNamespace("vscrlibprobe")
unlink(file.path(.libPaths()[[1L]], "vscrlibprobe"), recursive = TRUE)
renv::restore(prompt = FALSE)
stopifnot(vscrlibprobe::answer() == 42, identical(.libPaths(), startup_library_paths))`);
            }
            await execute('stopifnot(vscrlibprobe::answer() == 42); cat("still usable")');
            assert.ok(!fs.existsSync(path.join(runtime.library, 'vscrlibprobe')));
        } finally {
            client?.close(); await agent.close();
            await new Promise(resolve => setTimeout(resolve, 200));
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
            }
        }
    }

    test('preserves profile library order and installs into the normal user library', async () => {
        const directory = path.join(root, 'ordinary'); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.Rprofile'), `cat("Starting profile λ\\n{\\"profile\\":true}\\n")\n.libPaths(c(${rString(userLibrary)}, .libPaths()))` + startup);
        await check(directory, false);
    });

    test('preserves renv isolation, project installs and snapshots without adding the bridge', async () => {
        const directory = path.join(root, 'project'); fs.mkdirSync(directory);
        await run('R', ['--vanilla', '--slave', '-e', 'options(renv.consent=TRUE); renv::init(bare=TRUE, force=TRUE)'], {
            cwd: directory, env: { ...process.env, RENV_PATHS_ROOT: path.join(root, 'renv-state') }, timeout: 30000,
        });
        fs.appendFileSync(path.join(directory, '.Rprofile'), startup);
        await check(directory, true);
    });
});
