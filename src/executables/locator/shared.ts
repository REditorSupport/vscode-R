import { execSync } from 'child_process';
import { RExecutable } from '../executable';

export function getRDetailsFromPath(rPath: string): {version: string, arch: string} {
    try {
        const child = execSync(`${rPath} --version`).toString();
        const versionRegex = /(?<=R version\s)[0-9.]*/g;
        const archRegex = /[0-9]*-bit/g;
        const out = {
            version: child.match(versionRegex)?.[0] ?? '',
            arch: child.match(archRegex)?.[0] ?? ''
        };
        return out;
    } catch (error) {
        return { version: '', arch: '' };
    }
}

export abstract class AbstractLocatorService {
    protected _binaryPaths: string[];
    protected _executables: RExecutable[];
    public abstract get hasExecutables(): boolean;
    public abstract get executables(): RExecutable[];
    public abstract get binaryPaths(): string[];
    public abstract refreshPaths(): void;
}
