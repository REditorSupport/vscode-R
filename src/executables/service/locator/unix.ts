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
        this._executablePaths = [];
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    public async refreshPaths(): Promise<void> {
        this._executablePaths = getUniquePaths(Array.from(
            new Set([
                ...this.getPathFromDirs(),
                ...this.getPathFromEnv(),
                ...this.getPathFromConda()
            ])
        ));
        this.emitter.fire(this._executablePaths);
    }

    private getPathFromDirs(): string[] {
        const execPaths: string[] = [];
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
                execPaths.push(bin);
            }
        }
        return execPaths;
    }

    private getPathFromConda(): string[] {
        const execPaths: string[] = [];
        const condaDirs = [
            `${os.homedir()}/.conda/environments.txt`
        ];
        for (const condaEnv of condaDirs) {
            if (fs.existsSync(condaEnv)) {
                const lines = fs.readFileSync(condaEnv)?.toString();
                if (lines) {
                    for (const line of lines.split('\n')) {
                        if (line) {
                            const rDirs = [
                                `${line}/lib64/R/bin/R`,
                                `${line}/lib/R/bin/R`
                            ];
                            for (const dir of rDirs) {
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

    private getPathFromEnv(): string[] {
        const execPaths: string[] = [];
        const osPaths: string[] | string | undefined = process?.env?.PATH?.split(';');

        if (osPaths) {
            for (const osPath of osPaths) {
                const rPath: string = path.join(osPath, 'R');
                if (fs.existsSync(rPath)) {
                    execPaths.push(rPath);
                }
            }
        }

        return execPaths;
    }
}

