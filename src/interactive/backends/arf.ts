import { arfRequest } from '../arf';
import { BackendEvent } from '../backend';
import { object, Submission } from '../protocol';
import { RuntimeProcess } from './process';
import { rString } from './rCode';
import { ArfOutput } from './arfOutput';

export class Arf {
    readonly process: RuntimeProcess;
    ready = false;
    private abort = new AbortController();
    private started = false;
    constructor(private command: string, private directory: string, private endpoint: string | undefined,
        adopted: boolean, private emit: (event: BackendEvent) => void,
        private token: string, private event: (message: Record<string, unknown>, channel: string) => void) {
        this.process = new RuntimeProcess(adopted, emit);
    }
    markStarted(): void { this.started = true; }
    async start(bootstrap: string, env: NodeJS.ProcessEnv): Promise<void> {
        if (!this.process.adopted) {
            const output = new Map(['stdout', 'stderr'].map(channel => [channel, new ArfOutput(this.token,
                text => { if (text) { this.emit({ type: 'stream', text, channel }); } },
                message => this.event(message, channel))]));
            this.endpoint = await new Promise<string>((resolve, reject) => {
                let readiness = '';
                const timer = setTimeout(() => reject(new Error('arf did not report its IPC endpoint')), 30000);
                const child = this.process.launch(this.command, ['headless', '--json'], this.directory, env, (text, channel) => {
                    if (channel === 'stdout' && !this.endpoint) {
                        readiness += text;
                        let newline: number;
                        while (!this.endpoint && (newline = readiness.indexOf('\n')) >= 0) {
                            const line = readiness.slice(0, newline); readiness = readiness.slice(newline + 1);
                            let info: Record<string, unknown> | undefined;
                            try { info = object(JSON.parse(line)); } catch { /* Profiles can print before readiness. */ }
                            if (typeof info?.socket_path === 'string') {
                                this.endpoint = info.socket_path; clearTimeout(timer); resolve(this.endpoint);
                            } else { this.emit({ type: 'stream', text: line + '\n', channel }); }
                        }
                        if (this.endpoint || readiness.length > 65536) {
                            if (readiness) { output.get(channel)!.push(readiness); }
                            readiness = '';
                        }
                    } else {
                        try { output.get(channel)!.push(text); }
                        catch (error) { this.emit({ type: 'unavailable', message: String(error) }); }
                    }
                });
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('exit', () => { clearTimeout(timer); reject(new Error('arf exited during startup')); });
            });
        }
        if (!this.endpoint) { throw new Error('Missing arf endpoint'); }
        const metadata = object(await arfRequest(this.endpoint, 'session', {}, 30000, this.abort.signal));
        this.emit({ type: 'provider', data: { provider: this.process.adopted ? 'arf-existing' : 'arf', policy: metadata.ipc_policy } });
        // Visible evaluation respects arf's advertised IPC policy, including bootstrap.
        const result = object(await arfRequest(this.endpoint, 'evaluate', { code: bootstrap, visible: true }, 30000, this.abort.signal));
        if (result.error) { throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error)); }
    }
    dispose(): void { this.abort.abort(); this.process.dispose(); }
    async dispatch(submission: Submission): Promise<void> {
        const code = `sess:::interactive_execute(${rString(submission.id)}, ${rString(submission.code)}, jsonlite::fromJSON(${rString(JSON.stringify(submission.source ?? null))}, simplifyVector=FALSE))`;
        this.started = false;
        // Managed sessions use send to avoid arf's unbounded evaluation capture.
        // R's ordered events establish the outcome even if arf's reply times out.
        let result: Record<string, unknown>;
        try {
            result = object(await arfRequest(this.endpoint!, this.process.adopted ? 'evaluate' : 'user_input',
                { code, visible: true, timeout_ms: 86400000 }, 0, this.abort.signal));
        } catch (error) {
            // A server timeout does not cancel R. Keep accepting its event stream.
            // Other transport failures remain ambiguous and must block dispatch.
            if (!this.process.adopted && this.started && /timed out|timeout/i.test(String(error))) { return; }
            throw error;
        }
        if (this.process.adopted) {
            for (const channel of ['stdout', 'stderr']) {
                if (typeof result[channel] === 'string' && result[channel]) {
                    this.emit({ type: 'stream', text: result[channel], channel });
                }
            }
        }
        if (result.error || result.accepted === false) {
            throw new Error(typeof result.error === 'string' ? result.error : 'arf rejected Interactive execution');
        }
    }
}
