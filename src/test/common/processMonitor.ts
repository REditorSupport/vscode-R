import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

/**
 * Sample processes from outside the extension host, so that the samples keep
 * their schedule while the host or the renderer stalls. Each line of the
 * output file is one JSON sample of the process tree containing the watched
 * process, the processes using the most CPU elsewhere, and the whole machine.
 * Run as a script: `processMonitor.js <output> <watched pid> <interval ms> <max lifetime ms>`.
 */

export interface ProcessRow {
    pid: number;
    ppid: number;
    cpuMs: number;
    rssKb: number;
    command: string;
}

const maxOutputBytes = 8 * 1024 * 1024;
const otherProcesses = 10;

/** Parse ps's cumulative CPU time: `[[DD-]HH:]MM:SS[.ss]`. */
export const parseCpuTime = (value: string): number => {
    const [days, rest] = value.includes('-') ? value.split('-', 2) : ['0', value];
    const seconds = rest
        .split(':')
        .map(Number)
        .reduce((total, part) => total * 60 + part, 0);
    return Math.round((Number(days) * 86400 + seconds) * 1000);
};

export const parsePs = (output: string): ProcessRow[] =>
    output
        .split('\n')
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map(([, pid, ppid, time, rss, command]) => ({
            pid: Number(pid),
            ppid: Number(ppid),
            cpuMs: parseCpuTime(time),
            rssKb: Number(rss),
            command,
        }));

/**
 * CPU time each process used since the previous ps. After the baseline, a
 * process that was not in it started since then, so all of its CPU time is
 * new; without a baseline the delta is unknown.
 */
export const withCpuDeltas = (
    rows: ProcessRow[],
    previous: Map<number, number> | undefined,
): (ProcessRow & { cpuDeltaMs: number | undefined })[] =>
    rows.map((row) => ({
        ...row,
        cpuDeltaMs: previous ? row.cpuMs - (previous.get(row.pid) ?? 0) : undefined,
    }));

let runningPs: ChildProcess | undefined;

const listProcesses = (): Promise<ProcessRow[]> =>
    new Promise((resolve, reject) => {
        runningPs = execFile(
            'ps',
            ['-A', '-o', 'pid=,ppid=,time=,rss=,comm='],
            // A ps that hangs is killed, so the monitor can still stop on time.
            { maxBuffer: 16 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL' },
            (error, stdout) => {
                runningPs = undefined;
                if (error) {
                    reject(error);
                } else {
                    resolve(parsePs(stdout));
                }
            },
        );
    });

const cpuTimes = () =>
    os.cpus().reduce(
        (total, cpu) => {
            const { idle, ...busy } = cpu.times;
            total.idle += idle;
            total.busy += Object.values(busy).reduce((sum, value) => sum + value, 0);
            return total;
        },
        { idle: 0, busy: 0 },
    );

/** The watched process's parent and all of its descendants, such as VS Code's processes. */
const treeOf = (rows: ProcessRow[], watched: number): Set<number> => {
    const root = rows.find((row) => row.pid === watched)?.ppid ?? watched;
    const tree = new Set([root]);
    for (let grew = true; grew;) {
        grew = false;
        for (const row of rows) {
            if (!tree.has(row.pid) && tree.has(row.ppid)) {
                tree.add(row.pid);
                grew = true;
            }
        }
    }
    return tree;
};

const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const runMonitor = async (
    output: string,
    watched: number,
    intervalMs: number,
    maxLifetimeMs: number,
): Promise<void> => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let written = 0;
    let truncated = false;
    const write = (entry: unknown): void => {
        if (truncated) {
            return;
        }
        const line = `${JSON.stringify(entry)}\n`;
        if (written + Buffer.byteLength(line) > maxOutputBytes) {
            truncated = true;
            fs.appendFileSync(output, `${JSON.stringify({ kind: 'truncated' })}\n`);
            return;
        }
        written += Buffer.byteLength(line);
        fs.appendFileSync(output, line);
    };
    let stopped = false;
    const stop = (reason: string): void => {
        if (stopped) {
            return;
        }
        stopped = true;
        runningPs?.kill('SIGKILL');
        try {
            write({ kind: 'stop', atUtc: new Date().toISOString(), atMs: elapsed(), reason });
        } finally {
            process.exit(0);
        }
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    // Check the lifetime and the watched process independently of sampling,
    // which may be waiting for ps.
    setInterval(() => {
        if (performance.now() - started >= maxLifetimeMs) {
            stop('maximum lifetime');
        } else if (!isAlive(watched)) {
            stop('watched process exited');
        }
    }, 500);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    write({
        kind: 'start',
        atUtc: new Date().toISOString(),
        pid: process.pid,
        watched,
        intervalMs,
        platform: process.platform,
        release: os.release(),
        cpus: os.cpus().length,
        totalMemKb: Math.round(os.totalmem() / 1024),
    });
    // Undefined until the first successful ps, which only sets the baseline.
    let previousCpu: Map<number, number> | undefined;
    let previousTimes = cpuTimes();
    let expectedMs = 0;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, expectedMs - elapsed())));
        // Times are taken before ps runs; psMs is how long ps took. lagMs is
        // how late this monitor's own timer fired after the previous sample.
        const startMs = elapsed();
        const atUtc = new Date().toISOString();
        let rows: ProcessRow[];
        try {
            rows = await listProcesses();
        } catch (error) {
            write({
                kind: 'error',
                atUtc,
                atMs: startMs,
                psMs: elapsed() - startMs,
                error: String(error),
            });
            expectedMs = elapsed() + intervalMs;
            continue;
        }
        const psMs = elapsed() - startMs;
        const times = cpuTimes();
        const busy = times.busy - previousTimes.busy;
        const total = busy + times.idle - previousTimes.idle;
        previousTimes = times;
        const tree = treeOf(rows, watched);
        const withDelta = withCpuDeltas(rows, previousCpu);
        previousCpu = new Map(rows.map((row) => [row.pid, row.cpuMs]));
        const others = withDelta
            .filter((row) => !tree.has(row.pid) && (row.cpuDeltaMs ?? 0) > 0)
            .sort((a, b) => (b.cpuDeltaMs ?? 0) - (a.cpuDeltaMs ?? 0))
            .slice(0, otherProcesses);
        write({
            kind: 'sample',
            atUtc,
            atMs: startMs,
            lagMs: startMs - expectedMs,
            psMs,
            machine: {
                busyPercent: total > 0 ? Math.round((busy / total) * 1000) / 10 : undefined,
                loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
                freeMemKb: Math.round(os.freemem() / 1024),
            },
            tree: withDelta.filter((row) => tree.has(row.pid)),
            others,
        });
        // Schedule from the end of this sample, so a slow ps is not counted as timer lag.
        expectedMs = elapsed() + intervalMs;
    }
};

export interface ProcessMonitor {
    /** Stop the monitor and wait until it has exited; rejects if it has not. */
    stop(): Promise<void>;
    /** Whether the monitor started and how it ended, for failure reports. */
    status(): unknown;
}

/**
 * Start the monitor as a separate Node process. It also exits by itself once
 * the watched process is gone or its maximum lifetime has passed.
 */
export const startProcessMonitor = (
    output: string,
    {
        watched = process.pid,
        intervalMs = 1000,
        maxLifetimeMs = 15 * 60 * 1000,
    }: { watched?: number; intervalMs?: number; maxLifetimeMs?: number } = {},
): ProcessMonitor => {
    let error: string | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stderr = '';
    const child: ChildProcess = spawn(
        process.execPath,
        [__filename, output, String(watched), String(intervalMs), String(maxLifetimeMs)],
        {
            // The extension host runs on Electron, which needs this to run a Node script.
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
        },
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data: string) => {
        stderr = (stderr + data).slice(-2000);
    });
    const exited = new Promise<void>((resolve) => {
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            resolve();
        });
        child.once('error', (spawnError) => {
            error = String(spawnError);
            resolve();
        });
    });
    const waitForExit = (ms: number): Promise<boolean> => {
        let timer: NodeJS.Timeout | undefined;
        return Promise.race([
            exited.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            }),
        ]).finally(() => clearTimeout(timer));
    };
    return {
        stop: async () => {
            if (exit || error) {
                return;
            }
            child.kill('SIGTERM');
            // A monitor that does not stop must not hold up the test's teardown.
            if (!(await waitForExit(5000))) {
                child.kill('SIGKILL');
                if (!(await waitForExit(5000))) {
                    throw new Error(`Process monitor ${child.pid} did not exit`);
                }
            }
        },
        status: () => ({
            file: output,
            pid: child.pid,
            started: fs.existsSync(output),
            error,
            exit,
            stderr: stderr || undefined,
        }),
    };
};

if (require.main === module) {
    const [output, watched, intervalMs, maxLifetimeMs] = process.argv.slice(2);
    void runMonitor(output, Number(watched), Number(intervalMs), Number(maxLifetimeMs)).catch(
        (error: unknown) => {
            console.error(error);
            process.exit(1);
        },
    );
}
