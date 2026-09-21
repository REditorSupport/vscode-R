import * as vscode from 'vscode';

export const rDebuggerCompatibilityWarningKey = 'rDebuggerLegacyRPathCompatibilityWarning.v1';

const legacyRPathSettings = [
    'r.rpath.windows',
    'r.rpath.mac',
    'r.rpath.linux',
];

const warningMessage = 'R Debugger still registers the legacy `r.rpath.<platform>` setting. Until it is updated, keep that setting and keep it in sync with `r.executablePath` so both extensions use the same R installation.';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registersLegacyRPathSetting(packageJSON: unknown): boolean {
    if (!isRecord(packageJSON) || !isRecord(packageJSON.contributes)) {
        return false;
    }

    const configuration = packageJSON.contributes.configuration;
    const entries = Array.isArray(configuration) ? configuration : [configuration];
    return entries.some(entry => {
        const properties = isRecord(entry) ? entry.properties : undefined;
        return isRecord(properties) && legacyRPathSettings.some(setting =>
            Object.prototype.hasOwnProperty.call(properties, setting)
        );
    });
}

export async function showRDebuggerCompatibilityWarningOnce(
    globalState: vscode.Memento,
    packageJSON: unknown,
    showWarning: (message: string) => unknown
): Promise<boolean> {
    if (!registersLegacyRPathSetting(packageJSON) || globalState.get<boolean>(rDebuggerCompatibilityWarningKey)) {
        return false;
    }

    await globalState.update(rDebuggerCompatibilityWarningKey, true);
    void showWarning(warningMessage);
    return true;
}
