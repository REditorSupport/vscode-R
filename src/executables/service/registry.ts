'use strict';

import { RExecutableType } from './types';

// necessary to have an executable registry
// so that we don't spam the (re)creation of executables
export class RExecutableRegistry {
    private readonly _executables: Set<RExecutableType>;

    constructor() {
        this._executables = new Set<RExecutableType>();
    }

    public get executables(): Set<RExecutableType> {
        return this._executables;
    }

    public addExecutable(executable: RExecutableType): Set<RExecutableType> {
        return this._executables.add(executable);
    }

    public deleteExecutable(executable: RExecutableType): boolean {
        return this._executables.delete(executable);
    }

    public hasExecutable(executable: RExecutableType): boolean {
        return this._executables.has(executable);
    }

    public getExecutablesWithVersion(version: string): RExecutableType[] {
        return [...this._executables.values()].filter((v) => v.rVersion === version);
    }
}