'use strict';

import { existsSync } from 'fs-extra';
import path = require('path');
import fs = require('fs');
import { window, workspace, WorkspaceConfiguration } from 'vscode';
import winreg = require('winreg');
import * as vscode from 'vscode';

export function config(): WorkspaceConfiguration {
    return workspace.getConfiguration('r');
}

function getRfromEnvPath(platform: string) {
    let splitChar = ':';
    let fileExtension = '';
    
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

export async function getRpathFromSystem(): Promise<string> {
    
    let rpath = '';
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

export async function getRpath(quote=false, overwriteConfig?: string): Promise<string> {
    let rpath = '';
    
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
        void window.showErrorMessage(`${process.platform} can't use R`);
    } else if(quote && /^[^'"].* .*[^'"]$/.exec(rpath)){
        // if requested and rpath contains spaces, add quotes:
        rpath = `"${rpath}"`;
    } else if(process.platform === 'win32' && /^'.* .*'$/.exec(rpath)){
        // replace single quotes with double quotes on windows
        rpath = rpath.replace(/^'(.*)'$/, '"$1"');
    }

    return rpath;
}

export async function getRterm(): Promise<string|undefined> {
    
    let rpath = '';
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

    void window.showErrorMessage(`${process.platform} can't use R`);
    return undefined;
}


export function ToRStringLiteral(s: string, quote: string): string {
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

export async function delay(ms: number): Promise<unknown> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function checkForSpecialCharacters(text: string): boolean {
    return !/[~`!#$%^&*+=\-[\]\\';,/{}|\\":<>?\s]/g.test(text);
}

export function checkIfFileExists(filePath: string): boolean {
    return existsSync(filePath);
}


// shows a quick pick asking the user for confirmation
// returns true if the user confirms, false if they cancel or dismiss the quickpick
export async function getConfirmation(prompt: string, confirmation?: string, detail?: string): Promise<boolean> {
    confirmation ||= 'Yes';
    const items: vscode.QuickPickItem[] = [
        {
            label: confirmation,
            detail: detail
        },
        {
            label: 'Cancel'
        }
    ];
    const answer = await vscode.window.showQuickPick(items, {
        placeHolder: prompt
    });
    return answer === items[0];
}

// executes a given command as shell task
// is more transparent thatn background processes without littering the integrated terminals
// is not intended for actual user interaction
export async function executeAsTask(name: string, command: string, args?: string[]): Promise<void> {
    const taskDefinition = {type: 'shell'};
    const taskExecution = new vscode.ShellExecution(
        command,
        args
    );
    const task = new vscode.Task(
        taskDefinition,
        vscode.TaskScope.Global,
        name,
        'R',
        taskExecution,
        []
    );
    const taskExecutionRunning = await vscode.tasks.executeTask(task);

    const taskDonePromise = new Promise<void>((resolve) => {
        vscode.tasks.onDidEndTask(e => {
            if(e.execution === taskExecutionRunning){
                resolve();
            }
        });
    });

    return await taskDonePromise;
}

// executes a callback and shows a 'busy' progress bar during the execution
// synchronous callbacks are converted to async to properly render the progress bar
// default location is in the help pages tree view
export async function doWithProgress<T>(cb: () => T | Promise<T>, location: string | vscode.ProgressLocation = 'rHelpPages'): Promise<T> {
	const location2 = (typeof location === 'string' ? {viewId: location} : location);
	const options: vscode.ProgressOptions = {
		location: location2,
		cancellable: false
	};
	let ret: T;
	await vscode.window.withProgress(options, async () => {
		const retPromise = new Promise<T>((resolve) => setTimeout(() => {
			const ret = cb();
			resolve(ret);
		}));
		ret = await retPromise;
	});
	return ret;
}
