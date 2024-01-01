'use strict';

import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as winreg from 'winreg';
import { getUniquePaths, AbstractLocatorService } from './shared';


const WindowsKnownPaths: string[] = [];

if (process.env.ProgramFiles) {
    WindowsKnownPaths.push(
        path.join(process?.env?.ProgramFiles, 'R'),
        path.join(process?.env?.ProgramFiles, 'Microsoft', 'R Open')
    );
}

if (process.env['ProgramFiles(x86)']) {
    WindowsKnownPaths.push(
        path.join(process?.env?.['ProgramFiles(x86)'], 'R'),
        path.join(process?.env?.['ProgramFiles(x86)'], 'Microsoft', 'R Open')
    );
}


export class WindowsExecLocator extends AbstractLocatorService {
    constructor() {
        super();
        this.emitter = new vscode.EventEmitter<string[]>();
        this._executablePaths = [];
    }
    public async refreshPaths(): Promise<void> {
        this._executablePaths = getUniquePaths(Array.from(
            new Set([
                ...this.getPathFromDirs(),
                ...this.getPathFromEnv(),
                ...await this.getPathFromRegistry(),
                ...this.getPathFromConda()
            ])
        ));
        this.emitter.fire(this._executablePaths);
    }

    private async getPathFromRegistry(): Promise<string[]> {
        const execPaths: string[] = [];
        const potentialRegs = [
            new winreg({
                hive: winreg.HKLM,
                key: '\\SOFTWARE\\R-core\\R',
            }),
            new winreg({
                hive: winreg.HKLM,
                key: '\\SOFTWARE\\R-core\\R64',
            })
        ];

        for (const reg of potentialRegs) {
            const res: unknown = await new Promise((resolve, reject) => {
                reg.get('InstallPath', (err, result) => err === null ? resolve(result) : reject(err));
            });

            if (res) {
                const resolvedPath = (res as winreg.RegistryItem).value;
                const i386 = `${resolvedPath}\\i386\\`;
                const x64 = `${resolvedPath}\\x64\\`;

                if (fs.existsSync(i386)) {
                    execPaths.push(i386);
                }

                if (fs.existsSync(x64)) {
                    execPaths.push(x64);
                }
            }
        }

        return execPaths;
    }

    private getPathFromDirs(): string[] {
        const execPaths: string[] = [];
        for (const rPath of WindowsKnownPaths) {
            if (fs.existsSync(rPath)) {
                const dirs = fs.readdirSync(rPath);
                for (const dir of dirs) {
                    const i386 = `${rPath}\\${dir}\\bin\\i386\\R.exe`;
                    const x64 = `${rPath}\\${dir}\\bin\\x64\\R.exe`;

                    if (fs.existsSync(i386)) {
                        execPaths.push(i386);
                    }

                    if (fs.existsSync(x64)) {
                        execPaths.push(x64);
                    }
                }
            }
        }
        return execPaths;
    }

    private getPathFromEnv(): string[] {
        const execPaths: string[] = [];
        const osPaths: string[] | string | undefined = process?.env?.PATH?.split(';');

        if (osPaths) {
            for (const osPath of osPaths) {
                const rPath: string = path.join(osPath, '\\R.exe');
                if (fs.existsSync(rPath)) {
                    execPaths.push(rPath);
                }
            }
        }

        return execPaths;
    }

    private getPathFromConda() {
        const execPaths: string[] = [];
        const condaDirs = [
            `${os.homedir()}\\.conda\\environments.txt`
        ];
        for (const rPath of condaDirs) {
            if (fs.existsSync(rPath)) {
                const lines = fs.readFileSync(rPath)?.toString();
                if (lines) {
                    for (const line of lines.split('\r\n')) {
                        if (line) {
                            const potentialDirs = [
                                `${line}\\lib64\\R\\bin\\R.exe`,
                                `${line}\\lib\\R\\bin\\R.exe`
                            ];
                            for (const dir of potentialDirs) {
                                if (fs.existsSync(dir)) {
                                    execPaths.push(dir);
                                }
                            }
                        }
                    }
                }
            }
        }
        return execPaths;
    }
}