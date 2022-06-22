import path = require('path');
import * as fs from 'fs-extra';
import * as vscode from 'vscode';

import { LocatorServiceFactory, AbstractLocatorService } from './locator';
import { ExecutableStatusItem, ExecutableQuickPick } from './ui';
import { RExecutableService, WorkspaceExecutableEvent } from './service';
import { extensionContext } from '../extension';
import { spawnAsync } from '../util';
import { RExecutable, VirtualRExecutable } from './executable';

// super class that manages relevant sub classes
export class RExecutableManager {
    private retrievalService: AbstractLocatorService;
    private statusBar: ExecutableStatusItem;
    private quickPick: ExecutableQuickPick;
    private executableService: RExecutableService;

    constructor() {
        this.retrievalService = LocatorServiceFactory.getLocator();
        this.retrievalService.refreshPaths();
        this.executableService = new RExecutableService();
        this.statusBar = new ExecutableStatusItem(this.executableService);
        this.quickPick = new ExecutableQuickPick(this.executableService, this.retrievalService);

        extensionContext.subscriptions.push(
            this.onDidChangeActiveExecutable(() => {
                this.reload();
            }),
            vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor) => {
                if (e?.document) {
                    this.reload();
                }
            }),
            this.executableService,
            this.statusBar,
            this.quickPick
        );
        this.reload();
    }

    public get activeExecutable(): RExecutable {
        return this.executableService.activeExecutable;
    }

    public get executableQuickPick(): ExecutableQuickPick {
        return this.quickPick;
    }

    public get executableStatusItem(): ExecutableStatusItem {
        return this.statusBar;
    }

    public get onDidChangeActiveExecutable(): vscode.Event<RExecutable> {
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

    private async activateEnvironment(): Promise<unknown> {
        const opts = {
            env: {
                ...process.env
            },
        };
        if (this.activeExecutable instanceof VirtualRExecutable && opts.env.CONDA_DEFAULT_ENV !== this.activeExecutable.name) {
            return spawnAsync(
                'conda', // hard coded for now
                this.activeExecutable.activationCommand,
                opts,
                undefined
            );
        } else {
            return Promise.resolve();
        }
    }

}


/**
 * Is the folder of a given executable a valid R installation?
 *
 * A path is valid if the folder contains the R executable and an Rcmd file.
 * @param execPath
 * @returns boolean
 */
export function validateRFolder(execPath: string): boolean {
    const basename = process.platform === 'win32' ? 'R.exe' : 'R';
    const scriptPath = path.normalize(`${execPath}/../Rcmd`);
    return fs.existsSync(execPath) && path.basename(basename) && fs.existsSync(scriptPath);
}
