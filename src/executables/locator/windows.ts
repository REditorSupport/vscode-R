import * as fs from 'fs-extra';
import * as os from 'os';
import path = require('path');
import winreg = require('winreg');

import { AbstractLocatorService } from './shared';

export class WindowsExecLocator extends AbstractLocatorService {
    public get hasBinaries(): boolean {
        return this.binary_paths.length > 0;
    }
    public get binaries(): string[] {
        return this.binary_paths;
    }
    public refreshPaths(): void {
        this.binary_paths = Array.from(
            new Set([
                ...this.getHomeFromDirs(),
                ...this.getHomeFromEnv(),
                ...this.getHomeFromRegistry(),
                // ... this.getHomeFromConda()
            ])
        );
    }

    private potential_bin_paths: string[] = [
        '%ProgramFiles%\\R\\',
        '%ProgramFiles(x86)%\\R\\'
    ];

    private getHomeFromRegistry(): string[] {
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
            void new Promise(
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
        for (const bin of this.potential_bin_paths) {
            const resolvedBin = path.resolve(bin);
            if (fs.existsSync(resolvedBin)) {
                const i386 = `${resolvedBin}\\i386\\`;
                const x64 = `${resolvedBin}\\x64\\`;

                if (fs.existsSync(i386)) {
                    dirBins.push(i386);
                }

                if (fs.existsSync(x64)) {
                    dirBins.push(x64);
                }
            }
        }
        return dirBins;
    }

    private getHomeFromEnv(): string[] {
        const envBins: string[] = [];
        const os_paths: string[] | string = process.env.PATH.split(';');

        for (const os_path of os_paths) {
            const os_r_path: string = path.join(os_path, 'R' + '.exe');
            if (fs.existsSync(os_r_path)) {
                envBins.push(os_r_path);
            }
        }
        return envBins;
    }

    // todo
    // private getHomeFromConda() {}
}
