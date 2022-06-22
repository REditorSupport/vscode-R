import path = require('path');
import * as fs from 'fs-extra';

export function getVersionFromPath(rPath: string): string {
    if (process.platform === 'win32') {
        // not sure how to do this
        return '';
    } else {
        try {
            const scriptPath = path.normalize(`${rPath}/../Rcmd`);
            const rCmdFile = fs.readFileSync(scriptPath, 'utf-8');
            const regex = /(?<=R_VERSION=)[0-9.]*/g;
            const version = regex.exec(rCmdFile)?.[0];
            return version ?? '';
        } catch (error) {
            return '';
        }
    }
}

export function getArchitectureFromPath(path: string): string {
    if (process.platform === 'win32') {
        // \\bin\\i386 = 32bit
        // \\bin\\x64 = 64bit
        return '';
    } else {
        return '64-bit';
    }
}

export abstract class AbstractLocatorService {
    protected binary_paths: string[];
    public abstract get hasBinaries(): boolean;
    public abstract get binaries(): string[];
    public abstract refreshPaths(): void;
}
