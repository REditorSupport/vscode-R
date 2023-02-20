import { spawnSync } from 'child_process';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import { normaliseRPathString } from '../../../util';

export function getRDetailsFromPath(rPath: string): { version: string, arch: string } {
    try {
        const path = normaliseRPathString(rPath);
        const child = spawnSync(path, [`--version`]).output.join('\n');
        const versionRegex = /(?<=R\sversion\s)[0-9.]*/g;
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

/**
 * For a given array of paths, return only unique paths
 * (including symlinks), favouring shorter paths
 * @param paths
 */
export function getUniquePaths(paths: string[]): string[] {
    function realpath(path: string): string {
        if (fs.lstatSync(path).isSymbolicLink()) {
            return fs.realpathSync(path);
        }
        return path;
    }
    function existsInSet(set: Set<string>, path: string): string {
        const arr: string[] = [];
        set.forEach((v) => {
            if (realpath(path) === realpath(v)) {
                arr.push(v);
            }
        });
        return arr?.[0];
    }

    const out: Set<string> = new Set<string>();
    for (const path of paths) {
        const truepath = realpath(path);
        const storedpath = existsInSet(out, path);
        if (storedpath) {
            if (storedpath.length > truepath.length) {
                out.delete(storedpath);
                out.add(truepath);
            }
        } else {
            const shortestPath = truepath.length <= path.length ? truepath : path;
            out.add(shortestPath);
        }
    }
    return [...out.values()];
}

export abstract class AbstractLocatorService {
    protected _executablePaths!: string[];
    protected emitter!: vscode.EventEmitter<string[]>;
    public abstract refreshPaths(): Promise<void>;
    public get hasPaths(): boolean {
        return this._executablePaths.length > 0;
    }
    public get executablePaths(): string[] {
        return this._executablePaths;
    }
    public get onDidRefreshPaths(): vscode.Event<string[]> {
        return this.emitter.event;
    }
}
