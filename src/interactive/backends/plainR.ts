import { BackendEvent } from '../backend';
import { Submission } from '../protocol';
import { SessBridge } from './sessBridge';
import { RuntimeProcess } from './process';

export interface SessFrontend {
    readonly process: RuntimeProcess;
    ready: boolean;
    start(bootstrap: string, env: NodeJS.ProcessEnv): Promise<void>;
    dispatch(submission: Submission): Promise<void>;
    dispose(): void;
}

export class PlainR implements SessFrontend {
    readonly process: RuntimeProcess;
    ready = false;
    constructor(
        private command: string,
        private directory: string,
        private bridge: SessBridge,
        private emit: (event: BackendEvent) => void,
    ) {
        this.process = new RuntimeProcess(false, emit);
    }
    start(bootstrap: string, env: NodeJS.ProcessEnv): Promise<void> {
        const child = this.process.launch(
            this.command,
            ['--quiet', '--no-save', '--no-restore', '--interactive'],
            this.directory,
            env,
            (text, channel) => this.emit({ type: 'stream', text, channel }),
        );
        child.stdin!.on('error', (error) => this.emit({ type: 'error', message: error.message }));
        child.stdin!.write(bootstrap + '\n');
        return Promise.resolve();
    }
    dispose(): void {
        this.process.dispose();
    }
    async dispatch(submission: Submission): Promise<void> {
        await this.bridge.request('interactive_execute', {
            id: submission.id,
            code: submission.code,
            source: submission.source,
        });
    }
}
