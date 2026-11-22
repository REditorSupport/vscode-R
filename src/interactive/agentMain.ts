import * as fs from 'fs';
import { AgentConfig } from './protocol';
import { SessionAgent as Agent } from './agent';
import { createBackend } from './backendRegistry';

/** The executable composes the agent with the shipped backend definitions. */
export class SessionAgent extends Agent {
    constructor(config: AgentConfig) {
        super(config, () => createBackend(config));
    }
}

if (require.main === module) {
    // Electron is already running as Node. Do not change how user R code starts
    // other Electron applications (including the editor's CLI).
    delete process.env.ELECTRON_RUN_AS_NODE;
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as AgentConfig;
    const agent = new SessionAgent(config);
    let exiting = false;
    let exitCode = 0;
    function shutdown(): void {
        if (exiting) {
            return;
        }
        exiting = true;
        void agent.close().then(
            () => process.exit(exitCode),
            (error) => {
                process.stderr.write(String(error) + '\n');
                process.exit(1);
            },
        );
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    void agent.start().catch((error) => {
        if (!exiting) {
            process.stderr.write(String(error) + '\n');
            exitCode = 1;
            shutdown();
        }
    });
}
