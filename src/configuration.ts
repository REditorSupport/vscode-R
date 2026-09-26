export interface ConfigurationReader<T> {
    get: (key: string) => T | undefined;
    inspect?: (key: string) => {
        workspaceFolderValue?: T;
        workspaceValue?: T;
        globalValue?: T;
    } | undefined;
}

// Resolve renamed settings by scope, preserving the winning key for diagnostics.
export function getMigratedSetting<T>(
    configuration: ConfigurationReader<T>,
    canonicalKey: string,
    legacyKey: string,
    isConfigured: (value: T) => boolean = () => true
): { key: string; value: T } | undefined {
    const canonical = configuration.inspect?.(canonicalKey);
    const legacy = configuration.inspect?.(legacyKey);
    const candidates: Array<[string, T | undefined]> = [];
    for (const scope of ['workspaceFolderValue', 'workspaceValue', 'globalValue'] as const) {
        candidates.push([canonicalKey, canonical?.[scope]], [legacyKey, legacy?.[scope]]);
    }
    candidates.push(
        [canonicalKey, configuration.get(canonicalKey)],
        [legacyKey, configuration.get(legacyKey)]
    );
    for (const [key, value] of candidates) {
        if (value !== undefined && isConfigured(value)) {
            return { key, value };
        }
    }
    return undefined;
}
