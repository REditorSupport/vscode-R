'use strict';

import { existsSync } from 'fs-extra';
import path = require('path');
import fs = require('fs');
import { window, workspace } from 'vscode';
import winreg = require('winreg');

export function config() {
    return workspace.getConfiguration('r');
}

function getRfromEnvPath(platform: string) {
    let splitChar: string = ':';
    let fileExtension: string = '';
    
    if (platform === 'win32') {
        splitChar = ';';
        fileExtension = '.exe';
    }
    
    const os_paths: string[]|string = process.env.PATH.split(splitChar);
    for (const os_path of os_paths) {
        const os_r_path: string = path.join(os_path, 'R' + fileExtension);
        if (fs.existsSync(os_r_path)) {
            return os_r_path;
        }
    }
    return '';
}

export async function getRpathFromSystem() {
    
    let rpath: string = '';
    const platform: string = process.platform;
    
    if ( platform === 'win32') {
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

    rpath ||= getRfromEnvPath(platform);

    return rpath;
}

export async function getRpath(quote: boolean=false, overwriteConfig?: string): Promise<string> {
    let rpath: string = '';
    
    const configEntry = (
        process.platform === 'win32' ? 'rpath.windows' :
        process.platform === 'darwin' ? 'rpath.mac' :
        'rpath.linux'
    );

    // try the config entry specified in the function arg:
    if(overwriteConfig){
        rpath = config().get<string>(overwriteConfig);
    }

    // try the os-specific config entry for the rpath:
    rpath ||= config().get<string>(configEntry);

    // read from path/registry:
    rpath ||= await getRpathFromSystem();

    // represent all invalid paths (undefined, '', null) as undefined:
    rpath ||= undefined;

    if(!rpath){
        // inform user about missing R path:
        window.showErrorMessage(`${process.platform} can't use R`);
    } else if(quote && rpath.match(/^[^'"].* .*[^'"]$/)){
        // if requested and rpath contains spaces, add quotes:
        rpath = `"${rpath}"`;
    } else if(process.platform === 'win32' && rpath.match(/^'.* .*'$/)){
        // replace single quotes with double quotes on windows
        rpath = rpath.replace(/^'(.*)'$/, '"$1"');
    }

    return rpath;
}

export async function getRterm() {
    
    let rpath: string = '';
    const platform: string = process.platform;
    
    if ( platform === 'win32') {
        rpath = config().get<string>('rterm.windows');
    } else if (platform === 'darwin') {
        rpath = config().get<string>('rterm.mac');
    } else if (platform === 'linux') {
        rpath = config().get<string>('rterm.linux');
    }

    rpath ||= await getRpathFromSystem();
    
    if (rpath !== '') {
        return rpath;
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
