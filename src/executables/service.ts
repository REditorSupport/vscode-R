import * as vscode from 'vscode';

import { validateRFolder } from '.';
import { RExecutable, RExecutableFactory } from './executable';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry } from '../util';
import { clearExecutable, getExecutable, getExecutableStore, storeExecutable } from './storage';

/**
 * @description
 * @export
 * @interface WorkspaceExecutableEvent
 */
export interface WorkspaceExecutableEvent {
    workingFolder: vscode.WorkspaceFolder,
    executable: RExecutable
}

/**
 * @description vf
 * @export
 * @class RExecutableService
 * @implements {vscode.Disposable}
 */
export class RExecutableService implements vscode.Disposable {
    private executableEmitter: vscode.EventEmitter<RExecutable>;
    private workspaceEmitter: vscode.EventEmitter<WorkspaceExecutableEvent>;
    private executables: Map<string, RExecutable>;

    /**
     * Creates an instance of RExecutableService.
     * @memberof RExecutableService
     */
    public constructor() {
        this.executableEmitter = new vscode.EventEmitter<RExecutable>();
        this.workspaceEmitter = new vscode.EventEmitter<WorkspaceExecutableEvent>();
        this.executables = new Map<string, RExecutable>();

        const confPath = config().get<string>(getRPathConfigEntry());
        for (const [dirPath, execPath] of getExecutableStore()) {
            this.executables.set(dirPath, RExecutableFactory.createExecutable(execPath));
        }

        if (!getExecutable(getCurrentWorkspaceFolder().uri.fsPath) && confPath && validateRFolder(confPath)) {
            console.log(`[RExecutableService] Executable set to configuration path: ${confPath}`);
            const exec = RExecutableFactory.createExecutable(confPath);
            this.activeExecutable = exec;
        }
    }


    /**
     * @description
     * @memberof RExecutableService
     */
    public set activeExecutable(executable: RExecutable) {
        if (executable === null) {
            this.executables.delete(getCurrentWorkspaceFolder().uri.fsPath);
            clearExecutable(getCurrentWorkspaceFolder().uri.fsPath);
            console.log('[RExecutableService] executable cleared');
            this.executableEmitter.fire(null);
        } else if (this.activeExecutable !== executable) {
            this.executables.set(getCurrentWorkspaceFolder().uri.fsPath, executable);
            storeExecutable(executable.rBin, getCurrentWorkspaceFolder().uri.fsPath);
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
    public get activeExecutable(): RExecutable {
        const currWorkspacePath = getCurrentWorkspaceFolder().uri.fsPath;
        if (currWorkspacePath) {
            return this.executables.get(currWorkspacePath);
        } else {
            return this.executables.get(vscode.window.activeTextEditor.document.uri.fsPath);
        }
    }

    /**
     * @description
     * Set the R executable associated with a given workspace folder.
     * @param {string} folder
     * @param {RExecutable} executable
     * @memberof RExecutableService
     */
    public setWorkspaceExecutable(folder: string, executable: RExecutable): void {
        if (this.executables.get(folder) !== executable) {
            const workspaceFolderUri = vscode.Uri.file(folder);
            this.workspaceEmitter.fire({ workingFolder: vscode.workspace.getWorkspaceFolder(workspaceFolderUri), executable: executable });
            storeExecutable(executable.rBin, folder);
        }
        this.executables.set(folder, executable);
        this.executableEmitter.fire(executable);
    }

    /**
     * @description
     * Get the R executable associated with a given workspace folder.
     * @param {string} folder
     * @returns {*}  {RExecutable}
     * @memberof RExecutableService
     */
    public getWorkspaceExecutable(folder: string): RExecutable {
        return this.executables.get(folder);
    }

    /**
     * @description
     * An event that is fired whenever the active executable changes.
     * This can occur, for instance, when changing focus between multi-root workspaces.
     * @readonly
     * @type {vscode.Event<RExecutable>}
     * @memberof RExecutableService
     */
    public get onDidChangeActiveExecutable(): vscode.Event<RExecutable> {
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
