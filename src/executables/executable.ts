import { getVersionFromPath, getArchitectureFromPath } from './locator';

export class RExecutableFactory {
    static createExecutable(executablePath: string): RExecutable {
        if (new RegExp('\\.conda').exec(executablePath)?.length > 0) {
            return new VirtualRExecutable(executablePath);
        } else {
            return new RExecutable(executablePath);
        }
    }

    private constructor() {
        //
    }
}

export class RExecutable {
    private _rBin: string;
    private _rVersion: string;
    private _arch: string;

    constructor(bin_path: string) {
        this._rBin = bin_path;
        this._rVersion = getVersionFromPath(bin_path);
        this._arch = getArchitectureFromPath(bin_path);
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
        return `R ${this.rVersion} ${this.rArch}`;
    }
}

export class VirtualRExecutable extends RExecutable {
    constructor(bin_path: string) {
        super(bin_path);
    }

    public get name(): string {
        const reg = new RegExp('(?<=\\/envs\\/)(.*?)(?=\\/)');
        return reg.exec(this.rBin)[0];
    }

    public get tooltip(): string {
        return `${this.name} (R ${this.rVersion} ${this.rArch})`;
    }

    // todo, hardcoded
    public get activationCommand(): string[] {
        return ['activate', this.name];
    }
}
