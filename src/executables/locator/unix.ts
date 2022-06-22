import * as fs from 'fs-extra';
import * as os from 'os';
import path = require('path');

import { AbstractLocatorService } from './shared';

export class UnixExecLocator extends AbstractLocatorService {
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
                ... this.getHomeFromConda()
            ])
        );
    }

    private potential_bin_paths: string[] = [
        '/usr/lib64/R/bin/R',
        '/usr/lib/R/bin/R',
        '/usr/local/lib64/R/bin/R',
        '/usr/local/lib/R/bin/R',
        '/opt/local/lib64/R/bin/R',
        '/opt/local/lib/R/bin/R'
    ];

    private getHomeFromDirs(): string[] {
        const dirBins: string[] = [];
        for (const bin of this.potential_bin_paths) {
            if (fs.existsSync(bin)) {
                dirBins.push(bin);
            }
        }
        return dirBins;
    }

    private getHomeFromConda(): string[] {
        const dirBins: string[] = [];
        const conda_dirs = [
            `${os.homedir()}/.conda/environments.txt`
        ];
        for (const dir of conda_dirs) {
            if (fs.existsSync(dir)) {
                const lines = fs.readFileSync(dir).toString();
                for (const line of lines.split('\n')) {
                    if (line) {
                        const potential_dirs = [
                            `${line}/lib64/R/bin/R`,
                            `${line}/lib/R/bin/R`
                        ];
                        for (const dir of potential_dirs) {
                            if (fs.existsSync(dir)) {
                                dirBins.push(dir);
                            }
                        }
                    }
                }
            }
        }
        return dirBins;
    }

    private getHomeFromEnv(): string[] {
        const envBins: string[] = [];
        const os_paths: string[] | string = process.env.PATH.split(';');

        for (const os_path of os_paths) {
            const os_r_path: string = path.join(os_path, 'R');
            if (fs.existsSync(os_r_path)) {
                envBins.push(os_r_path);
            }
        }
        return envBins;
    }
}
