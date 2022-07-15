import { getCondaName, getRDetailsFromMetaHistory, isCondaInstallation } from '../conda';
import { getRDetailsFromPath } from './locator';
import { RExecutableRegistry } from './registry';
import { IExecutableDetails, ExecutableType } from './types';

export function isVirtual(executable: AbstractExecutable): executable is VirtualRExecutable {
    return executable instanceof VirtualRExecutable;
}

export class RExecutableFactory {
    private readonly registry: RExecutableRegistry;

    constructor(registry: RExecutableRegistry) {
        this.registry = registry;
    }

    public create(executablePath: string): ExecutableType {
        const cachedExec = [...this.registry.executables.values()].find((v) => v.rBin === executablePath);
        if (cachedExec) {
            return cachedExec;
        } else {
            let executable: AbstractExecutable;
            if (isCondaInstallation(executablePath)) {
                executable = new VirtualRExecutable(executablePath);
            } else {
                executable = new RExecutable(executablePath);
            }
            this.registry.addExecutable(executable);
            return executable;
        }
    }
}

export abstract class AbstractExecutable {
    protected _rBin: string;
    protected _rVersion: string;
    protected _rArch: string;
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


export class RExecutable extends AbstractExecutable {
    constructor(executablePath: string) {
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

    protected getDetailsFromPath(execPath: string): IExecutableDetails {
        return getRDetailsFromPath(execPath);
    }
}

export class VirtualRExecutable extends AbstractExecutable {
    private _name: string;

    constructor(executablePath: string) {
        super();
        this._name = getCondaName(executablePath);
        const details = getRDetailsFromMetaHistory(executablePath);
        this._rBin = executablePath;
        this._rVersion = details?.version ?? '';
        this._rArch = details?.arch ?? '';
    }

    public get name(): string {
        return this._name;
    }

    public get tooltip(): string {
        if (this.rVersion && this.rArch) {
            return `${this.name} (R ${this.rVersion} ${this.rArch})`;
        }
        return `$(error) ${this.name}`;
    }
}
