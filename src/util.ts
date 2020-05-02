'use strict';

import { existsSync } from 'fs-extra';
import path = require('path');
import { window, workspace } from 'vscode';
import winreg = require('winreg');
export let config = workspace.getConfiguration('r');

export async function getRpath() {
    if (process.platform === 'win32') {
        let rpath: string = workspace.getConfiguration('r').get<string>('rterm.windows');
        if (rpath === '') {
            // Find path from registry
            try {
                const key = new winreg({
                    hive: winreg.HKLM,
                    key: '\\Software\\R-Core\\R',
                });
                const item: winreg.RegistryItem = await new Promise((c, e) =>
                    key.get('InstallPath', (err, result) => err === null ? c(result) : e(err)));
                rpath = path.join(item.value, 'bin', 'R.exe');
            } catch (e) {
                rpath = '';
            }
        }

        return rpath;
    }
    if (process.platform === 'darwin') {
        return workspace.getConfiguration('r').get<string>('rterm.mac');
    }
    if (process.platform === 'linux') {
        return workspace.getConfiguration('r').get<string>('rterm.linux');
    }
    window.showErrorMessage(`${process.platform} can't use R`);

    return undefined;
}

export function ToRStringLiteral(s: string, quote: string) {
    if (s === undefined) {
        return 'NULL';
    }

    return (quote +
        s.replace(/\\/g, '\\\\')
            .replace(/"""/g, `\\${quote}`)
            .replace(/\\n/g, '\\n')
            .replace(/\\r/g, '\\r')
            .replace(/\\t/g, '\\t')
            .replace(/\\b/g, '\\b')
            .replace(/\\a/g, '\\a')
            .replace(/\\f/g, '\\f')
            .replace(/\\v/g, '\\v') +
        quote);
}

export async function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function checkForSpecialCharacters(text: string) {
    return !/[~`!#$%\^&*+=\-\[\]\\';,/{}|\\":<>\?\s]/g.test(text);
}

export function checkIfFileExists(filePath: string) {
    return existsSync(filePath);
}
