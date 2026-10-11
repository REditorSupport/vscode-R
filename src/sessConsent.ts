import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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

/** Bridges the target R process's bounded consent request to a VS Code prompt. */
export class SessConsentService {
    private timer: NodeJS.Timeout | undefined;
    private stopped = true;
    private readonly pending = new Map<string, Promise<void>>();
    private readonly seen = new Set<string>();
    private readonly activeWrites = new Set<Promise<void>>();

    constructor(private readonly options: SessConsentServiceOptions) { }

    async start(): Promise<void> {
        if (!this.stopped) { return; }
        await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        await this.setOwnerOnlyPermissions(this.options.directory, 0o700);
        this.stopped = false;
        this.timer = setInterval(() => { void this.scan(); }, this.options.intervalMs ?? 200);
        this.timer.unref?.();
        await this.scan();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        // A pending VS Code notification may outlive shutdown. A denial written
        // here wins because the request has a unique, single-use ID.
        await Promise.all([...this.pending.keys()].map(id => this.writeResponse(id, 'decline')));
        await Promise.all(this.activeWrites);
        this.seen.clear();
    }

    private async scan(): Promise<void> {
        if (this.stopped) { return; }
        let names: string[];
        try { names = await fs.readdir(this.options.directory); }
        catch { return; }
        if (this.stopped) { return; }
        const present = new Set(names.filter(name => REQUEST_NAME.test(name)).map(name => name.slice(0, -'.request'.length)));
        for (const id of this.seen) {
            if (!present.has(id) && !this.pending.has(id)) { this.seen.delete(id); }
        }
        for (const name of names) {
            if (!REQUEST_NAME.test(name)) { continue; }
            const id = name.slice(0, -'.request'.length);
            if (this.pending.has(id) || this.seen.has(id)) { continue; }
            this.seen.add(id);
            const work = this.processRequest(id).finally(() => this.pending.delete(id));
            this.pending.set(id, work);
        }
    }

    private async processRequest(id: string): Promise<void> {
        const requestPath = path.join(this.options.directory, `${id}.request`);
        let request: SessConsentRequest;
        try {
            request = this.parseRequest(id, await this.readBoundedRequest(requestPath));
        } catch {
            if (!this.stopped) { await this.writeResponse(id, 'decline'); }
            return;
        }
        if (this.stopped) { return; }
        if (request.revision !== this.options.expectedRevision || !this.options.isEnabled()) {
            await this.writeResponse(id, 'decline');
            return;
        }
        try {
            if (this.options.getDismissedRevision() === request.revision) {
                await this.writeResponse(id, 'decline');
                return;
            }
        } catch {
            // A state read failure cannot grant approval; ask for this request.
        }

        let choice: SessConsentChoice = 'dismiss';
        try { choice = await this.options.prompt(request); }
        catch { choice = 'dismiss'; }
        if (this.stopped) { return; }
        if (!this.options.isEnabled()) {
            await this.writeResponse(id, 'decline');
            return;
        }
        if (choice === 'dontAskAgain') {
            try { await this.options.rememberDismissedRevision(request.revision); }
            catch {
                if (!this.stopped) { await this.writeResponse(id, 'decline'); }
                return;
            }
            if (this.stopped) { return; }
            await this.writeResponse(id, 'decline');
            return;
        }
        const response = !this.stopped && this.options.isEnabled() && choice === 'install' ? 'approve' : 'decline';
        await this.writeResponse(id, response);
    }

    private parseRequest(id: string, content: string): SessConsentRequest {
        if (Buffer.byteLength(content, 'utf8') > 256 || !content.endsWith('\n')) {
            throw new Error('Invalid sess consent request size or termination.');
        }
        const normalized = content.replace(/\r\n/g, '\n');
        if (normalized.includes('\r')) { throw new Error('Invalid sess consent line ending.'); }
        const lines = normalized.slice(0, -1).split('\n');
        if (lines.length !== 5 || lines[0] !== 'vscode-r-sess-consent-v1' || lines[1] !== id
            || !REVISION.test(lines[2]) || !RUNTIME.test(lines[3])
            || (lines[4] !== 'missing' && lines[4] !== 'mismatch')) {
            throw new Error('Malformed sess consent request.');
        }
        return { id, revision: lines[2], runtime: lines[3], reason: lines[4] };
    }

    private async readBoundedRequest(filePath: string): Promise<string> {
        const handle = await fs.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(257);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 256) { throw new Error('Sess consent request exceeds its size limit.'); }
            return buffer.toString('utf8', 0, bytesRead);
        } finally { await handle.close(); }
    }

    private async writeResponse(id: string, response: 'approve' | 'decline'): Promise<void> {
        const write = this.publishResponse(id, response);
        this.activeWrites.add(write);
        try { await write; }
        finally { this.activeWrites.delete(write); }
    }

    private async publishResponse(id: string, response: 'approve' | 'decline'): Promise<void> {
        const finalPath = path.join(this.options.directory, `${id}.response`);
        const temporaryPath = path.join(this.options.directory, `${id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
        try {
            await fs.writeFile(temporaryPath, `${response}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await this.setOwnerOnlyPermissions(temporaryPath, 0o600);
            // Publish in one synchronous step so shutdown/config changes cannot
            // interleave between the final grant check and its visible response.
            const requestPath = path.join(this.options.directory, `${id}.request`);
            if (response === 'approve'
                && (this.stopped || !this.options.isEnabled() || !fsSync.existsSync(requestPath))) {
                await fs.writeFile(temporaryPath, 'decline\n', { encoding: 'utf8', mode: 0o600 });
                await this.setOwnerOnlyPermissions(temporaryPath, 0o600);
            }
            fsSync.renameSync(temporaryPath, finalPath);
            await this.setOwnerOnlyPermissions(finalPath, 0o600);
        } catch {
            await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    }

    private async setOwnerOnlyPermissions(filePath: string, mode: number): Promise<void> {
        if (process.platform !== 'win32') { await fs.chmod(filePath, mode); }
    }
}
