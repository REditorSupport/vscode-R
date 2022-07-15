import path = require('path');
import * as fs from 'fs-extra';
import * as vscode from 'vscode';

import { ExecutableStatusItem, ExecutableQuickPick } from './ui';
import { isVirtual, RExecutableService, ExecutableType, WorkspaceExecutableEvent } from './service';
import { extensionContext } from '../extension';
import { activateCondaEnvironment } from './conda';

export { ExecutableType as IRExecutable, VirtualExecutableType as IVirtualRExecutable } from './service';

// super class that manages relevant sub classes
export class RExecutableManager implements vscode.Disposable {
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
            vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor) => {
                if (e?.document) {
                    this.reload();
                }
            }),
            this
        );
        this.reload();
    }

    static async initialize(): Promise<RExecutableManager> {
        const executableService = await RExecutableService.initialize();
        return new this(executableService);
    }

    public dispose(): void {
        this.executableService.dispose();
        this.statusBar.dispose();
        this.quickPick.dispose();
    }

    public get executableQuickPick(): ExecutableQuickPick {
        return this.quickPick;
    }

    public get activeExecutablePath(): string | undefined {
        return this.executableService.activeExecutable?.rBin;
    }

    public getExecutablePath(workingDir: string): string | undefined {
        return this.executableService.getWorkspaceExecutable(workingDir)?.rBin;
    }

    public get activeExecutable(): ExecutableType | undefined {
        return this.executableService.activeExecutable;
    }

    public get onDidChangeActiveExecutable(): vscode.Event<ExecutableType | undefined> {
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
        void this.statusBar.busy(loading);
    }


    private async activateEnvironment(): Promise<boolean> {
        if (!this.activeExecutable || !isVirtual(this.activeExecutable)) {
            return Promise.resolve(true);
        }
        return activateCondaEnvironment(this.activeExecutable?.rBin);
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
        fs.accessSync(execPath, fs.constants.X_OK);
        return  (path.basename(execPath) === basename);
    } catch (error) {
        return false;
    }
}
