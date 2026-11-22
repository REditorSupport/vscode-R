import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { BackendEvent } from '../backend';

/** Process ownership is independent of the frontend and its IPC transport. */
export class RuntimeProcess {
    private child?: ChildProcess;
    private pid?: number;
    /**
     * The PID that arf reported for itself, which differs from the started
     * process when the configured executable launches arf as its child.
     */
    private runtimePid?: number;
    private exited = false;
    private closed = false;
    private monitor?: NodeJS.Timeout;
    constructor(
        readonly adopted: boolean,
        private emit: (event: BackendEvent) => void,
    ) {}
    launch(
        command: string,
        args: string[],
        directory: string,
        env: NodeJS.ProcessEnv,
        output: (text: string, channel: string) => void,
    ): ChildProcess {
        this.child = spawn(command, args, {
            cwd: directory,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.pid = this.child.pid;
        this.child.on('error', (error) => {
            this.emit({ type: 'error', message: error.message });
            if (this.child?.pid === undefined) {
                this.exit();
            }
        });
        this.child.on('exit', (code, signal) => this.childExited(code, signal));
        for (const channel of ['stdout', 'stderr'] as const) {
            const decoder = new StringDecoder('utf8');
            this.child[channel]!.on('data', (chunk: Buffer) => {
                if (!this.closed) {
                    output(decoder.write(chunk), channel);
                }
            });
        }
        return this.child;
    }
    setPid(pid: number): void {
        this.pid = pid;
        if (this.adopted && !this.monitor) {
            this.monitor = setInterval(() => {
                if (!this.alive()) {
                    this.exit();
                }
            }, 500);
            this.monitor.unref();
        }
    }
    setRuntimePid(pid: number): void {
        this.runtimePid = pid;
    }
    /**
     * Whether the started process, or the arf it launched, may still be
     * running. A PID that still exists is assumed to be that arf, so an exit
     * is confirmed only once it no longer exists.
     */
    running(): boolean {
        if (this.alive()) {
            return true;
        }
        if (this.runtimePid === undefined || this.runtimePid === this.child?.pid) {
            return false;
        }
        try {
            process.kill(this.runtimePid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    }
    alive(): boolean {
        if (this.exited || !this.pid) {
            return false;
        }
        if (this.child) {
            return this.child.exitCode === null && this.child.signalCode === null;
        }
        try {
            process.kill(this.pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
    }
    /**
     * The exit of the started process is the exit of R, unless it launched
     * arf as its child and that arf is still running: R exits with it.
     */
    private childExited(code: number | null, signal: string | null): void {
        if (!this.running()) {
            this.exit(code, signal);
            return;
        }
        this.monitor ??= setInterval(() => {
            if (!this.running()) {
                this.exit(code, signal);
            }
        }, 500);
        this.monitor.unref();
    }
    private exit(code?: number | null, signal?: string | null): void {
        if (this.exited) {
            return;
        }
        this.exited = true;
        clearInterval(this.monitor);
        if (!this.closed) {
            this.emit({ type: 'exit', code, signal });
        }
    }
    /** Records an exit observed without a process event, such as an adopted PID that vanished. */
    markExited(): void {
        this.exit();
    }
    /**
     * Sends a signal to the R process. The interrupt and stop paths use arf IPC
     * instead: headless arf ends the whole session on SIGINT. Only the started
     * process is signalled: a PID that it did not start may have been reused.
     */
    send(signal: NodeJS.Signals): void {
        if (this.adopted) {
            // The process belongs to whoever started it, and its PID may have
            // been reused since it was adopted.
            throw new Error('An adopted R process is never sent a signal');
        }
        if (!this.alive()) {
            if (!this.running()) {
                this.exit();
            }
            return;
        }
        try {
            // Node's Windows signals forcibly terminate; never use them for interrupt.
            this.child!.kill(process.platform === 'win32' ? 'SIGKILL' : signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                this.exit();
            } else {
                throw error;
            }
        }
    }
    /**
     * Resolves true once the process, and the arf it launched, have exited,
     * or false after `timeout` ms.
     */
    async waitForExit(timeout: number): Promise<boolean> {
        const start = Date.now();
        while (this.running()) {
            if (Date.now() - start >= timeout) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        this.exit();
        return true;
    }
    dispose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearInterval(this.monitor);
    }
}
