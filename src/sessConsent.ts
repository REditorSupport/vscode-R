import { ConsentResponse, FileConsentService } from './fileConsent';

export type SessConsentReason = 'missing' | 'mismatch';

export interface SessConsentRequest {
    id: string;
    revision: string;
    runtime: string;
    reason: SessConsentReason;
}

export type SessConsentChoice = 'install' | 'notNow' | 'dontAskAgain' | 'dismiss';

export interface SessConsentServiceOptions {
    directory: string;
    expectedRevision: string;
    isEnabled: () => boolean;
    getDismissedRevision: () => string | undefined;
    rememberDismissedRevision: (revision: string) => Promise<void>;
    prompt: (request: SessConsentRequest) => Promise<SessConsentChoice>;
    intervalMs?: number;
}

const REQUEST_NAME = /^[A-Za-z0-9_-]{1,64}\.request$/;
const REVISION = /^git-tree:(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUNTIME = /^[A-Za-z0-9_.-]+\|[0-9]+\.[0-9]+$/;

/** Bridges sess requests to VS Code. Use a directory dedicated to this service. */
export class SessConsentService {
    private readonly bridge: FileConsentService<SessConsentRequest>;
    private running = false;

    constructor(private readonly options: SessConsentServiceOptions) {
        this.bridge = new FileConsentService({
            directory: options.directory,
            requestName: REQUEST_NAME,
            maxBytes: 256,
            intervalMs: options.intervalMs,
            isEnabled: options.isEnabled,
            parseRequest: (id, content) => this.parseRequest(id, content),
            processRequest: (request, respond) => this.processRequest(request, respond),
        });
    }

    start(): Promise<void> {
        this.running = true;
        return this.bridge.start();
    }

    stop(): Promise<void> {
        this.running = false;
        return this.bridge.stop();
    }

    private async processRequest(
        request: SessConsentRequest,
        respond: (response: ConsentResponse) => Promise<void>,
    ): Promise<void> {
        if (request.revision !== this.options.expectedRevision || !this.options.isEnabled()) {
            await respond('decline');
            return;
        }
        try {
            if (this.options.getDismissedRevision() === request.revision) {
                await respond('decline');
                return;
            }
        } catch {
            // A state read failure cannot grant approval; ask for this request.
        }

        let choice: SessConsentChoice = 'dismiss';
        try {
            choice = await this.options.prompt(request);
        } catch {
            choice = 'dismiss';
        }
        if (!this.running) {
            return;
        }
        if (!this.options.isEnabled()) {
            await respond('decline');
            return;
        }
        if (choice === 'dontAskAgain') {
            try {
                await this.options.rememberDismissedRevision(request.revision);
            } catch {
                await respond('decline');
                return;
            }
            if (!this.running) {
                return;
            }
            await respond('decline');
            return;
        }
        await respond(choice === 'install' && this.options.isEnabled() ? 'approve' : 'decline');
    }

    private parseRequest(id: string, content: string): SessConsentRequest {
        if (Buffer.byteLength(content, 'utf8') > 256 || !content.endsWith('\n')) {
            throw new Error('Invalid sess consent request size or termination.');
        }
        const normalized = content.replace(/\r\n/g, '\n');
        if (normalized.includes('\r')) {
            throw new Error('Invalid sess consent line ending.');
        }
        const lines = normalized.slice(0, -1).split('\n');
        if (
            lines.length !== 5 ||
            lines[0] !== 'vscode-r-sess-consent-v1' ||
            lines[1] !== id ||
            !REVISION.test(lines[2]) ||
            !RUNTIME.test(lines[3]) ||
            (lines[4] !== 'missing' && lines[4] !== 'mismatch')
        ) {
            throw new Error('Malformed sess consent request.');
        }
        return { id, revision: lines[2], runtime: lines[3], reason: lines[4] };
    }
}
