import { extensionContext } from '../../extension';
import { getCurrentWorkspaceFolder } from '../../util';


export class RExecutablePathStorage {
    private store: Map<string, string>;

    constructor() {
        this.store = this.getExecutableStore();
    }

    public get executablePaths(): Map<string, string> {
        return this.store;
    }

    public setExecutablePath(workingDir: string, binPath: string | undefined): void {
        if (binPath) {
            this.store.set(workingDir, binPath);
        } else {
            this.store.delete(workingDir);
        }
        void this.saveStorage();
    }

    public getActiveExecutablePath(): string | undefined {
        return this.store.get(getCurrentWorkspaceFolder().uri.fsPath);
    }

    public getExecutablePath(workingDir: string): string | undefined {
        return this.store.get(workingDir);
    }

    private getExecutableStore(): Map<string, string> {
        return this.stringToMap(extensionContext.globalState.get('rExecMap', ''));
    }

    private async saveStorage(): Promise<void> {
        const out = this.mapToString(this.store);
        await extensionContext.globalState.update('rExecMap', out);
    }

    private mapToString(map: Map<string, string>): string {
        try {
            return JSON.stringify([...map]);
        } catch (error) {
            return '';
        }
    }

    private stringToMap(str: string): Map<string, string> {
        try {
            return new Map(JSON.parse(str));
        } catch (error) {
            return new Map<string, string>();
        }
    }
}