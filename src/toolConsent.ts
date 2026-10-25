import { ConsentResponse, FileConsentService } from './fileConsent';
import { isToolPackageName } from './toolVersions';

/**
 * `always` asks on every request; `once` asks at most once per host session for each package
 * and honors a remembered "Don't ask again".
 */
export type ToolConsentPolicy = 'always' | 'once';
export type ToolConsentChoice = 'install' | 'notNow' | 'dontAskAgain' | 'dismiss';

export interface ToolConsentSessionState {
    /** Packages already offered under the `once` policy in this extension host. */
    promptedPackages: Set<string>;
}

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
    policy: ToolConsentPolicy;
    packages: ToolPackagePlan[];
}

export interface ToolConsentServiceOptions {
    directory: string;
    isEnabled: () => boolean;
    isPromptEnabled: (packageName: string) => boolean;
    sessionState: ToolConsentSessionState;
    rememberPromptDismissal: (packageName: string) => Promise<void>;
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
    if (normalized.includes('\r')) {
        throw new Error('Invalid package consent line ending.');
    }
    const lines = normalized.slice(0, -1).split('\n');
    if (lines.length < 5 || lines[0] !== 'vscode-r-package-consent-v1' || lines[1] !== id) {
        throw new Error('Malformed package consent request.');
    }
    const runtime = lines[2];
    const policy = lines[3];
    const count = Number(lines[4]);
    if (
        !RUNTIME.test(runtime) ||
        (policy !== 'always' && policy !== 'once') ||
        !/^(?:[1-9]|1[0-6])$/.test(lines[4]) ||
        count < 1 ||
        count > MAX_PACKAGES ||
        lines.length !== 5 + count * 6
    ) {
        throw new Error('Malformed package consent request header.');
    }
    const packages: ToolPackagePlan[] = [];
    for (let offset = 5; offset < lines.length; offset += 6) {
        const [name, minimumVersion, version, repository, packageType, sourceBuild] = lines.slice(
            offset,
            offset + 6,
        );
        if (
            !PACKAGE_NAME.test(name) ||
            !PACKAGE_VERSION.test(minimumVersion) ||
            !PACKAGE_VERSION.test(version) ||
            Buffer.byteLength(repository, 'utf8') > 2048 ||
            !repository ||
            // eslint-disable-next-line no-control-regex -- repository values must not contain control characters
            /[\u0000-\u001f\u007f]/.test(repository) ||
            !PACKAGE_TYPE.test(packageType) ||
            (sourceBuild !== 'yes' && sourceBuild !== 'no')
        ) {
            throw new Error('Malformed package consent request package entry.');
        }
        packages.push({
            name,
            minimumVersion,
            version,
            repository,
            packageType,
            sourceBuild: sourceBuild === 'yes',
        });
    }
    return { id, runtime, policy, packages };
}

/** Bridges a fixed R package plan to a one-time VS Code decision. Use a directory dedicated to this service. */
export class ToolConsentService {
    private readonly bridge: FileConsentService<ToolConsentRequest>;
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

    /** Whether a request for these packages under this policy could currently be shown. */
    canPrompt(packageNames: readonly string[], policy: ToolConsentPolicy): boolean {
        if (!this.running || !this.options.isEnabled() || packageNames.length === 0) {
            return false;
        }
        return packageNames.every((name) => {
            if (!isToolPackageName(name)) {
                return false;
            }
            return (
                policy === 'always' ||
                (this.options.isPromptEnabled(name) &&
                    !this.options.sessionState.promptedPackages.has(name))
            );
        });
    }

    private async processRequest(
        request: ToolConsentRequest,
        respond: (response: ConsentResponse) => Promise<void>,
    ): Promise<void> {
        const names = request.packages.map((item) => item.name);
        const once = request.policy === 'once';
        if (!this.canPrompt(names, request.policy)) {
            await respond('decline');
            return;
        }
        if (once) {
            for (const name of names) {
                this.options.sessionState.promptedPackages.add(name);
            }
        }
        let choice: ToolConsentChoice = 'dismiss';
        try {
            choice = await this.options.prompt(request);
        } catch {
            choice = 'dismiss';
        }
        if (!this.running || !this.options.isEnabled()) {
            await respond('decline');
            return;
        }
        if (once && choice === 'dontAskAgain') {
            try {
                for (const name of names) {
                    await this.options.rememberPromptDismissal(name);
                }
            } catch {
                await respond('decline');
                return;
            }
        }
        const accepted = choice === 'install' && this.running && this.options.isEnabled();
        await respond(accepted ? 'approve' : 'decline');
    }
}
