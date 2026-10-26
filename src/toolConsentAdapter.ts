import * as vscode from 'vscode';
import {
    ToolConsentChoice,
    ToolConsentRequest,
    ToolConsentService,
    ToolConsentSessionState,
} from './toolConsent';
import { isToolPackageName, TOOL_MINIMUM_VERSIONS, ToolPackageName } from './toolVersions';

// One global-state key per package, for example jgdInstallPromptDismissedMinimumVersion.
function dismissedMinimumVersionKey(packageName: string): string {
    return `${packageName}InstallPromptDismissedMinimumVersion`;
}
// Shared by services in this extension host; a new host starts with a fresh state.
const hostSessionState: ToolConsentSessionState = { promptedPackages: new Set() };

const OPTIONAL_NOTICES: Record<ToolPackageName, string> = {
    jgd: 'Automatic plot backend setup is optional; declining uses the available fallback.',
    rstudioapi: 'RStudio API emulation is optional; declining skips installing rstudioapi.',
};

function optionalNotice(request: ToolConsentRequest): string {
    if (request.policy !== 'once') {
        return '';
    }
    const notices = request.packages.flatMap((item) =>
        isToolPackageName(item.name) ? [OPTIONAL_NOTICES[item.name]] : [],
    );
    return notices.length > 0 ? `\n\n${notices.join(' ')}` : '';
}

function formatPlan(request: ToolConsentRequest): string {
    const [platform, version] = request.runtime.split('|');
    const rows = request.packages.map(
        (item) =>
            `• ${item.name} ${item.version} (${item.packageType === 'source' ? 'source' : 'binary'}; minimum ${item.minimumVersion})\n  Repository: ${item.repository}`,
    );
    const buildNotice = request.packages.some((item) => item.sourceBuild)
        ? '\n\nA source build may be required and may need system build tools.'
        : '';
    return `Install these R packages for R ${version} (${platform})?\n\n${rows.join('\n')}${buildNotice}${optionalNotice(request)}\n\nPackages are installed in a vscode-R-managed library. Existing user and project libraries are not changed.`;
}

export function createToolConsentService(
    directory: string,
    isEnabled: () => boolean,
    globalState: vscode.Memento,
    intervalMs?: number,
): ToolConsentService {
    return new ToolConsentService({
        directory,
        isEnabled,
        isPromptEnabled: (packageName) =>
            isToolPackageName(packageName) &&
            globalState.get<unknown>(dismissedMinimumVersionKey(packageName)) !==
                TOOL_MINIMUM_VERSIONS[packageName],
        sessionState: hostSessionState,
        rememberPromptDismissal: async (packageName) => {
            if (!isToolPackageName(packageName)) {
                throw new Error(`Unknown managed tool package: ${packageName}`);
            }
            await globalState.update(
                dismissedMinimumVersionKey(packageName),
                TOOL_MINIMUM_VERSIONS[packageName],
            );
        },
        intervalMs,
        prompt: async (request): Promise<ToolConsentChoice> => {
            const install = 'Install package';
            const notNow = 'Not now';
            const dontAskAgain = "Don't ask again";
            const choice =
                request.policy === 'once'
                    ? await vscode.window.showWarningMessage(
                          formatPlan(request),
                          install,
                          notNow,
                          dontAskAgain,
                      )
                    : await vscode.window.showWarningMessage(formatPlan(request), install, notNow);
            if (choice === install) {
                return 'install';
            }
            if (choice === notNow) {
                return 'notNow';
            }
            if (choice === dontAskAgain) {
                return 'dontAskAgain';
            }
            return 'dismiss';
        },
    });
}
