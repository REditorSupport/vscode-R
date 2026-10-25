import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export type ConsentResponse = 'approve' | 'decline';

export interface FileConsentServiceOptions<Request> {
    directory: string;
    requestName: RegExp;
    maxBytes: number;
    isEnabled: () => boolean;
    parseRequest: (id: string, content: string) => Request;
    processRequest: (
        request: Request,
        respond: (response: ConsentResponse) => Promise<void>,
    ) => Promise<void>;
    intervalMs?: number;
}

/** Polls a private request directory and publishes a single-use decision. */
export class FileConsentService<Request> {
    private timer: NodeJS.Timeout | undefined;
    private stopped = true;
    private readonly pending = new Map<string, Promise<void>>();
    private readonly seen = new Set<string>();
    private readonly contents = new Map<string, string>();
    private readonly responses = new Set<string>();
    private readonly activeWrites = new Set<Promise<void>>();

    constructor(private readonly options: FileConsentServiceOptions<Request>) {}

    async start(): Promise<void> {
        if (!this.stopped) {
            return;
        }
        await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        await this.setOwnerOnlyPermissions(this.options.directory, 0o700);
        this.stopped = false;
        this.timer = setInterval(() => void this.scan(), this.options.intervalMs ?? 200);
        this.timer.unref?.();
        await this.scan();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await Promise.all([...this.pending.keys()].map((id) => this.respond(id, 'decline')));
        await Promise.all(this.activeWrites);
        this.seen.clear();
    }

    private async scan(): Promise<void> {
        if (this.stopped) {
            return;
        }
        let names: string[];
        try {
            names = await fs.readdir(this.options.directory);
        } catch {
            return;
        }
        if (this.stopped) {
            return;
        }
        const present = new Set(
            names
                .filter((name) => this.options.requestName.test(name))
                .map((name) => name.slice(0, -'.request'.length)),
        );
        for (const id of this.seen) {
            if (!present.has(id) && !this.pending.has(id)) {
                this.seen.delete(id);
                this.responses.delete(id);
            }
        }
        for (const name of names) {
            if (!this.options.requestName.test(name)) {
                continue;
            }
            const id = name.slice(0, -'.request'.length);
            if (this.pending.has(id) || this.seen.has(id)) {
                continue;
            }
            this.seen.add(id);
            const work = this.processFile(id).finally(() => {
                this.pending.delete(id);
                this.contents.delete(id);
            });
            this.pending.set(id, work);
        }
    }

    private async processFile(id: string): Promise<void> {
        const requestPath = path.join(this.options.directory, `${id}.request`);
        let content: string;
        try {
            content = await this.readBoundedRequest(requestPath);
        } catch {
            if (!this.stopped) {
                await this.respond(id, 'decline');
            }
            return;
        }
        this.contents.set(id, content);
        if (this.stopped) {
            await this.respond(id, 'decline');
            return;
        }
        let request: Request;
        try {
            request = this.options.parseRequest(id, content);
        } catch {
            await this.respond(id, 'decline');
            return;
        }
        if (!this.options.isEnabled()) {
            await this.respond(id, 'decline');
            return;
        }
        try {
            await this.options.processRequest(request, (response) => this.respond(id, response));
        } catch {
            await this.respond(id, 'decline');
        }
    }

    private async readBoundedRequest(filePath: string): Promise<string> {
        const handle = await fs.open(filePath, 'r');
        try {
            const buffer = Buffer.alloc(this.options.maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > this.options.maxBytes) {
                throw new Error('Consent request exceeds its size limit.');
            }
            return buffer.toString('utf8', 0, bytesRead);
        } finally {
            await handle.close();
        }
    }

    private async respond(id: string, response: ConsentResponse): Promise<void> {
        if (this.responses.has(id)) {
            return;
        }
        this.responses.add(id);
        const write = this.publishResponse(id, response, this.contents.get(id));
        this.activeWrites.add(write);
        try {
            await write;
        } finally {
            this.activeWrites.delete(write);
        }
    }

    private async publishResponse(
        id: string,
        response: ConsentResponse,
        expectedContent: string | undefined,
    ): Promise<void> {
        const finalPath = path.join(this.options.directory, `${id}.response`);
        const temporaryPath = path.join(
            this.options.directory,
            `${id}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.writeFile(temporaryPath, `${response}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            await this.setOwnerOnlyPermissions(temporaryPath, 0o600);
            const requestPath = path.join(this.options.directory, `${id}.request`);
            let publish =
                response === 'decline' ||
                (!this.stopped && this.options.isEnabled() && fsSync.existsSync(requestPath));
            if (publish && response === 'approve' && expectedContent !== undefined) {
                try {
                    publish = fsSync.readFileSync(requestPath, 'utf8') === expectedContent;
                } catch {
                    publish = false;
                }
            }
            if (!publish) {
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
        if (process.platform !== 'win32') {
            await fs.chmod(filePath, mode);
        }
    }
}
