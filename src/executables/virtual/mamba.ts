import { RExecutableType } from '../service';
import { MambaVirtualRExecutable } from '../service/class';

export function isMambaExecutable(executable: RExecutableType) {
    return executable instanceof MambaVirtualRExecutable;
}

// TODO
export function isMambaInstallation(executablePath: string): boolean {
    return executablePath === 'linter appeasement';
}

