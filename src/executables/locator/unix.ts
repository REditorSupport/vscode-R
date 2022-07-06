import * as fs from 'fs-extra';
import * as os from 'os';
import path = require('path');
import { RExecutable, RExecutableFactory } from '../executable';

import { AbstractLocatorService } from './shared';

export class UnixExecLocator extends AbstractLocatorService {
    constructor() {
        super();
        this._binaryPaths = [];
        this._executables = [];
    }
    public get hasExecutables(): boolean {
        return this._executables.length > 0;
    }
    public get executables(): RExecutable[] {
        return this._executables;
    }
    public get binaryPaths(): string[] {
        return this._binaryPaths;
    }
    public refreshPaths(): void {
        const paths = Array.from(
            new Set([
                ...this.getHomeFromDirs(),
                ...this.getHomeFromEnv(),
                ... this.getHomeFromConda()
            ])
        );
        for (const path of paths) {
            if (!this._binaryPaths?.includes(path)) {
                this._binaryPaths.push(path);
                this._executables.push(RExecutableFactory.createExecutable(path));
            }
        }
    }

    private getHomeFromDirs(): string[] {
        const dirBins: string[] = [];
        const potentialPaths: string[] = [
            '/usr/lib64/R/bin/R',
            '/usr/lib/R/bin/R',
            '/usr/local/lib64/R/bin/R',
            '/usr/local/lib/R/bin/R',
            '/opt/local/lib64/R/bin/R',
            '/opt/local/lib/R/bin/R'
        ];

        for (const bin of potentialPaths) {
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
