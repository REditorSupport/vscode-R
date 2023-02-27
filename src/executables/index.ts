import path = require('path');
import * as fs from 'fs-extra';
import * as vscode from 'vscode';
import * as cp from 'child_process';

import { ExecutableStatusItem, ExecutableQuickPick } from './ui';
import { isVirtual, RExecutableService, RExecutableType, WorkspaceExecutableEvent } from './service';
import { extensionContext } from '../extension';
import { activateCondaEnvironment, condaPrefixPath } from './virtual';

// super class that manages relevant sub classes
export class RExecutableManager {
    private readonly executableService: RExecutableService;
    private statusBar: ExecutableStatusItem;
    private quickPick: ExecutableQuickPick;

    private constructor(service: RExecutableService) {
        this.executableService = service;
        this.statusBar = new ExecutableStatusItem(this.executableService);
        this.quickPick = new ExecutableQuickPick(this.executableService);
        extensionContext.subscriptions.push(
            this.onDidChangeActiveExecutable(() => {
                this.reload();
            }),
            vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
                if (e?.document) {
                    this.reload();
                }
            }),
            this.executableService,
            this.statusBar
        );
        this.reload();
    }

    static async initialize(): Promise<RExecutableManager> {
        const executableService = await RExecutableService.initialize();
        return new this(executableService);
    }

    public get executableQuickPick(): ExecutableQuickPick {
        return this.quickPick;
    }

    public get languageStatusItem(): ExecutableStatusItem {
        return this.statusBar;
    }

    public get activeExecutablePath(): string | undefined {
        return this.executableService.activeExecutable?.rBin;
    }

    /**
     * Get the associated R executable for a given working directory path
     * @param workingDir
     * @returns
     */
    public getExecutablePath(workingDir: string): string | undefined {
        return this.executableService.getWorkspaceExecutable(workingDir)?.rBin;
    }

    public get activeExecutable(): RExecutableType | undefined {
        return this.executableService.activeExecutable;
    }

    public get onDidChangeActiveExecutable(): vscode.Event<RExecutableType | undefined> {
        return this.executableService.onDidChangeActiveExecutable;
    }

    public get onDidChangeWorkspaceExecutable(): vscode.Event<WorkspaceExecutableEvent> {
        return this.executableService.onDidChangeWorkspaceExecutable;
    }

    /**
     * @description
     * Orders a refresh of the executable manager, causing a refresh of the language status bar item and
     * activates a conda environment if present.
     * @memberof RExecutableManager
     */
    public reload(): void {
        this.statusBar.refresh();
        const loading = this.activateEnvironment();
        void this.statusBar.makeBusy(loading);
    }

    /**
     * Activates a Conda environment, but only if the currently active executable is virtual
     * and has no obtained environmental variable. If determined that activation is not necessary,
     * a resolved promise will be returned.
     */
    private async activateEnvironment(): Promise<void> {
        if (!this.activeExecutable ||
            !isVirtual(this.activeExecutable) ||
            !!this.activeExecutable.envVar
        ) {
            return Promise.resolve();
        }
        await activateCondaEnvironment(this.activeExecutable);
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


/**
 * @description
 * Takes an options object, and modifies the env values to allow for the injection
 * of conda env values, and modify R binary paths for various rterms (e.g. radian)
 * @export
 * @template T
 * @param {T} opts
 * @param {RExecutableType} executable
 * @returns {*}  {T}
 */
export function modifyEnvVars<T extends vscode.TerminalOptions | cp.CommonOptions>(opts: T, executable: RExecutableType): T {
    const envVars: Record<string, string> = {
        R_BINARY: executable.rBin
    };
    const pathEnv: string = (opts?.env as Record<string, string>)?.PATH ?? process.env?.PATH;
    if (isVirtual(executable) && executable.envVar) {
        pathEnv ?
            envVars['PATH'] = `${executable.envVar}:${pathEnv}`
            :
            envVars['PATH'] = executable.envVar;
        envVars['CONDA_PREFIX'] = condaPrefixPath(executable.rBin);
        envVars['CONDA_DEFAULT_ENV'] = executable.name ?? 'base';
        envVars['CONDA_PROMPT_MODIFIER'] = `(${envVars['CONDA_DEFAULT_ENV']})`;
    }
    opts['env'] = envVars;
    return opts;
}