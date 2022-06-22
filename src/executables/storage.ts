import { extensionContext } from '../extension';

/**
 * Executables are stored as a map of working directories and bin paths
 */
export function getExecutableStore(): Map<string, string> {
    return stringToMap(extensionContext.globalState.get('rExecMap', ''));
}

export function getExecutable(workingDir: string): string {
    const store: Map<string, string> = getExecutableStore();
    return store.get(workingDir);
}

export function storeExecutable(binPath: string, workingDir: string): void {
    const currentStore: Map<string, string> = getExecutableStore();
    currentStore.set(workingDir, binPath);
    void extensionContext.globalState.update('rExecMap', mapToString(currentStore));
}

export function clearExecutable(workingDir: string): boolean {
    const currentStore: Map<string, string> = getExecutableStore();
    return currentStore.delete(workingDir);
}

function mapToString(map: Map<string, string>): string {
    return JSON.stringify([...map]);
}

function stringToMap(str: string): Map<string, string> {
    try {
        return new Map(JSON.parse(str));
    } catch (error) {
        return new Map<string, string>();
    }
}