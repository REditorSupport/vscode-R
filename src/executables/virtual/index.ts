import { isCondaExecutable } from './conda';
import { CondaVirtualRExecutable } from '../service/class';
import { isMambaExecutable } from './mamba';
import { MambaVirtualRExecutable } from '../service/class';
import { rExecutableManager } from '../../extension';
import { getRterm } from '../../util';
import { AbstractRExecutable, AbstractVirtualRExecutable , RExecutableType } from '../service';

export * from './conda';
export * from './mamba';
export * from './renv';

export function isVirtual(executable: AbstractRExecutable): executable is AbstractVirtualRExecutable {
    return executable instanceof AbstractVirtualRExecutable;
}

export interface IProcessArgs {
    cmd: string;
    args?: string[];
}

function virtualAwareArgs(
    executable: CondaVirtualRExecutable | MambaVirtualRExecutable,
    interactive: boolean,
    shellArgs: string[] | ReadonlyArray<string>): IProcessArgs {
    const rpath = interactive ? getRterm() : executable.rBin;
    const cmd: 'conda' | 'mamba' = isCondaExecutable(executable) ? 'conda' :
        isMambaExecutable(executable) ? 'mamba' :
            (() => { throw 'Unknown virtual executable'; })();

    if (!rpath) {
        throw 'Bad R executable path';
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

export function setupVirtualAwareProcessArguments(executable: string, interactive: boolean, args?: ReadonlyArray<string>): IProcessArgs;
export function setupVirtualAwareProcessArguments(executable: RExecutableType, interactive: boolean, args?: ReadonlyArray<string>): IProcessArgs;
export function setupVirtualAwareProcessArguments(executable: RExecutableType | string, interactive: boolean, args?: ReadonlyArray<string>): IProcessArgs {
    const rexecutable = typeof executable === 'string' ? rExecutableManager?.getExecutableFromPath(executable) : executable;
    if (!rexecutable) {
        throw 'Bad R executable path';
    }
    if (isVirtual(rexecutable)) {
        const virtualArgs = virtualAwareArgs(rexecutable, interactive, args ?? []);
        return { cmd: virtualArgs.cmd, args: virtualArgs.args };
    } else {
        return { cmd: rexecutable.rBin, args: args?.concat() ?? [] };
    }
}
