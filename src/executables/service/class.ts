import { getRDetailsFromPath } from './locator';
import { RExecutableRegistry } from './registry';

export type ExecutableType = RExecutable;
export type VirtualExecutableType = VirtualRExecutable;

export function isVirtual(executable: RExecutable): executable is VirtualRExecutable {
    return executable instanceof VirtualRExecutable;
}

export class RExecutableFactory {
    private readonly registry: RExecutableRegistry;

    constructor(registry: RExecutableRegistry) {
        this.registry = registry;
    }

    public create(executablePath: string): ExecutableType {
        const oldExec = [...this.registry.executables.values()].find((v) => v.rBin === executablePath);
        if (oldExec) {
            return oldExec;
        } else {
            let executable: RExecutable;
            if (new RegExp('\\.conda').exec(executablePath)?.length > 0) {
                executable = new VirtualRExecutable(executablePath);
            } else {
                executable = new RExecutable(executablePath);
            }
            this.registry.addExecutable(executable);
            return executable;
        }
    }
}

class RExecutable {
    private _rBin: string;
    private _rVersion: string;
    private _arch: string;

    constructor(bin_path: string) {
        const details = getRDetailsFromPath(bin_path);
        this._rBin = bin_path;
        this._rVersion = details.version;
        this._arch = details.arch;
    }

    public get rBin(): string {
        return this._rBin;
    }

    public get rVersion(): string {
        return this._rVersion;
    }

    public get rArch(): string {
        return this._arch;
    }

    public get tooltip(): string {
        const versionString = this.rVersion ? ` ${this.rVersion}` : '';
        const archString = this.rArch ? ` ${this.rArch}` : '';
        return `R${versionString}${archString}`;
    }
}

class VirtualRExecutable extends RExecutable {
    constructor(bin_path: string) {
        super(bin_path);
    }

    public get name(): string {
        const reg = new RegExp('(?<=\\/envs\\/)(.*?)(?=\\/)');
        return reg.exec(this.rBin)[0];
    }

    public get tooltip(): string {
        return `${this.name} (${super.tooltip})`;
    }

    // todo, hardcoded
    public get activationCommand(): string[] {
        return ['activate', this.name];
    }
}
