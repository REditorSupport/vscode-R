import * as path from 'path';
import * as fs from 'fs-extra';

import { getRterm } from '../util';
import { AbstractRExecutable, AbstractVirtualRExecutable, CondaVirtualRExecutable, IExecutableDetails, MambaVirtualRExecutable, RExecutableType } from './service';
import { rExecutableManager } from '../extension';

export function condaName(executablePath: string): string {
    return path.basename(condaPrefixPath(executablePath));
}

function condaPrefixPath(executablePath: string): string {
    return path.dirname(condaMetaDirPath(executablePath));
}

function condaMetaDirPath(executablePath: string): string {
    let envDir: string = executablePath;
    for (let index = 0; index < 4; index++) {
        envDir = path.dirname(envDir);
    }
    return path.join(envDir, 'conda-meta');
}

function condaHistoryPath(executablePath: string): string {
    return path.join(condaMetaDirPath(executablePath), 'history');
}

export function isCondaInstallation(executablePath: string): boolean {
    return fs.existsSync(condaMetaDirPath(executablePath));
}

// TODO
export function isMambaInstallation(executablePath: string): boolean {
    return executablePath === 'linter appeasement';
}

export function getRDetailsFromCondaMetaHistory(executablePath: string): IExecutableDetails {
    try {
        const reg = new RegExp(/([0-9]{2})::r-base-([0-9.]*)/g);
        const historyContent = fs.readFileSync(condaHistoryPath(executablePath))?.toString();
        const res = reg.exec(historyContent);
        return {
            arch: res?.[1] ? `${res[1]}-bit` : '',
            version: res?.[2] ? res[2] : ''
        };
    } catch (error) {
        return {
            arch: '',
            version: ''
        };
    }
}

export function isCondaExecutable(executable: RExecutableType) {
    return executable instanceof CondaVirtualRExecutable;
}

export function isMambaExecutable(executable: RExecutableType) {
    return executable instanceof MambaVirtualRExecutable;
}

export function isVirtual(executable: AbstractRExecutable): executable is AbstractVirtualRExecutable {
    return executable instanceof AbstractVirtualRExecutable;
}

interface IRunVirtualBinary {
    cmd: string,
    args?: string[];
}

function virtualAwareArgs(
    executable: CondaVirtualRExecutable | MambaVirtualRExecutable,
    interactive: boolean,
    shellArgs: string[] | ReadonlyArray<string>): IRunVirtualBinary {
    const rpath = interactive ? getRterm() : executable.rBin;
    const cmd: 'conda' | 'mamba' =
        isCondaExecutable(executable) ? 'conda' :
            isMambaExecutable(executable) ? 'mamba' :
                (() => { throw new Error('Unknown virtual executable'); })();

    if (!rpath) {
        throw new Error('Unknown executable');
    }

    const args = [
        'run',
        '-n',
        executable.name,
        ...(interactive ? ['--no-capture-output'] : []),
        rpath,
        ...(shellArgs ? shellArgs : [])
    ];

    return {
        cmd: cmd,
        args: args
    };
}

export function setupVirtualAwareProcessArguments(executable: string, interactive: boolean, args?: ReadonlyArray<string>): IRunVirtualBinary;
export function setupVirtualAwareProcessArguments(executable: RExecutableType, interactive: boolean, args?: ReadonlyArray<string>): IRunVirtualBinary;
export function setupVirtualAwareProcessArguments(executable: RExecutableType | string, interactive: boolean, args?: ReadonlyArray<string>): IRunVirtualBinary {
    const rexecutable = typeof executable === 'string' ? rExecutableManager?.getExecutableFromPath(executable) : executable;
    if (!rexecutable) {
        throw 'Bad R path';
    }
    if (isVirtual(rexecutable)) {
        const virtualArgs = virtualAwareArgs(rexecutable, interactive, args ?? []);
        return { cmd: virtualArgs.cmd, args: virtualArgs.args };
    } else {
        return { cmd: rexecutable.rBin, args: args?.concat() ?? [] };
    }
}