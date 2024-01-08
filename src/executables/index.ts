'use strict';

import * as vscode from 'vscode';

import { ExecutableStatusItem, ExecutableQuickPick } from './ui';
import { RExecutableService, RExecutableType, WorkspaceExecutableEvent } from './service';
import { extensionContext } from '../extension';

export * from './virtual';
export * from './util';
export { RExecutableType, VirtualRExecutableType } from './service';

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
            this.onDidChangeActiveExecutable(() => this.reload()),
            vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
                if (e?.document) {this.reload();}
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

    public getExecutableFromPath(rpath: string): RExecutableType | undefined {
        return this.executableService.executableFactory.create(rpath);
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
     * Orders a refresh of the executable manager, causing a refresh of the language status bar item
     * @memberof RExecutableManager
     */
    public reload(): void {
        this.statusBar.refresh();
    }
}
