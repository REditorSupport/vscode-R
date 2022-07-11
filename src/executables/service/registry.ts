import { ExecutableType } from './class';

// necessary to have an executable registry
// so that we don't spam the (re)creation of executables
export class RExecutableRegistry {
    private readonly _executables: Set<ExecutableType>;

    constructor() {
        this._executables = new Set<ExecutableType>();
    }

    public get executables(): Set<ExecutableType> {
        return this._executables;
    }

    public addExecutable(executable: ExecutableType): Set<ExecutableType> {
        return this._executables.add(executable);
    }

    public deleteExecutable(executable: ExecutableType): boolean {
        return this._executables.delete(executable);
    }

    public hasExecutable(executable: ExecutableType): boolean {
        return this._executables.has(executable);
    }

    public getExecutablesWithVersion(version: string): ExecutableType[] {
        return [...this._executables.values()].filter((v) => v.rVersion === version);
    }
}
