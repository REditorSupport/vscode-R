'use strict';

import * as path from 'path';
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import * as util from '../util';
import { spawnSync } from 'child_process';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry, normaliseRPathString, substituteVariables } from '../util';
import { IExecutableDetails, VirtualRExecutableType } from './service';
import { isVirtual, virtualAwareArgs } from './virtual';
import { rExecutableManager } from '../extension';


export function createTerminalOptions() {
    const currentExecutable = rExecutableManager?.activeExecutable;
    if (!currentExecutable) { return {}; }

    const workspaceFolderPath = getCurrentWorkspaceFolder()?.uri.fsPath;
    let termOptions: vscode.TerminalOptions;
    const termPath = util.getRterm();
    const shellArgs: string[] = config().get<string[]>('rterm.option')?.map(util.substituteVariables) || [];
    if (isVirtual(currentExecutable)) {
        const virtualArgs = virtualAwareArgs(currentExecutable, true, shellArgs);
        termOptions = {
            name: 'R Interactive',
            // TODO
            shellPath: virtualArgs.cmd,
            shellArgs: virtualArgs.args,
            cwd: workspaceFolderPath,
        };
    } else {
        termOptions = {
            name: 'R Interactive',
            shellPath: termPath,
            shellArgs: shellArgs,
            cwd: workspaceFolderPath,
        };
    }
    return termOptions;
}

export function getConfigPathWithSubstitution(): string | undefined {
    let rpath = config().get<string>(getRPathConfigEntry());
    rpath &&= substituteVariables(rpath);
    rpath ||= undefined;
    return rpath;
}

/**
 * Parses R version and architecture from a given R executable path.
 *
 * @param rPath string representing the path to an R executable.
 * @returns object with R version and architecture as strings
 */
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
 * Is the folder of a given executable a valid R installation?
 *
 * A path is valid if the folder contains the R executable and an Rcmd file.
 * @param execPath
 * @returns boolean
 */
export function validateRExecutablePath(execPath: string): boolean {
    try {
        const basename = process.platform === 'win32' ? 'R.exe' : 'R';
        fs.accessSync(execPath, fs.constants.X_OK && fs.constants.R_OK);
        return (path.basename(execPath) === basename);
    } catch (error) {
        return false;
    }
}
