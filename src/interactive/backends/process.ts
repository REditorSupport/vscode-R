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
    private stopping?: Promise<void>;
    constructor(readonly adopted: boolean, private emit: (event: BackendEvent) => void) { }
    launch(command: string, args: string[], directory: string, env: NodeJS.ProcessEnv,
        output: (text: string, channel: string) => void): ChildProcess {
        this.child = spawn(command, args, { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.pid = this.child.pid;
        this.child.on('error', error => { this.emit({ type: 'error', message: error.message }); this.exit(); });
        this.child.on('exit', (code, signal) => this.exit(code, signal));
        for (const channel of ['stdout', 'stderr'] as const) {
            const decoder = new StringDecoder('utf8');
            this.child[channel]!.on('data', (chunk: Buffer) => { if (!this.closed) { output(decoder.write(chunk), channel); } });
        }
        return this.child;
    }
    setPid(pid: number): void {
        this.pid = pid;
        if (this.adopted && !this.monitor) {
            this.monitor = setInterval(() => { if (!this.alive()) { this.exit(); } }, 500);
            this.monitor.unref();
        }
    }
    private alive(): boolean {
        if (this.exited || !this.pid) { return false; }
        if (this.child) { return this.child.exitCode === null && this.child.signalCode === null; }
        try { process.kill(this.pid, 0); return true; }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    private exit(code?: number | null, signal?: string | null): void {
        if (this.exited) { return; }
        this.exited = true; clearInterval(this.monitor);
        if (!this.closed) { this.emit({ type: 'exit', code, signal }); }
    }
    private signal(signal: NodeJS.Signals): void {
        if (!this.alive()) { this.exit(); return; }
        try { process.kill(this.pid!, signal); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') { this.exit(); }
            else { throw error; }
        }
    }
    interrupt(): void { this.signal('SIGINT'); }
    stop(force = false): Promise<void> {
        return this.stopping ??= this.stopProcess(force);
    }
    private async stopProcess(force: boolean): Promise<void> {
        if (!this.pid) { return; }
        this.signal(force ? 'SIGKILL' : 'SIGINT');
        const start = Date.now();
        let terminated = force, killed = force;
        while (this.alive()) {
            if (this.closed) { return; }
            const elapsed = Date.now() - start;
            if (!terminated && elapsed >= 100) { this.signal('SIGTERM'); terminated = true; }
            if (!killed && elapsed >= 3000) { this.signal('SIGKILL'); killed = true; }
            if (elapsed > 5000) { throw new Error('R has not exited after Stop'); }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        this.exit();
    }
    dispose(): void {
        if (this.closed) { return; }
        if (!this.adopted) { this.signal('SIGKILL'); }
        this.closed = true; clearInterval(this.monitor);
    }
}
