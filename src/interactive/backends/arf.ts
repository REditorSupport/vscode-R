import { arfRequest } from '../arf';
import { BackendEvent } from '../backend';
import { object, Submission } from '../protocol';
import { SessFrontend } from './plainR';
import { RuntimeProcess } from './process';
import { rString } from './rCode';

export class Arf implements SessFrontend {
    readonly process: RuntimeProcess;
    ready = false;
    private abort = new AbortController();
    constructor(
        private command: string,
        private directory: string,
        private endpoint: string | undefined,
        adopted: boolean,
        private emit: (event: BackendEvent) => void,
    ) {
        this.process = new RuntimeProcess(adopted, emit);
    }
    async start(bootstrap: string, env: NodeJS.ProcessEnv): Promise<void> {
        if (!this.process.adopted) {
            this.endpoint = await new Promise<string>((resolve, reject) => {
                let readiness = '';
                const timer = setTimeout(
                    () => reject(new Error('arf did not report its IPC endpoint')),
                    30000,
                );
                const child = this.process.launch(
                    this.command,
                    ['headless', '--json'],
                    this.directory,
                    env,
                    (text, channel) => {
                        if (channel === 'stdout' && !this.endpoint) {
                            readiness += text;
                            let newline: number;
                            while (!this.endpoint && (newline = readiness.indexOf('\n')) >= 0) {
                                const line = readiness.slice(0, newline);
                                readiness = readiness.slice(newline + 1);
                                let info: Record<string, unknown> | undefined;
                                try {
                                    info = object(JSON.parse(line));
                                } catch {
                                    /* Profiles can print before readiness. */
                                }
                                if (typeof info?.socket_path === 'string') {
                                    this.endpoint = info.socket_path;
                                    clearTimeout(timer);
                                    resolve(this.endpoint);
                                } else {
                                    this.emit({ type: 'stream', text: line + '\n', channel });
                                }
                            }
                            if (this.endpoint || readiness.length > 65536) {
                                if (readiness) {
                                    this.emit({ type: 'stream', text: readiness, channel });
                                }
                                readiness = '';
                            }
                        } else if (!this.ready) {
                            this.emit({ type: 'stream', text, channel });
                        }
                    },
                );
                child.once('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once('exit', () => {
                    clearTimeout(timer);
                    reject(new Error('arf exited during startup'));
                });
            });
        }
        if (!this.endpoint) {
            throw new Error('Missing arf endpoint');
        }
        const metadata = object(
            await arfRequest(this.endpoint, 'session', {}, 30000, this.abort.signal),
        );
        this.emit({
            type: 'provider',
            data: {
                provider: this.process.adopted ? 'arf-existing' : 'arf',
                policy: metadata.ipc_policy,
            },
        });
        // Visible evaluation respects arf's advertised IPC policy, including bootstrap.
        const result = object(
            await arfRequest(
                this.endpoint,
                'evaluate',
                { code: bootstrap, visible: true },
                30000,
                this.abort.signal,
            ),
        );
        if (result.error) {
            throw new Error(
                typeof result.error === 'string' ? result.error : JSON.stringify(result.error),
            );
        }
    }
    dispose(): void {
        this.abort.abort();
        this.process.dispose();
    }
    async dispatch(submission: Submission): Promise<void> {
        const code = `sess:::interactive_execute(${rString(submission.id)}, ${rString(submission.code)}, jsonlite::fromJSON(${rString(JSON.stringify(submission.source ?? null))}, simplifyVector=FALSE))`;
        const result = object(
            await arfRequest(
                this.endpoint!,
                'evaluate',
                { code, visible: true },
                0,
                this.abort.signal,
            ),
        );
        if (result.error) {
            throw new Error(
                typeof result.error === 'string' ? result.error : JSON.stringify(result.error),
            );
        }
    }
}
