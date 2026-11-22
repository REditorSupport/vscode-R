import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { createServer } from 'http';
import * as os from 'os';
import * as path from 'path';
import { ArfCommandRunner, discoverArf, probeArfSession } from '../../interactive/arf';
import { localEndpoint } from '../../interactive/transport';

suite('arf session discovery', function () {
    this.timeout(15000);
    let root: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arf-discovery-'));
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    // Any existing executable resolves; the runner decides what it prints.
    const command = process.execPath;
    const listing =
        (value: unknown): ArfCommandRunner =>
        () =>
            Promise.resolve(JSON.stringify(value));

    test('runs arf ipc list without a shell in the given directory and environment', async () => {
        const calls: Parameters<ArfCommandRunner>[] = [];
        const env = { ...process.env, ARF_IPC_SESSIONS_DIR: path.join(root, 'sessions') };
        const discovery = await discoverArf(command, root, env, (...args) => {
            calls.push(args);
            return Promise.resolve('{"sessions":[]}');
        });
        assert.deepStrictEqual(discovery, { available: true, command, sessions: [] });
        assert.strictEqual(calls.length, 1);
        const [file, args, options] = calls[0];
        assert.strictEqual(file, command);
        assert.deepStrictEqual(args, ['ipc', 'list']);
        assert.strictEqual(options.cwd, root);
        assert.strictEqual(options.env, env);
        assert.strictEqual(options.timeout, 5000);
        assert.strictEqual(options.maxBuffer, 1024 * 1024);
    });

    test('a missing CLI is reported as unavailable, not as no sessions', async () => {
        const discovery = await discoverArf(path.join(root, 'missing-arf'), root, process.env, () =>
            assert.fail('a missing CLI must not run'),
        );
        assert.strictEqual(discovery.available, false);
        assert.match(!discovery.available ? discovery.reason : '', /not found/);
    });

    test('keeps valid sessions when the listing also contains malformed ones', async () => {
        const valid = {
            pid: 4242,
            socket_path: '/tmp/arf.sock',
            cwd: '/project',
            r_version: '4.5.1',
            started_at: '2026-11-22T00:00:00Z',
            session_type: 'interactive',
            log_file: null,
        };
        const discovery = await discoverArf(
            command,
            root,
            process.env,
            listing({
                sessions: [
                    valid,
                    { ...valid, pid: 0 },
                    { ...valid, pid: 1.5 },
                    { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 },
                    { ...valid, socket_path: '' },
                    { ...valid, cwd: 7 },
                    null,
                    'arf',
                ],
            }),
        );
        assert.ok(discovery.available);
        assert.deepStrictEqual(discovery.sessions, [
            {
                pid: 4242,
                socket_path: '/tmp/arf.sock',
                cwd: '/project',
                r_version: '4.5.1',
                started_at: '2026-11-22T00:00:00Z',
                session_type: 'interactive',
            },
        ]);
    });

    test('malformed top-level output is reported as unavailable', async () => {
        for (const output of ['not json', '[]', '{"sessions":{}}', '{}']) {
            const discovery = await discoverArf(command, root, process.env, () =>
                Promise.resolve(output),
            );
            assert.strictEqual(discovery.available, false, output);
            assert.match(!discovery.available ? discovery.reason : '', /malformed/);
        }
    });

    // Node runs the script named by its first argument, so `node ipc list`
    // runs `ipc` from the working directory as a stand-in for the arf CLI.
    const fixture = (source: string): void => fs.writeFileSync(path.join(root, 'ipc'), source);
    const reason = async (): Promise<string> => {
        const discovery = await discoverArf(command, root);
        assert.strictEqual(discovery.available, false);
        return !discovery.available ? discovery.reason : '';
    };

    test('a CLI that fails reports its error output', async () => {
        fixture('process.stderr.write("unknown command: ipc"); process.exit(2);');
        assert.match(await reason(), /failed: unknown command: ipc/);
    });

    test('a CLI that prints more than 1 MiB is reported without its output', async () => {
        fixture('process.stdout.write("x".repeat(2 * 1024 * 1024));');
        assert.match(await reason(), /exceeded 1 MiB/);
    });

    test('a CLI that does not finish is stopped at the deadline', async () => {
        fixture('setTimeout(() => {}, 60000);');
        const started = Date.now();
        assert.match(await reason(), /did not finish within 5 seconds/);
        assert.ok(Date.now() - started < 10000);
    });

    test('the deadline holds when the CLI handles SIGTERM and keeps running', async () => {
        fixture('process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000);');
        const started = Date.now();
        assert.match(await reason(), /did not finish within 5 seconds/);
        assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
    });

    test('the deadline closes the output pipes that a subprocess of the CLI keeps open', async function () {
        this.timeout(30000);
        const pidFile = path.join(root, 'subprocess.pid');
        // The subprocess inherits the CLI's stdout and stderr and outlives it.
        fixture(
            `const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });` +
                `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
                'setTimeout(() => {}, 60000);',
        );
        // Open pipes keep a Node process from exiting, so discovery runs in its own.
        const discovery = spawn(
            process.execPath,
            [
                '-e',
                `require(${JSON.stringify(path.join(__dirname, '../../interactive/arf'))}).discoverArf(process.execPath, ${JSON.stringify(root)}).then((result) => console.log(JSON.stringify(result)));`,
            ],
            { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let output = '';
        discovery.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        const started = Date.now();
        try {
            const exited = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), 15000);
                // `close` follows the last output, which `exit` can precede.
                discovery.once('close', () => {
                    clearTimeout(timer);
                    resolve(true);
                });
            });
            assert.ok(exited, 'discovery kept running after its deadline');
            assert.match(output, /did not finish within 5 seconds/);
            assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
        } finally {
            discovery.kill('SIGKILL');
            try {
                process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
            } catch {
                // The subprocess was not started or has already exited.
            }
        }
    });

    test('a CLI that exits by a signal at once is a failure, not a timeout', async function () {
        if (process.platform === 'win32') {
            // This checks how a POSIX signal exit is reported.
            this.skip();
        }
        fixture('process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 60000);');
        assert.match(await reason(), /failed/);
    });

    test('a real CLI listing is parsed', async () => {
        fixture(
            'console.log(JSON.stringify({ sessions: [{ pid: process.pid, socket_path: "s", cwd: process.cwd() }] }));',
        );
        const discovery = await discoverArf(command, root);
        assert.ok(discovery.available);
        assert.strictEqual(discovery.sessions.length, 1);
        assert.strictEqual(fs.realpathSync(discovery.sessions[0].cwd!), fs.realpathSync(root));
    });
});

suite('arf session probe', function () {
    this.timeout(10000);
    let root: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arf-probe-'));
    });
    teardown(() => fs.rmSync(root, { recursive: true, force: true }));

    /**
     * An endpoint that answers `session` with `result`, or, without one, keeps
     * sending a response that never completes.
     */
    async function endpoint(
        result: Record<string, unknown> | undefined,
    ): Promise<{ path: string; close(): Promise<void> }> {
        const timers = new Set<NodeJS.Timeout>();
        const server = createServer((request, response) => {
            request.resume();
            request.on('end', () => {
                if (result) {
                    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
                    return;
                }
                response.write('{');
                const timer = setInterval(() => response.write(' '), 20);
                timers.add(timer);
                response.on('close', () => clearInterval(timer));
            });
        });
        const socket = localEndpoint(root, 'arf.sock');
        await new Promise<void>((resolve) => server.listen(socket, resolve));
        return {
            path: socket,
            close: async () => {
                timers.forEach((timer) => clearInterval(timer));
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            },
        };
    }

    test('confirms a session that answers for the listed PID', async () => {
        const arf = await endpoint({ pid: 4242, session_id: 'abc' });
        try {
            assert.deepStrictEqual(await probeArfSession({ pid: 4242, socket_path: arf.path }), {
                pid: 4242,
                socket_path: arf.path,
                session_id: 'abc',
            });
        } finally {
            await arf.close();
        }
    });

    test('rejects a listed session that has since been replaced under the same PID', async () => {
        const arf = await endpoint({
            pid: 4242,
            session_id: 'replacement',
            started_at: '2026-11-22T00:00:05Z',
        });
        try {
            assert.strictEqual(
                await probeArfSession({
                    pid: 4242,
                    socket_path: arf.path,
                    started_at: '2026-11-22T00:00:00Z',
                }),
                undefined,
            );
            assert.ok(
                await probeArfSession({
                    pid: 4242,
                    socket_path: arf.path,
                    started_at: '2026-11-22T00:00:05Z',
                }),
            );
        } finally {
            await arf.close();
        }
    });

    test('rejects an endpoint that answers for another process or without a session ID', async () => {
        for (const result of [
            { pid: 4243, session_id: 'abc' },
            { pid: 4242 },
            { pid: 4242, session_id: '' },
        ]) {
            const arf = await endpoint(result);
            try {
                assert.strictEqual(
                    await probeArfSession({ pid: 4242, socket_path: arf.path }),
                    undefined,
                    JSON.stringify(result),
                );
            } finally {
                await arf.close();
            }
        }
    });

    test('gives up at the whole deadline even while the endpoint keeps sending', async () => {
        const arf = await endpoint(undefined);
        try {
            const started = Date.now();
            assert.strictEqual(
                await probeArfSession({ pid: 4242, socket_path: arf.path }, 200),
                undefined,
            );
            assert.ok(Date.now() - started < 2000);
        } finally {
            await arf.close();
        }
    });
});
