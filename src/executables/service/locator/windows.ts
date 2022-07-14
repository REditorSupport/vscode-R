import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import path = require('path');
import winreg = require('winreg');
import { getUniquePaths, AbstractLocatorService } from './shared';
import { validateRExecutablePath } from '../..';

const WindowsKnownPaths = [
    path.join(process.env.ProgramFiles, 'R'),
    path.join(process.env['ProgramFiles(x86)'], 'R'),
    path.join(process.env.ProgramFiles, 'Microsoft', 'R Open'),
    path.join(process.env.ProgramFiles, 'Microsoft', 'R Open'),
];


export class WindowsExecLocator extends AbstractLocatorService {
    constructor() {
        super();
        this.emitter = new vscode.EventEmitter<string[]>();
        this._binaryPaths = [];
    }
    public async refreshPaths(): Promise<void> {
        this._binaryPaths = getUniquePaths(Array.from(
            new Set([
                ...this.getHomeFromDirs(),
                ...this.getHomeFromEnv(),
                ...await this.getHomeFromRegistry(),
                // ... this.getHomeFromConda()
            ])
        ));
        this.emitter.fire(this._binaryPaths);
    }

    private async getHomeFromRegistry(): Promise<string[]> {
        const registryBins: string[] = [];
        const potentialBins = [
            new winreg({
                hive: winreg.HKLM,
                key: '\\SOFTWARE\\R-core\\R',
            }),
            new winreg({
                hive: winreg.HKLM,
                key: '\\SOFTWARE\\R-core\\R64',
            })
        ];

        for (const bin of potentialBins) {
            await new Promise(
                (c, e) => {
                    bin.get('InstallPath', (err, result) => err === null ? c(result) : e(err));
                }
            ).then((item: winreg.RegistryItem) => {
                if (item) {
                    const resolvedBin = item.value;
                    const i386 = `${resolvedBin}\\i386\\`;
                    const x64 = `${resolvedBin}\\x64\\`;

                    if (fs.existsSync(i386)) {
                        registryBins.push(i386);
                    }

                    if (fs.existsSync(x64)) {
                        registryBins.push(x64);
                    }
                }
            });
        }

        return registryBins;
    }

    private getHomeFromDirs(): string[] {
        const dirBins: string[] = [];
        for (const bin of WindowsKnownPaths) {
            if (fs.existsSync(bin)) {
                const dirs = fs.readdirSync(bin);
                for (const dir of dirs) {
                    const i386 = `${bin}\\${dir}\\bin\\i386\\R.exe`;
                    const x64 = `${bin}\\${dir}\\bin\\x64\\R.exe`;
                    if (validateRExecutablePath(i386)) {
                        dirBins.push(i386);
                    }

                    if (validateRExecutablePath(x64)) {
                        dirBins.push(x64);
                    }
                }
            }
        }
        return dirBins;
    }

    private getHomeFromEnv(): string[] {
        const envBins: string[] = [];
        const os_paths: string[] | string | undefined = process?.env?.PATH?.split(';');

        if (os_paths) {
            for (const os_path of os_paths) {
                const os_r_path: string = path.join(os_path, '/R.exe');
                if (fs.existsSync(os_r_path)) {
                    envBins.push(os_r_path);
                }
            }
        }

        return envBins;
    }

    // todo
    // private getHomeFromConda() {}
}
