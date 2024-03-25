import * as fs from 'fs-extra';
import * as path from 'path';
import { IExecutableDetails, RExecutableType } from '../service';
import { CondaVirtualRExecutable } from '../service/class';

export function isCondaInstallation(executablePath: string): boolean {
    return fs.existsSync(condaMetaDirPath(executablePath));
}

export function isCondaExecutable(executable: RExecutableType) {
    return executable instanceof CondaVirtualRExecutable;
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


