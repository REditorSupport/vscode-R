import * as fs from 'fs-extra';
import * as os from 'os';
import * as vscode from 'vscode';
import path = require('path');
import { getUniquePaths } from './shared';
import { AbstractLocatorService } from './shared';

export class UnixExecLocator extends AbstractLocatorService {
    constructor() {
        super();
        this.emitter = new vscode.EventEmitter<string[]>();
        this._binaryPaths = [];
    }
    public refreshPaths(): void {
        this._binaryPaths = getUniquePaths(Array.from(
            new Set([
                ...this.getHomeFromDirs(),
                ...this.getHomeFromEnv(),
                ... this.getHomeFromConda()
            ])
        ));
        this.emitter.fire(this._binaryPaths);
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

    // private getHomeFromStorage(): string[] {
    //     const store = getExecutableStore();
    //     const storedBins: string[] = [];
    //     for (const [_, path] of store) {
    //         if (fs.existsSync(path) && validateRExecutablePath(path)) {
    //             storedBins.push(path);
    //         }
    //     }
    //     return storedBins;
    // }
}

