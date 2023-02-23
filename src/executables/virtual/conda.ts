
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import path = require('path');
import { IExecutableDetails, VirtualRExecutableType } from '../service';
import { exec } from 'child_process';
import { tmpDir } from '../../extension';
import { config } from '../../util';

// Misc

export function condaName(executablePath: string): string {
    return path.basename(condaPrefixPath(executablePath));
}

// Path functions

export function condaPrefixPath(executablePath: string): string {
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

function condaActivationPath(executablePath: string): string {
    const condaPathConfig = config().get<string>('virtual.condaPath');
    if (condaPathConfig) {
        return condaPathConfig;
    } else if (process.platform === 'win32') {
        const envDir = path.dirname(condaMetaDirPath(executablePath));
        return path.join(path.dirname(path.dirname(envDir)), 'Scripts', 'activate');
    } else {
        return path.join('/', 'usr', 'bin', 'activate');
    }
}

// Bools

export function environmentIsActive(executablePath: string): boolean {
    return process.env.CONDA_DEFAULT_ENV === condaName(executablePath) ||
    process.env.CONDA_PREFIX === condaPrefixPath(executablePath);
}

export function isCondaInstallation(executablePath: string): boolean {
    return fs.existsSync(condaMetaDirPath(executablePath));
}

// Extension

export function getRDetailsFromMetaHistory(executablePath: string): IExecutableDetails {
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

export function activateCondaEnvironment(executable: VirtualRExecutableType): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            let command: string;
            // need to fake activating conda environment by adding its env vars to the relevant R processes
            const activationPath = condaActivationPath(executable.rBin);

            if (process.platform === 'win32') {
                // this assumes no powershell usage
                // todo! need to check env saving for windows
                command = [
                    activationPath,
                    `conda activate ${executable.name}`,
                    `echo $PATH | awk -F':' '{ print $1}' > ${tmpDir()}/${executable.name}Env.txt`
                ].join(' && ');
            } else {
                command = [
                    `source ${activationPath}`,
                    `conda activate ${executable.name}`,
                    `echo $PATH | awk -F':' '{ print $1}' > ${tmpDir()}/${executable.name}Env.txt`
                ].join(' &&');
            }
            const childProc = exec(command);

            childProc.on('error', (err) => {
                void vscode.window.showErrorMessage(`Error when activating conda environment: ${err.message}`);
                reject();
            });
            childProc.on('exit', () => {
                executable.envVar = readCondaBinFile(executable);
                resolve();
            });
        } catch (error) {
            void vscode.window.showErrorMessage(`Error when activating conda environment: ${error as string}`);
            reject();
        }
    });
}

function readCondaBinFile(executable: VirtualRExecutableType) {
    return fs.readFileSync(`${tmpDir()}/${executable.name}Env.txt`).toString().trim();
}
