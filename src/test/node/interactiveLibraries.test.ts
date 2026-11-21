import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { randomUUID } from 'crypto';
import { channel } from 'diagnostics_channel';
import { EventEmitter, once } from 'events';
import { ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import { SessBackend } from '../../interactive/backends/sessBackend';
import { BackendEvent } from '../../interactive/backend';
import { SessionAgent } from '../../interactive/agentMain';
import { rString } from '../../interactive/backends/rCode';
import { AgentClient } from '../../interactive/client';
import { installRuntime } from '../../interactive/launcher';
import { SessionEvent } from '../../interactive/protocol';

const run = promisify(execFile);

suite('Interactive library isolation', function () {
    this.timeout(120000);
    let root: string;
    let runtime: Awaited<ReturnType<typeof installRuntime>>;
    let userLibrary: string;
    let probe: string;

    function makePackage(name: string): string {
        const directory = path.join(root, name);
        fs.mkdirSync(path.join(directory, 'R'), { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'DESCRIPTION'),
            `Package: ${name}\nVersion: 0.0.1\nTitle: Library Test Fixture\nDescription: A disposable package for library destination tests.\nLicense: MIT\nAuthor: R Test\nMaintainer: R Test <test@example.org>\n`,
        );
        fs.writeFileSync(path.join(directory, 'NAMESPACE'), 'export(answer)\n');
        fs.writeFileSync(path.join(directory, 'R', 'answer.R'), 'answer <- function() 42\n');
        return directory;
    }

    suiteSetup(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-libraries-')));
        runtime = await installRuntime(
            process.cwd(),
            path.join(root, 'registry'),
            'R',
            () => undefined,
        );
        userLibrary = path.join(root, 'user-library');
        fs.mkdirSync(userLibrary);
        probe = makePackage('vscrlibprobe');
        await run('R', [
            'CMD',
            'INSTALL',
            `--library=${userLibrary}`,
            makePackage('vscrglobalprobe'),
        ]);
    });
    suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

    const startup =
        '\nstartup_library_paths <- .libPaths()\nstartup_library_env <- Sys.getenv(c("R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"))\n';
    test('loads private-only bridge dependencies without redirecting user package installs', async function () {
        // This fixture replaces the base library with symlinks, requiring Windows privileges.
        if (process.platform === 'win32') {
            this.skip();
        }
        const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r-lib-'));
        const endpoint = path.join(socketRoot, 's');
        const sockets = new Set<net.Socket>();
        let received = '';
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('data', (data) => {
                received += data.toString();
            });
            socket.on('close', () => sockets.delete(socket));
        });
        const script = path.join(root, 'private-dependencies.R');
        const privateLibrary = path.join(root, 'private-dependencies-library');
        fs.cpSync(runtime.library, privateLibrary, { recursive: true });
        const config = path.join(root, 'private-dependencies.json');
        fs.writeFileSync(
            config,
            JSON.stringify({ sess: endpoint, jgd: '', token: randomUUID(), useJgd: false }),
        );
        fs.writeFileSync(
            script,
            `
private <- ${rString(privateLibrary)}
user <- ${rString(userLibrary)}
database <- installed.packages(lib.loc=unique(c(private,.libPaths())))
# The Interactive setup installs rstudioapi beside sess although sess only suggests it.
dependencies <- unique(c("ps", "rstudioapi", unlist(tools::package_dependencies(
    c("sess","ps"), database, which=c("Depends","Imports","LinkingTo"), recursive=TRUE))))
for (package in dependencies) {
    if (!is.na(database[package,"Priority"]) || dir.exists(file.path(private,package))) next
    stopifnot(file.copy(file.path(database[package,"LibPath"],package),private,recursive=TRUE))
}
# A base/recommended-only library prevents globally installed dependencies from
# hiding the first-time setup failure. This change lives only in this R child.
system <- ${rString(path.join(root, 'base-library'))}
dir.create(system)
base_packages <- installed.packages(lib.loc=.Library)
base_packages <- rownames(base_packages)[!is.na(base_packages[,"Priority"])]
stopifnot(all(file.symlink(file.path(.Library,base_packages),file.path(system,base_packages))))
unlockBinding(".Library",baseenv())
assign(".Library",system,baseenv())
lockBinding(".Library",baseenv())
.libPaths(c(user,system),include.site=FALSE)
stopifnot(!requireNamespace("jsonlite",quietly=TRUE))
before <- .libPaths()
environment <- Sys.getenv(c("R_LIBS","R_LIBS_USER","R_LIBS_SITE"))
source(${rString(path.join(runtime.resources, 'interactive-worker.R'))},
       local=new.env(parent=baseenv()))$value(private,${rString(config)},support_libraries=system)
for (package in c("sess","jsonlite","later","ps","processx","rstudioapi")) {
    stopifnot(normalizePath(getNamespaceInfo(package,"path"))==normalizePath(file.path(private,package)))
}
stopifnot(identical(before,.libPaths()), !private %in% .libPaths(),
          identical(environment,Sys.getenv(c("R_LIBS","R_LIBS_USER","R_LIBS_SITE"))))
install.packages(${rString(probe)},repos=NULL,type="source")
stopifnot(file.exists(file.path(user,"vscrlibprobe","DESCRIPTION")),
          !file.exists(file.path(private,"vscrlibprobe")),vscrlibprobe::answer()==42,
          identical(before,.libPaths()))
sess::interactive_stop()
cat("Private bridge dependencies loaded; user package installed into the user library.")
`,
        );
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(endpoint, resolve);
            });
            const stdout = await new Promise<string>((resolve, reject) => {
                const child = execFile(
                    'R',
                    ['--vanilla', '--quiet', '--interactive'],
                    { timeout: 60000 },
                    (error, stdout, stderr) =>
                        error ? reject(new Error(stderr, { cause: error })) : resolve(stdout),
                );
                child.stdin!.end(`tryCatch(source(${rString(script)}), error=function(e) {
    message(conditionMessage(e)); quit(save="no",status=1)
})
quit(save="no")
`);
            });
            assert.match(
                stdout,
                /Private bridge dependencies loaded; user package installed into the user library/,
            );
            assert.match(received, /"method":"attach"/);
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            fs.rmSync(socketRoot, { recursive: true, force: true });
            fs.rmSync(path.join(userLibrary, 'vscrlibprobe'), { recursive: true, force: true });
        }
    });

    test('uses the active R for jgd plots and starts standard graphics without an R helper', async function () {
        const jgd = await run('R', [
            '--vanilla',
            '--slave',
            '-e',
            'cat(find.package("jgd", quiet=TRUE))',
        ]);
        if (!jgd.stdout.trim()) {
            if (process.env.VSCR_REQUIRE_PLOT_TESTS === '1') {
                assert.fail('Live plot tests require the jgd R package');
            }
            this.skip();
        }
        const personal = path.join(root, 'personal plots');
        const shadow = path.join(root, 'shadow');
        fs.mkdirSync(personal);
        fs.cpSync(jgd.stdout.trim(), path.join(personal, 'jgd'), {
            recursive: true,
            dereference: true,
        });
        // These incomplete packages mask any global installations in a vanilla R process.
        for (const name of ['jgd', 'systemfonts']) {
            fs.mkdirSync(path.join(shadow, name), { recursive: true });
            fs.writeFileSync(
                path.join(shadow, name, 'DESCRIPTION'),
                `Package: ${name}\nVersion: 0.0.1\n`,
            );
        }
        const measured = path.join(root, 'measured.txt');
        const fonts = makePackage('systemfonts');
        fs.writeFileSync(path.join(fonts, 'NAMESPACE'), 'export(string_width, font_info)\n');
        fs.writeFileSync(
            path.join(fonts, 'R', 'answer.R'),
            `
string_width <- function(string, ...) {
    cat(string, "\\n", file=${rString(measured)}, append=TRUE)
    8 * nchar(string)
}
font_info <- function(...) list(max_ascend=9, max_descend=-2)
`,
        );
        await run('R', ['CMD', 'INSTALL', `--library=${personal}`, fonts]);
        const previous = {
            R_LIBS: process.env.R_LIBS,
            R_ENVIRON_USER: process.env.R_ENVIRON_USER,
            R_PROFILE_USER: process.env.R_PROFILE_USER,
        };
        process.env.R_LIBS = [shadow, previous.R_LIBS].filter(Boolean).join(path.delimiter);
        delete process.env.R_ENVIRON_USER;
        delete process.env.R_PROFILE_USER;
        try {
            for (const [plotBackend, startupFile] of [
                ['jgd', '.Renviron'],
                ['auto', '.Rprofile'],
                ['jgd', ''],
                ['auto', ''],
                ['standard', ''],
            ] as const) {
                const title = `Library plot ${plotBackend} ${startupFile || 'missing'}`;
                const directory = path.join(root, title);
                fs.mkdirSync(directory);
                const profileRuns = path.join(directory, 'profiles.txt');
                fs.writeFileSync(
                    path.join(directory, '.Renviron'),
                    startupFile === '.Renviron'
                        ? `R_LIBS="${personal.split(path.sep).join('/')}${path.delimiter}\${R_LIBS}"\n`
                        : '',
                );
                fs.writeFileSync(
                    path.join(directory, '.Rprofile'),
                    `cat(R.home(), "\\n", sep="", file=${rString(profileRuns)}, append=TRUE)\n` +
                        (startupFile === '.Rprofile'
                            ? `.libPaths(c(${rString(personal)}, .libPaths()))\n`
                            : ''),
                );
                const backend = new SessBackend(
                    {
                        id: randomUUID(),
                        generation: randomUUID(),
                        label: title,
                        directory,
                        storage: root,
                        provider: 'arf',
                        supervision: 'test',
                        historyLimit: 10,
                        maxOutputBytes: 1048576,
                        maxJournalBytes: 16777216,
                    },
                    {
                        frontend: 'arf',
                        ownership: 'managed',
                        // Preparation succeeded earlier. arf now supplies its own R installation.
                        rPath: path.join(root, 'unavailable-configured-R'),
                        arfPath: process.env.ARF_PATH ?? 'arf',
                        library: runtime.library,
                        resources: runtime.resources,
                        plotBackend,
                    },
                );
                const events: BackendEvent[] = [];
                const completion = new EventEmitter();
                const children: ChildProcess[] = [];
                const launches = channel('child_process');
                const observeLaunch = (message: unknown): void => {
                    children.push((message as { process: ChildProcess }).process);
                };
                backend.onEvent((event) => {
                    events.push(event);
                    if (event.type === 'finished') {
                        completion.emit('finished', event.state);
                    }
                });
                launches.subscribe(observeLaunch);
                try {
                    if (!startupFile && plotBackend === 'jgd') {
                        await assert.rejects(backend.start(), /jgd, systemfonts\./);
                        continue;
                    }
                    await backend.start();
                    const homes = fs.readFileSync(profileRuns, 'utf8').trim().split(/\r?\n/);
                    assert.strictEqual(homes.length, 1, 'Expected one R profile evaluation');
                    const executable = process.platform === 'win32' ? 'R.exe' : 'R';
                    const helpers = children.filter(
                        (child) => path.basename(child.spawnfile) === executable,
                    );
                    if (plotBackend === 'standard') {
                        assert.strictEqual(helpers.length, 0);
                    } else if (startupFile) {
                        const activeR = fs.realpathSync.native(
                            path.join(homes[0], 'bin', executable),
                        );
                        assert.deepStrictEqual(
                            helpers.map((child) => fs.realpathSync.native(child.spawnfile)),
                            [activeR, activeR],
                            'Expected only the package check and font metrics helper',
                        );
                    }
                    assert.strictEqual(backend.capabilities.jgd, !!startupFile, title);
                    const [state] = await Promise.all([
                        once(completion, 'finished', { signal: AbortSignal.timeout(20000) }),
                        backend.dispatch({
                            id: randomUUID(),
                            code: `plot(1:3, main=${rString(title)}); strwidth(${rString(title)})`,
                        }),
                    ]);
                    assert.deepStrictEqual(state, ['success']);
                    if (!startupFile) {
                        assert.ok(
                            events.some((e) => e.type === 'display' && e.data.kind === 'image'),
                            'Expected a static plot',
                        );
                        continue;
                    }
                    assert.ok(
                        events.some(
                            (e) =>
                                e.type === 'display' &&
                                e.data.kind === 'plot' &&
                                String(e.data.svg).includes(title),
                        ),
                        'Expected a labelled jgd SVG',
                    );
                    assert.ok(
                        fs.readFileSync(measured, 'utf8').includes(title),
                        'Expected project font metrics',
                    );
                } finally {
                    launches.unsubscribe(observeLaunch);
                    await backend.dispose();
                }
            }
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    function renvEnvironment(): NodeJS.ProcessEnv {
        return {
            RENV_PATHS_ROOT: path.join(root, 'renv-state'),
            RENV_PATHS_SANDBOX: path.join(root, 'renv-sandbox'),
            RENV_CONFIG_SANDBOX_ENABLED: 'TRUE',
            // Keep the temporary sandbox writable for suite teardown.
            RENV_SANDBOX_LOCKING_ENABLED: 'FALSE',
        };
    }

    async function check(
        directory: string,
        renv: boolean,
        bridgeLibrary = runtime.library,
    ): Promise<void> {
        const previous = {
            R_PROFILE_USER: process.env.R_PROFILE_USER,
            R_LIBS: process.env.R_LIBS,
            ...Object.fromEntries(
                Object.keys(renvEnvironment()).map((key) => [key, process.env[key]]),
            ),
        };
        // Let R discover this project's profile normally. Forcing R_PROFILE_USER
        // into R CMD INSTALL children makes renv recursively source that profile.
        delete process.env.R_PROFILE_USER;
        process.env.R_LIBS = [userLibrary, previous.R_LIBS].filter(Boolean).join(path.delimiter);
        Object.assign(process.env, renvEnvironment());
        const id = randomUUID();
        const agent = new SessionAgent({
            id,
            generation: randomUUID(),
            label: 'Library test',
            directory,
            storage: path.join(root, id),
            rPath: 'R',
            library: bridgeLibrary,
            resources: runtime.resources,
            provider: 'arf',
            arfPath: process.env.ARF_PATH ?? 'arf',
            supervision: 'test',
            // An isolated project with standard graphics has no graphics probe
            // to supply host paths for the bridge's missing dependencies.
            plotBackend: renv ? 'standard' : 'auto',
            historyLimit: 10,
            maxOutputBytes: 1048576,
            maxJournalBytes: 16777216,
        });
        let client: AgentClient | undefined;
        const events: SessionEvent[] = [];
        const until = async (predicate: () => boolean, timeout = 20000): Promise<void> => {
            const deadline = Date.now() + timeout;
            while (!predicate()) {
                if (Date.now() > deadline) {
                    assert.fail(JSON.stringify(events.slice(-10)));
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        };
        try {
            client = new AgentClient(await agent.start());
            await client.connect();
            client.on('event', (event: SessionEvent) => events.push(event));
            await client.subscribe(0);
            await until(() =>
                events.some((event) => event.type === 'state' && event.data.status === 'idle'),
            );
            const execute = async (code: string): Promise<void> => {
                const execution = randomUUID();
                await client?.request('submit', { submission: { id: execution, code } });
                // R/renv installations involve subprocesses and can take longer
                // on shared CI runners than ordinary cell evaluation.
                await until(
                    () =>
                        events.some(
                            (event) => event.type === 'finished' && event.executionId === execution,
                        ),
                    60000,
                );
                const record = await client?.request<{ state: string }>('execution', {
                    id: execution,
                });
                assert.strictEqual(
                    record?.state,
                    'success',
                    JSON.stringify(events.filter((event) => event.executionId === execution)),
                );
            };
            const libraries = (await client.snapshot()).manifest.libraryPaths;
            assert.ok(libraries?.length);
            assert.ok(!libraries.includes(bridgeLibrary));
            await execute(`stopifnot(identical(.libPaths(), startup_library_paths),
  identical(Sys.getenv(c("R_LIBS", "R_LIBS_USER", "R_LIBS_SITE")), startup_library_env),
  normalizePath(getNamespaceInfo("sess", "path")) == normalizePath(${rString(path.join(bridgeLibrary, 'sess'))}))
stopifnot(${renv ? '!' : ''}requireNamespace("vscrglobalprobe", quietly = TRUE))
install.packages(${rString(probe)}, repos = NULL, type = "source")
stopifnot(file.exists(file.path(startup_library_paths[[1L]], "vscrlibprobe", "DESCRIPTION")),
  identical(.libPaths(), startup_library_paths), vscrlibprobe::answer() == 42)
plot(1:3, main = "Libraries preserved")`);
            assert.ok(
                events.some((event) => event.data.kind === 'plot' || event.data.kind === 'image'),
            );
            if (renv) {
                // ps is available only to the bridge via the original host environment.
                await execute(`stopifnot(
  !length(find.package("ps", lib.loc=.libPaths(), quiet=TRUE)),
  normalizePath(getNamespaceInfo("ps", "path")) == normalizePath(${rString(path.join(userLibrary, 'ps'))}),
  ps::ps_pid() == Sys.getpid(), identical(.libPaths(), startup_library_paths))`);
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
            assert.ok(!fs.existsSync(path.join(bridgeLibrary, 'vscrlibprobe')));
        } finally {
            client?.close();
            await agent.close();
            await new Promise((resolve) => setTimeout(resolve, 200));
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    }

    test('preserves profile library order and installs into the normal user library', async () => {
        const directory = path.join(root, 'ordinary');
        fs.mkdirSync(directory);
        fs.writeFileSync(
            path.join(directory, '.Rprofile'),
            `cat("Starting profile λ\\n{\\"profile\\":true}\\n")\n.libPaths(c(${rString(userLibrary)}, .libPaths()))` +
                startup,
        );
        await check(directory, false);
    });

    test('preserves renv isolation, project installs and snapshots without adding the bridge', async () => {
        const directory = path.join(root, 'project');
        fs.mkdirSync(directory);
        const bridgeLibrary = path.join(root, 'renv-bridge');
        fs.cpSync(runtime.library, bridgeLibrary, {
            recursive: true,
            filter: (source) => source !== path.join(runtime.library, 'ps'),
        });
        await run(
            'R',
            [
                '--vanilla',
                '--slave',
                '-e',
                `stopifnot(file.copy(find.package("ps", lib.loc=c(${rString(runtime.library)}, .libPaths())),
  ${rString(userLibrary)}, recursive=TRUE))
options(renv.consent=TRUE); renv::init(bare=TRUE, force=TRUE)`,
            ],
            {
                cwd: directory,
                env: { ...process.env, ...renvEnvironment() },
                timeout: 30000,
            },
        );
        fs.appendFileSync(
            path.join(directory, '.Rprofile'),
            '\nSys.setenv(R_LIBS=.libPaths()[1L], R_LIBS_USER=.libPaths()[1L], R_LIBS_SITE=.Library)\n' +
                startup,
        );
        await check(directory, true, bridgeLibrary);
    });
});
