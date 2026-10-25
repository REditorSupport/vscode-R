import * as vscode from 'vscode';
import {
    ToolConsentChoice,
    ToolConsentRequest,
    ToolConsentService,
    ToolConsentSessionState,
} from './toolConsent';

const AUTO_PROMPT_SETTING = 'plot.jgd.installationPrompt';
// Shared by services in this extension host; a new host starts with a fresh state.
const hostSessionState: ToolConsentSessionState = { autoPrompted: false };

function formatPlan(request: ToolConsentRequest): string {
    const [platform, version] = request.runtime.split('|');
    const rows = request.packages.map(
        (item) => `• ${item.name} ${item.version} (minimum ${item.minimumVersion})\n  Repository: ${item.repository}`,
    );
    const buildNotice = request.packages.some((item) => item.sourceBuild)
        ? '\n\nA source build may be required and may need system build tools.'
        : '';
    const modeNotice = request.backend === 'auto'
        ? '\n\nAutomatic plot backend setup is optional; declining uses the available fallback.'
        : '';
    return `Install these R packages for R ${version} (${platform})?\n\n${rows.join('\n')}${buildNotice}${modeNotice}\n\nPackages are installed in a vscode-R-managed library. Existing user and project libraries are not changed.`;
}

export function createToolConsentService(
    directory: string,
    isEnabled: () => boolean,
    intervalMs?: number,
): ToolConsentService {
    return new ToolConsentService({
        directory,
        isEnabled,
        isAutoPromptEnabled: () =>
            vscode.workspace.getConfiguration('r').get<boolean>(AUTO_PROMPT_SETTING, true),
        sessionState: hostSessionState,
        rememberAutoPromptDismissal: async () => {
            await vscode.workspace.getConfiguration('r').update(
                AUTO_PROMPT_SETTING,
                false,
                vscode.ConfigurationTarget.Global,
            );
        },
        intervalMs,
        prompt: async (request): Promise<ToolConsentChoice> => {
            const install = 'Install package';
            const notNow = 'Not now';
            const dontAskAgain = "Don't ask again";
            const choice = request.backend === 'auto'
                ? await vscode.window.showWarningMessage(formatPlan(request), install, notNow, dontAskAgain)
                : await vscode.window.showWarningMessage(formatPlan(request), install, notNow);
            if (choice === install) return 'install';
            if (choice === notNow) return 'notNow';
            if (choice === dontAskAgain) return 'dontAskAgain';
            return 'dismiss';
        },
    });
}

