'use strict';

// TODO fix imports

import { getRDetailsFromPath } from '../util';
import { RExecutableRegistry } from './registry';
import { RExecutableType } from './types';
import {
    isCondaInstallation, isMambaInstallation
} from '../virtual';
import { condaName, getRDetailsFromCondaMetaHistory } from '../virtual/conda';

/**
 * Creates and caches instances of RExecutableType
 * based on the provided executable path.
 */
export class RExecutableFactory {
    private readonly registry: RExecutableRegistry;

    constructor (registry: RExecutableRegistry) {
        this.registry = registry;
    }

    public create(executablePath: string): RExecutableType {
        const cachedExec = [...this.registry.executables.values()].find((v) => v.rBin === executablePath);
        if (cachedExec) {
            return cachedExec;
        } else {
            let executable: AbstractRExecutable;
            if (isCondaInstallation(executablePath)) {
                executable = new CondaVirtualRExecutable(executablePath);
            } else if (isMambaInstallation(executablePath)) {
                executable = new MambaVirtualRExecutable(executablePath);
            } else {
                executable = new RExecutable(executablePath);
            }
            this.registry.addExecutable(executable);
            return executable;
        }
    }
}

export abstract class AbstractRExecutable {
    protected _rBin!: string;
    protected _rVersion!: string;
    protected _rArch!: string;
    public get rBin(): string {
        return this._rBin;
    }

    public get rVersion(): string {
        return this._rVersion;
    }

    public get rArch(): string {
        return this._rArch;
    }
    public abstract tooltip: string;
}


export class RExecutable extends AbstractRExecutable {
    constructor (executablePath: string) {
        super();
        const details = getRDetailsFromPath(executablePath);
        this._rBin = executablePath;
        this._rVersion = details.version;
        this._rArch = details.arch;
    }

    public get tooltip(): string {
        if (this.rVersion && this.rArch) {
            return `R ${this.rVersion} ${this.rArch}`;
        }
        return `$(error) R`;
    }
}

export abstract class AbstractVirtualRExecutable extends AbstractRExecutable {
    protected _name!: string;
    public get name(): string {
        return this._name;
    }
    public get tooltip(): string {
        if (this.rVersion && this.rArch) {
            return `R ${this.rVersion} ${this.rArch} ('${this.name}')`;
        }
        return `$(error) '${this.name}'`;
    }
}

export class CondaVirtualRExecutable extends AbstractVirtualRExecutable {
    constructor (executablePath: string) {
        super();
        this._name = condaName(executablePath);
        const details = getRDetailsFromCondaMetaHistory(executablePath);
        this._rVersion = details?.version ?? '';
        this._rArch = details?.arch ?? '';
        this._rBin = executablePath;
    }
}

// TODO

export class MambaVirtualRExecutable extends AbstractVirtualRExecutable {
    constructor (executablePath: string) {
        super();
    }
}

