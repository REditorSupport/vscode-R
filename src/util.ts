'use strict';

import { existsSync, PathLike, readFile } from 'fs-extra';
import * as fs from 'fs';
import winreg = require('winreg');
import * as path from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { rGuestService, isGuestSession } from './liveShare';
import { extensionContext } from './extension';

export function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('r');
}

function getRfromEnvPath(platform: string) {
    let splitChar = ':';
    let fileExtension = '';

    if (platform === 'win32') {
        splitChar = ';';
        fileExtension = '.exe';
    }

    const os_paths: string[] | string = process.env.PATH.split(splitChar);
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

    rpath ||= getRfromEnvPath(platform);

    if ( !rpath && platform === 'win32') {
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

export function getRPathConfigEntry(term: boolean = false): string {
    const trunc = (term ? 'rterm' : 'rpath');
    const platform = (
        process.platform === 'win32' ? 'windows' :
            process.platform === 'darwin' ? 'mac' :
                'linux'
    );
    return `${trunc}.${platform}`;
}

export async function getRpath(quote = false, overwriteConfig?: string): Promise<string> {
    let rpath = '';

    // try the config entry specified in the function arg:
    if (overwriteConfig) {
        rpath = config().get<string>(overwriteConfig);
    }

    // try the os-specific config entry for the rpath:
    const configEntry = getRPathConfigEntry();
    rpath ||= config().get<string>(configEntry);

    // read from path/registry:
    rpath ||= await getRpathFromSystem();

    // represent all invalid paths (undefined, '', null) as undefined:
    rpath ||= undefined;

    if (!rpath) {
        // inform user about missing R path:
        void vscode.window.showErrorMessage(`Cannot find R to use for help, package installation etc. Change setting r.${configEntry} to R path.`);
    } else if (quote && /^[^'"].* .*[^'"]$/.exec(rpath)) {
        // if requested and rpath contains spaces, add quotes:
        rpath = `"${rpath}"`;
    } else if (!quote) {
        rpath = rpath.replace(/^"(.*)"$/, '$1');
        rpath = rpath.replace(/^'(.*)'$/, '$1');
    } else if (process.platform === 'win32' && /^'.* .*'$/.exec(rpath)) {
        // replace single quotes with double quotes on windows
        rpath = rpath.replace(/^'(.*)'$/, '"$1"');
    }

    return rpath;
}

export async function getRterm(): Promise<string | undefined> {
    const configEntry = getRPathConfigEntry(true);
    let rpath = config().get<string>(configEntry);

    rpath ||= await getRpathFromSystem();

    if (rpath !== '') {
        return rpath;
    }

    void vscode.window.showErrorMessage(`Cannot find R for creating R terminal. Change setting r.${configEntry} to R path.`);
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

export function getCurrentWorkspaceFolder(): vscode.WorkspaceFolder {
    if (vscode.workspace.workspaceFolders !== undefined) {
        if (vscode.workspace.workspaceFolders.length === 1) {
            return vscode.workspace.workspaceFolders[0];
        } else if (vscode.workspace.workspaceFolders.length > 1) {
            const currentDocument = vscode.window.activeTextEditor;
            if (currentDocument !== undefined) {
                return vscode.workspace.getWorkspaceFolder(currentDocument.document.uri);
            }
        }
    }

    return undefined;
}

// Drop-in replacement for fs-extra.readFile (),
// passes to guest service if the caller is a guest
// This can be used wherever fs.readFile() is used,
// particularly if a guest can access the function
//
// If it is a guest, the guest service requests the host
// to read the file, and pass back its contents to the guest
export function readContent(file: PathLike | number): Promise<Buffer>;
export function readContent(file: PathLike | number, encoding: string): Promise<string>;
export function readContent(file: PathLike | number, encoding?: string): Promise<string | Buffer> {
    if (isGuestSession) {
        return encoding === undefined ? rGuestService.requestFileContent(file) : rGuestService.requestFileContent(file, encoding);
    } else {
        return encoding === undefined ? readFile(file) : readFile(file, encoding);
    }
}


export async function saveDocument(document: vscode.TextDocument): Promise<boolean> {
    if (document.isUntitled) {
        void vscode.window.showErrorMessage('Document is unsaved. Please save and retry running R command.');

        return false;
    }

    const isSaved: boolean = document.isDirty ? (await document.save()) : true;
    if (!isSaved) {
        void vscode.window.showErrorMessage('Cannot run R command: document could not be saved.');

        return false;
    }

    return true;
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
// is more transparent than background processes without littering the integrated terminals
// is not intended for actual user interaction
export async function executeAsTask(name: string, process: string, args?: string[], asProcess?: true): Promise<void>;
export async function executeAsTask(name: string, command: string, args?: string[], asProcess?: false): Promise<void>;
export async function executeAsTask(name: string, cmdOrProcess: string, args?: string[], asProcess: boolean = false): Promise<void> {
    let taskDefinition: vscode.TaskDefinition;
    let taskExecution: vscode.ShellExecution | vscode.ProcessExecution;
    if(asProcess){
        taskDefinition = { type: 'process'};
        taskExecution = new vscode.ProcessExecution(
            cmdOrProcess,
            args
        );
    } else{
        taskDefinition = { type: 'shell' };
        const quotedArgs = args.map<vscode.ShellQuotedString>(arg => { return { value: arg, quoting: vscode.ShellQuoting.Weak }; });
        taskExecution = new vscode.ShellExecution(
            cmdOrProcess,
            quotedArgs
        );
    }
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
            if (e.execution === taskExecutionRunning) {
                resolve();
            }
        });
    });

    return await taskDonePromise;
}

// executes a callback and shows a 'busy' progress bar during the execution
// synchronous callbacks are converted to async to properly render the progress bar
// default location is in the help pages tree view
export async function doWithProgress<T>(cb: (token?: vscode.CancellationToken, progress?: vscode.Progress<T>) => T | Promise<T>, location: string | vscode.ProgressLocation = 'rHelpPages', title?: string, cancellable?: boolean): Promise<T> {
    const location2 = (typeof location === 'string' ? { viewId: location } : location);
    const options: vscode.ProgressOptions = {
        location: location2,
        cancellable: cancellable ?? false,
        title: title
    };
    let ret: T;
    await vscode.window.withProgress(options, async (progress, token) => {
        const retPromise = new Promise<T>((resolve) => setTimeout(() => {
            const ret = cb(token, progress);
            resolve(ret);
        }));
        ret = await retPromise;
    });
    return ret;
}

// get the URL of a CRAN website
// argument path is optional and should be relative to the cran root
// currently the CRAN root url is hardcoded, this could be replaced by reading
// the url from config, R, or both
export async function getCranUrl(path: string = '', cwd?: string): Promise<string> {
    const defaultCranUrl = 'https://cran.r-project.org/';
    // get cran URL from R. Returns empty string if option is not set.
    const baseUrl = await executeRCommand('cat(getOption(\'repos\')[\'CRAN\'])', undefined, cwd);
    let url: string;
    try {
        url = new URL(path, baseUrl).toString();
    } catch (e) {
        url = new URL(path, defaultCranUrl).toString();
    }
    return url;
}




// executes an R command returns its output to stdout
// uses a regex to filter out output generated e.g. by code in .Rprofile
// returns the provided fallBack when the command failes
//
// WARNING: Cannot handle double quotes in the R command! (e.g. `print("hello world")`)
// Single quotes are ok.
//
export async function executeRCommand(rCommand: string, fallBack?: string, cwd?: string): Promise<string | undefined> {
    const lim = '---vsc---';
    const re = new RegExp(`${lim}(.*)${lim}`, 'ms');

    const args = [
        '--silent',
        '--slave',
        '--no-save',
        '--no-restore',
    ];

    const rPath = await getRpath(true);

    const options: cp.ExecSyncOptionsWithStringEncoding = {
        cwd: cwd,
        encoding: 'utf-8'
    };

    const cmd = (
        `${rPath} ${args.join(' ')} -e "cat('${lim}')" -e "${rCommand}" -e "cat('${lim}')"`
    );

    let ret: string = undefined;

    try {
        const stdout = cp.execSync(cmd, options);
        ret = stdout.replace(re, '$1');
    } catch (e) {
        if (fallBack) {
            ret = fallBack;
        } else {
            console.warn(e);
        }
    }

    return ret;
}


// This class is a wrapper around Map<string, any> that implements vscode.Memento
// Can be used in place of vscode.ExtensionContext.globalState or .workspaceState when no caching is desired
export class DummyMemento implements vscode.Memento {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items = new Map<string, any>()
    public get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.items.has(key)) {
            return <T>this.items.get(key) || defaultValue;
        } else {
            return defaultValue;
        }
    }
    // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
    public async update(key: string, value: any): Promise<void> {
        this.items.set(key, value);
    }

    public keys(): readonly string[] {
        return Object.keys(this.items);
    }
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
export async function setContext(key: string, value: any): Promise<void> {
    await vscode.commands.executeCommand(
        'setContext', key, value
    );
}

// Helper function used to convert raw text files to html
export function escapeHtml(source: string): string {
    const entityMap = new Map<string, string>(Object.entries({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
        '/': '&#x2F;'
    }));
    return String(source).replace(/[&<>"'/]/g, (s: string) => entityMap.get(s) || '');
}

// creates a directory if it doesn't exist,
// returns the input string
export function getDir(dirPath: string): string {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath);
    }
    return dirPath;
}

export class UriIcon {
    dark: vscode.Uri;
    light: vscode.Uri;
    constructor(id: string) {
        const extIconPath = extensionContext.asAbsolutePath('images/icons');
        this.dark = vscode.Uri.file(path.join(extIconPath, 'dark', id + '.svg'));
        this.light = vscode.Uri.file(path.join(extIconPath, 'light', id + '.svg'));
    }
}

/**
 * As Disposable.
 *
 * Create a dispose method for any given object, and push it to the
 * extension subscriptions array
 *
 * @param {T} toDispose - the object to add dispose to
 * @param {Function} disposeFunction - the method called when the object is disposed
 * @returns returned object is considered types T and vscode.Disposable
 */
export function asDisposable<T>(toDispose: T, disposeFunction: (...args: unknown[]) => unknown): T & vscode.Disposable {
    type disposeType = T & vscode.Disposable;
    (toDispose as disposeType).dispose = () => disposeFunction();
    extensionContext.subscriptions.push(toDispose as disposeType);
    return toDispose as disposeType;
}

export type DisposableProcess = cp.ChildProcessWithoutNullStreams & vscode.Disposable;
export function exec(command: string, args?: ReadonlyArray<string>, options?: cp.CommonOptions, onDisposed?: () => unknown): DisposableProcess {
    const proc = cp.spawn(command, args, options);
    console.log(`Process ${proc.pid} spawned`);
    let running = true;
    const exitHandler = () => {
        running = false;
        console.log(`Process ${proc.pid} exited`);
    };
    proc.on('exit', exitHandler);
    proc.on('error', exitHandler);
    const disposable = asDisposable(proc, () => {
        if (running) {
            console.log(`Process ${proc.pid} terminating`);
            if (process.platform === 'win32') {
                cp.spawnSync('taskkill', ['/pid', proc.pid.toString(), '/f', '/t']);
            } else {
                proc.kill('SIGKILL');
            }
        }
        if (onDisposed) {
            onDisposed();
        }
    });
    return disposable;
}
