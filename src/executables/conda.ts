
import { IExecutableDetails } from './service';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import path = require('path');
import { spawn } from 'child_process';

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
    console.log(getCondaName(executablePath));
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

export function activateCondaEnvironment(executablePath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        try {
            const opts = {
                env: process.env,
                shell: true
            };
            const activationPath = (getCondaActivationScript(executablePath));
            const commands = [
                activationPath,
                `conda activate ${getCondaName(executablePath)}`
            ].join(' & ');
            const childProc = spawn(
                commands,
                undefined,
                opts
            );
            childProc.on('exit', () => resolve(true));
            childProc.on('error', (err) => {
                void vscode.window.showErrorMessage(`Error when activating conda environment: ${err.message}`);
                reject(false);
            });
        } catch (error) {
            void vscode.window.showErrorMessage(`Error when activating conda environment: ${error as string}`);
            reject(false);
        }
    });
}