import { ConsentResponse, FileConsentService } from './fileConsent';

export type ToolConsentBackend = 'jgd' | 'auto';
export type ToolConsentChoice = 'install' | 'notNow' | 'dontAskAgain' | 'dismiss';

export interface ToolPackagePlan {
    name: string;
    minimumVersion: string;
    version: string;
    repository: string;
    packageType: string;
    sourceBuild: boolean;
}

export interface ToolConsentRequest {
    id: string;
    runtime: string;
    backend: ToolConsentBackend;
    packages: ToolPackagePlan[];
}

export interface ToolConsentServiceOptions {
    directory: string;
    isEnabled: () => boolean;
    isAutoPromptEnabled: () => boolean;
    rememberAutoPromptShown: () => Promise<void>;
    prompt: (request: ToolConsentRequest) => Promise<ToolConsentChoice>;
    intervalMs?: number;
}

const REQUEST_NAME = /^[A-Za-z0-9_-]{1,64}\.request$/;
const RUNTIME = /^[A-Za-z0-9_.-]+\|[0-9]+\.[0-9]+$/;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/;
const PACKAGE_VERSION = /^[0-9]+(?:[.-][0-9]+)*$/;
const PACKAGE_TYPE = /^[A-Za-z0-9_.-]+$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_PACKAGES = 16;

export function parseToolConsentRequest(id: string, content: string): ToolConsentRequest {
    if (Buffer.byteLength(content, 'utf8') > MAX_REQUEST_BYTES || !content.endsWith('\n')) {
        throw new Error('Invalid package consent request size or termination.');
    }
    const normalized = content.replace(/\r\n/g, '\n');
    if (normalized.includes('\r')) throw new Error('Invalid package consent line ending.');
    const lines = normalized.slice(0, -1).split('\n');
    if (lines.length < 5 || lines[0] !== 'vscode-r-package-consent-v1' || lines[1] !== id) {
        throw new Error('Malformed package consent request.');
    }
    const runtime = lines[2];
    const backend = lines[3];
    const count = Number(lines[4]);
    if (
        !RUNTIME.test(runtime) ||
        (backend !== 'jgd' && backend !== 'auto') ||
        !/^(?:[1-9]|1[0-6])$/.test(lines[4]) ||
        count < 1 || count > MAX_PACKAGES ||
        lines.length !== 5 + count * 6
    ) {
        throw new Error('Malformed package consent request header.');
    }
    const packages: ToolPackagePlan[] = [];
    for (let offset = 5; offset < lines.length; offset += 6) {
        const [name, minimumVersion, version, repository, packageType, sourceBuild] = lines.slice(offset, offset + 6);
        if (
            !PACKAGE_NAME.test(name) ||
            !PACKAGE_VERSION.test(minimumVersion) ||
            !PACKAGE_VERSION.test(version) ||
            Buffer.byteLength(repository, 'utf8') > 2048 ||
            !repository ||
            /[\u0000-\u001f\u007f]/.test(repository) ||
            comparePackageVersions(version, minimumVersion) < 0 ||
            !PACKAGE_TYPE.test(packageType) ||
            (sourceBuild !== 'yes' && sourceBuild !== 'no')
        ) {
            throw new Error('Malformed package consent request package entry.');
        }
        packages.push({ name, minimumVersion, version, repository, packageType, sourceBuild: sourceBuild === 'yes' });
    }
    return { id, runtime, backend, packages };
}

function comparePackageVersions(left: string, right: string): number {
    const parse = (version: string) => version.split(/[.-]/).map(Number);
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

/** Bridges a fixed R package plan to a one-time VS Code decision. Use a directory dedicated to this service. */
export class ToolConsentService {
    private readonly bridge: FileConsentService<ToolConsentRequest>;
    private autoPromptInFlight = false;
    private running = false;

    constructor(private readonly options: ToolConsentServiceOptions) {
        this.bridge = new FileConsentService({
            directory: options.directory,
            requestName: REQUEST_NAME,
            maxBytes: MAX_REQUEST_BYTES,
            intervalMs: options.intervalMs,
            isEnabled: options.isEnabled,
            parseRequest: parseToolConsentRequest,
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
        request: ToolConsentRequest,
        respond: (response: ConsentResponse) => Promise<void>,
    ): Promise<void> {
        if (!this.running || !this.options.isEnabled()) {
            await respond('decline');
            return;
        }
        const automatic = request.backend === 'auto';
        if (automatic && (!this.options.isAutoPromptEnabled() || this.autoPromptInFlight)) {
            await respond('decline');
            return;
        }
        if (automatic) this.autoPromptInFlight = true;
        if (automatic) {
            try {
                await this.options.rememberAutoPromptShown();
            } catch {
                this.autoPromptInFlight = false;
                await respond('decline');
                return;
            }
        }
        if (!this.running || !this.options.isEnabled()) {
            if (automatic) this.autoPromptInFlight = false;
            await respond('decline');
            return;
        }
        let choice: ToolConsentChoice = 'dismiss';
        try {
            choice = await this.options.prompt(request);
        } catch {
            choice = 'dismiss';
        }
        if (!this.running || !this.options.isEnabled()) {
            if (automatic) this.autoPromptInFlight = false;
            await respond('decline');
            return;
        }
        if (automatic) {
            this.autoPromptInFlight = false;
        }
        const accepted = choice === 'install' && this.running && this.options.isEnabled();
        await respond(accepted ? 'approve' : 'decline');
    }
}
