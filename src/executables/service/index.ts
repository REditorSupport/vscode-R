import * as vscode from 'vscode';

import { validateRExecutablePath } from '..';
import { ExecutableType, RExecutableFactory } from './class';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry } from '../../util';
import { RExecutablePathStorage } from './pathStorage';
import { RExecutableRegistry } from './registry';
import { AbstractLocatorService, LocatorServiceFactory } from './locator';

export * from './class';

/**
 * @description
 * @export
 * @interface WorkspaceExecutableEvent
 */
export interface WorkspaceExecutableEvent {
    workingFolder: vscode.WorkspaceFolder,
    executable: ExecutableType | undefined
}

/**
 * @description
 * @export
 * @class RExecutableService
 * @implements {vscode.Disposable}
 */
export class RExecutableService implements vscode.Disposable {
    public readonly executableFactory: RExecutableFactory;
    public readonly executablePathLocator: AbstractLocatorService;
    private readonly executableStorage: RExecutablePathStorage;
    private readonly executableRegistry: RExecutableRegistry;
    private executableEmitter: vscode.EventEmitter<ExecutableType>;
    private workspaceEmitter: vscode.EventEmitter<WorkspaceExecutableEvent>;
    private workspaceExecutables: Map<string, ExecutableType>;


    /**
     * Creates an instance of RExecutableService.
     * @memberof RExecutableService
     */
    public constructor() {
        this.executablePathLocator = LocatorServiceFactory.getLocator();
        this.executablePathLocator.refreshPaths();
        this.executableRegistry = new RExecutableRegistry();
        this.executableStorage = new RExecutablePathStorage();
        this.executableFactory = new RExecutableFactory(this.executableRegistry);
        this.workspaceExecutables = new Map<string, ExecutableType>();

        this.executableEmitter = new vscode.EventEmitter<ExecutableType>();
        this.workspaceEmitter = new vscode.EventEmitter<WorkspaceExecutableEvent>();

        // create executables for all executable paths found
        this.executablePathLocator.binaryPaths.forEach((path) => {
            this.executableFactory.create(path);
        });

        const confPath = config().get<string>(getRPathConfigEntry());
        // from storage, recreate associations between workspace paths and executable paths
        for (const [dirPath, execPath] of this.executableStorage.executablePaths) {
            if (validateRExecutablePath(execPath)) {
                this.workspaceExecutables.set(dirPath, this.executableFactory.create(execPath));
            }
        }

        if (!this.executableStorage.getActiveExecutablePath() && confPath && validateRExecutablePath(confPath)) {
            console.log(`[RExecutableService] Executable set to configuration path: ${confPath}`);
            const exec = this.executableFactory.create(confPath);
            this.activeExecutable = exec;
        }
    }

    public get executables(): Set<ExecutableType> {
        return this.executableRegistry.executables;
    }

    /**
     * @description
     * @memberof RExecutableService
     */
    public set activeExecutable(executable: ExecutableType) {
        if (executable === null) {
            this.workspaceExecutables.delete(getCurrentWorkspaceFolder().uri.fsPath);
            this.executableStorage.setExecutablePath(getCurrentWorkspaceFolder().uri.fsPath, null);
            console.log('[RExecutableService] executable cleared');
            this.executableEmitter.fire(null);
        } else if (this.activeExecutable !== executable) {
            this.workspaceExecutables.set(getCurrentWorkspaceFolder().uri.fsPath, executable);
            this.executableStorage.setExecutablePath(getCurrentWorkspaceFolder().uri.fsPath, executable.rBin);
            console.log('[RExecutableService] executable changed');
            this.executableEmitter.fire(executable);
        }
    }

    /**
     * @description
     * Returns the current *active* R executable.
     * This may differ depending on the current active workspace folder.
     * @type {RExecutable}
     * @memberof RExecutableService
     */
    public get activeExecutable(): ExecutableType | undefined {
        const currWorkspacePath = getCurrentWorkspaceFolder().uri.fsPath;
        if (currWorkspacePath) {
            return this.workspaceExecutables.get(currWorkspacePath);
        } else {
            return this.workspaceExecutables.get(vscode.window.activeTextEditor.document.uri.fsPath);
        }
    }

    /**
     * @description
     * Set the R executable associated with a given workspace folder.
     * @param {string} folder
     * @param {RExecutable} executable
     * @memberof RExecutableService
     */
    public setWorkspaceExecutable(folder: string, executable: ExecutableType): void {
        if (this.workspaceExecutables.get(folder) !== executable) {
            if (executable === undefined) {
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
    public getWorkspaceExecutable(folder: string): ExecutableType | undefined{
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
    public get onDidChangeActiveExecutable(): vscode.Event<ExecutableType> {
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
}
