'use strict';

import * as vscode from 'vscode';

import { getConfigPathWithSubstitution, validateRExecutablePath } from '../util';
import { RExecutableFactory } from './class';
import { getCurrentWorkspaceFolder } from '../../util';
import { RExecutablePathStorage } from './pathStorage';
import { RExecutableRegistry } from './registry';
import { TAbstractLocatorService, LocatorServiceFactory } from './locator';
import { RExecutableType, WorkspaceExecutableEvent } from './types';
import { getRenvVersion } from '../renv';
import { homeExtDir } from '../../extension';

export * from './types';
export * from './class';

/**
 * @description
 * @export
 * @class RExecutableService
 * @implements {vscode.Disposable}
 */
export class RExecutableService implements vscode.Disposable {
    public executableFactory: RExecutableFactory;
    public executablePathLocator: TAbstractLocatorService;
    private executableStorage: RExecutablePathStorage;
    private executableRegistry: RExecutableRegistry;
    private executableEmitter: vscode.EventEmitter<RExecutableType | undefined>;
    private workspaceEmitter: vscode.EventEmitter<WorkspaceExecutableEvent>;
    private workspaceExecutables: Map<string, RExecutableType | undefined>;

    public readonly ready!: Thenable<this>;

    /**
     * Creates an instance of RExecutableService.
     * @memberof RExecutableService
     */
    private constructor(locator: TAbstractLocatorService) {
        this.executablePathLocator = locator;
        this.executableRegistry = new RExecutableRegistry();
        this.executableStorage = new RExecutablePathStorage();
        this.executableFactory = new RExecutableFactory(this.executableRegistry);
        this.workspaceExecutables = new Map<string, RExecutableType>();
        this.executableEmitter = new vscode.EventEmitter<RExecutableType>();
        this.workspaceEmitter = new vscode.EventEmitter<WorkspaceExecutableEvent>();
        this.executablePathLocator.executablePaths.forEach((path) => {
            this.executableFactory.create(path);
        });

        this.selectViableExecutables();
    }

    static async initialize(): Promise<RExecutableService> {
        const locator = LocatorServiceFactory.getLocator();
        await locator.refreshPaths();
        return new this(locator);
    }

    /**
     * @description
     * Get a list of all registered executables
     * @readonly
     * @type {Set<RExecutableType>}
     * @memberof RExecutableService
     */
    public get executables(): Set<RExecutableType> {
        return this.executableRegistry.executables;
    }

    /**
     * @description
     * @memberof RExecutableService
     */
    public set activeExecutable(executable: RExecutableType | undefined) {
        const currentWorkspace = getCurrentWorkspaceFolder()?.uri?.fsPath;
        if (currentWorkspace) {
            if (executable === undefined) {
                this.workspaceExecutables.delete(currentWorkspace);
                this.executableStorage.setExecutablePath(currentWorkspace, undefined);
                console.log('[RExecutableService] executable cleared');
                this.executableEmitter.fire(undefined);
            } else if (this.activeExecutable !== executable) {
                this.workspaceExecutables.set(currentWorkspace, executable);
                this.executableStorage.setExecutablePath(currentWorkspace, executable.rBin);
                console.log('[RExecutableService] executable changed');
                this.executableEmitter.fire(executable);
            }
        }
    }

    /**
     * @description
     * Returns the current *active* R executable.
     * This may differ depending on the current active workspace folder.
     * @type {RExecutable}
     * @memberof RExecutableService
     */
    public get activeExecutable(): RExecutableType | undefined {
        const currWorkspacePath = getCurrentWorkspaceFolder()?.uri?.fsPath;
        if (currWorkspacePath) {
            return this.workspaceExecutables.get(currWorkspacePath);
        }

        const currentDocument = vscode?.window?.activeTextEditor?.document?.uri?.fsPath;
        if (currentDocument) {
            return this.workspaceExecutables.get(currentDocument);
        }

        return undefined;
    }

    /**
     * @description
     * Set the R executable associated with a given workspace folder.
     * @param {string} folder
     * @param {RExecutable} executable
     * @memberof RExecutableService
     */
    public setWorkspaceExecutable(folder: string, executable: RExecutableType | undefined): void {
        if (this.workspaceExecutables.get(folder) !== executable) {
            if (!executable) {
                this.executableStorage.setExecutablePath(folder, undefined);
                this.workspaceEmitter.fire({ workingFolder: undefined, executable: executable });
            } else {
                const workspaceFolderUri = vscode.Uri.file(folder);
                this.workspaceEmitter.fire({ workingFolder: vscode.workspace.getWorkspaceFolder(workspaceFolderUri), executable: executable });
                this.executableStorage.setExecutablePath(folder, executable.rBin);
            }
        }
        this.workspaceExecutables.set(folder, executable);
        this.executableEmitter.fire(executable);
    }

    /**
     * @description
     * Get the R executable associated with a given workspace folder.
     * @param {string} folder
     * @returns {*}  {RExecutable}
     * @memberof RExecutableService
     */
    public getWorkspaceExecutable(folder: string): RExecutableType | undefined {
        return this.workspaceExecutables.get(folder);
    }

    /**
     * @description
     * An event that is fired whenever the active executable changes.
     * This can occur, for instance, when changing focus between multi-root workspaces.
     * @readonly
     * @type {vscode.Event<RExecutable>}
     * @memberof RExecutableService
     */
    public get onDidChangeActiveExecutable(): vscode.Event<RExecutableType | undefined> {
        return this.executableEmitter.event;
    }

    /**
     * @description
     * Event that is triggered when the executable associated with a workspace is changed.
     * @readonly
     * @type {vscode.Event<WorkspaceExecutableEvent>}
     * @memberof RExecutableService
     */
    public get onDidChangeWorkspaceExecutable(): vscode.Event<WorkspaceExecutableEvent> {
        return this.workspaceEmitter.event;
    }

    /**
     * @description
     * @memberof RExecutableService
     */
    public dispose(): void {
        this.executableEmitter.dispose();
        this.workspaceEmitter.dispose();
    }

    private resolveRExecutableForPath(workspacePath: string, confPath: string | undefined) {
        if (!this.workspaceExecutables.has(workspacePath)) {
            // is there a local virtual env?
            // TODO

            // is there a renv-recommended version?
            const renvVersion = getRenvVersion(workspacePath);
            if (renvVersion) {
                const compatibleExecutables = this.executableRegistry.getExecutablesWithVersion(renvVersion);
                if (compatibleExecutables) {
                    const exec = compatibleExecutables.sort((a, b) => {
                        if (a.rBin === confPath) {
                            return -1;
                        }
                        if (b.rBin === confPath) {
                            return 1;
                        }
                        return 0;
                    });
                    this.workspaceExecutables.set(workspacePath, exec[0]);
                    return;
                }
            }

            // fallback to a configured path if it exists
            if (confPath && validateRExecutablePath(confPath)) {
                console.log(`[RExecutableService] Executable set to configuration path: ${confPath}`);
                const exec = this.executableFactory.create(confPath);
                this.workspaceExecutables.set(workspacePath, exec);
            }
        }
    }

    private selectViableExecutables(): void {
        // from storage, recreate associations between workspace paths and executable paths
        for (const [dirPath, execPath] of this.executableStorage.executablePaths) {
            if (validateRExecutablePath(execPath)) {
                this.workspaceExecutables.set(dirPath, this.executableFactory.create(execPath));
            }
        }

        const configPath = getConfigPathWithSubstitution();
        if (vscode.workspace.workspaceFolders) {
            for (const workspace of vscode.workspace.workspaceFolders) {
                this.resolveRExecutableForPath(workspace.uri.path, configPath);
            }
        } else {
            this.resolveRExecutableForPath(homeExtDir(), configPath);
        }
    }
}
