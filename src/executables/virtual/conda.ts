
import { IExecutableDetails, VirtualExecutableType } from '../service';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import path = require('path');
import { exec } from 'child_process';
import { rExecService, tmpDir } from '../../extension';

export function environmentIsActive(name: string): boolean {
    return process.env.CONDA_DEFAULT_ENV === name ||
    process.env.CONDA_PREFIX === name;
}

export function getCondaName(executablePath: string): string {
    return path.basename(path.dirname(getCondaMetaDir(executablePath)));
}

export function getCondaMetaDir(executablePath: string): string {
    let envDir: string = executablePath;
    for (let index = 0; index < 4; index++) {
        envDir = path.dirname(envDir);
    }
    return path.join(envDir, 'conda-meta');
}

export function getCondaHistoryPath(executablePath: string): string {
    return path.join(getCondaMetaDir(executablePath), 'history');
}

export function getCondaActivationScript(executablePath: string): string {
    const envDir = path.dirname(getCondaMetaDir(executablePath));
    return path.join(path.dirname(path.dirname(envDir)), 'Scripts', 'activate');
}

export function isCondaInstallation(executablePath: string): boolean {
    return fs.existsSync(getCondaMetaDir(executablePath));
}

export function getRDetailsFromMetaHistory(executablePath: string): IExecutableDetails {
    try {

        const reg = new RegExp(/([0-9]{2})::r-base-([0-9.]*)/g);
        const historyContent = fs.readFileSync(getCondaHistoryPath(executablePath))?.toString();
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

export function getActivationString(executablePath: string): string | undefined {
    const activationPath = getCondaActivationScript(executablePath);
    const commands = [
        activationPath,
        `conda activate ${getCondaName(executablePath)}`
    ].join(' & ');
    return commands;
}

export function activateCondaEnvironment(executable: VirtualExecutableType): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            let command: string;
            // need to fake activating conda environment by adding its env vars to the relevant R processes
            if (process.platform === 'win32') {
                // this assumes no powershell usage
                // todo! need to check env saving for windows
                command = [
                    getCondaActivationScript(executable.rBin),
                    `conda activate ${executable.name}`,
                    `echo $PATH | awk -F':' '{ print $1}' > ${tmpDir()}/${executable.name}Env.txt`
                ].join(' && ');
            } else {
                const unixCondaScript = path.join('/', 'etc', 'profile.d', 'conda.sh');
                command = [
                    `source ${unixCondaScript}`,
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

function readCondaBinFile(executable: VirtualExecutableType) {
    return fs.readFileSync(`${tmpDir()}/${executable.name}Env.txt`).toString().trim();
}
