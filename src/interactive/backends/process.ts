import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { BackendEvent } from '../backend';

/** Process ownership is independent of the frontend and its IPC transport. */
export class RuntimeProcess {
    private child?: ChildProcess;
    private pid?: number;
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
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.pid = this.child.pid;
        this.child.on('error', (error) => {
            this.emit({ type: 'error', message: error.message });
            this.exit();
        });
        this.child.on('exit', (code, signal) => this.exit(code, signal));
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
     * instead: headless arf ends the whole session on SIGINT.
     */
    send(signal: NodeJS.Signals): void {
        if (!this.alive()) {
            this.exit();
            return;
        }
        try {
            process.kill(this.pid!, signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                this.exit();
            } else {
                throw error;
            }
        }
    }
    /** Resolves true once the process has exited, or false after `timeout` ms. */
    async waitForExit(timeout: number): Promise<boolean> {
        const start = Date.now();
        while (this.alive()) {
            if (this.closed) {
                return true;
            }
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
        if (!this.adopted) {
            this.send('SIGKILL');
        }
        this.closed = true;
        clearInterval(this.monitor);
    }
}
