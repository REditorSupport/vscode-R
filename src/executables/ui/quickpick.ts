import path = require('path');
import * as vscode from 'vscode';

import { ExecutableNotifications } from '.';
import { validateRExecutablePath } from '..';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry, isMultiRoot } from '../../util';
import { isVirtual, ExecutableType } from '../service';
import { RExecutableService } from '../service';
import { getRenvVersion } from '../service/renv';

class ExecutableQuickPickItem implements vscode.QuickPickItem {
    public recommended: boolean;
    public category: string;
    public label: string;
    public description: string;
    public detail?: string;
    public picked?: boolean;
    public alwaysShow?: boolean;
    private _executable: ExecutableType;

    constructor(executable: ExecutableType, recommended: boolean) {
        this._executable = executable;
        this.description = executable.rBin;

        if (isVirtual(executable)) {
            this.category = 'Virtual';
        } else {
            this.category = 'Global';
        }

        this.recommended = recommended;

        if (recommended) {
            this.label = `$(star) ${executable.tooltip}`;
        } else {
            this.label = executable.tooltip;
        }
    }

    public get executable(): ExecutableType {
        return this._executable;
    }

}

enum PathQuickPickMenu {
    search = '$(plus) Enter R binary path...',
    configuration = '$(settings-gear) Configuration path'
}

export class ExecutableQuickPick implements vscode.Disposable {
    private readonly service: RExecutableService;
    private quickpick: vscode.QuickPick<vscode.QuickPickItem>;
    private currentFolder: vscode.WorkspaceFolder;

    public constructor(service: RExecutableService) {
        this.service = service;
        this.currentFolder = getCurrentWorkspaceFolder();
    }

    public dispose(): void {
        this.quickpick.dispose();
    }

    private setItems(): void {
        const qpItems: vscode.QuickPickItem[] = [];
        const configPath = config().get<string>(getRPathConfigEntry());
        const sortExecutables = (a: ExecutableType, b: ExecutableType) => {
            return -a.rVersion.localeCompare(b.rVersion, undefined, { numeric: true, sensitivity: 'base' });
        };
        qpItems.push(
            {
                label: PathQuickPickMenu.search,
                alwaysShow: true,
                picked: false
            }
        );
        if (configPath) {
            qpItems.push({
                label: PathQuickPickMenu.configuration,
                alwaysShow: true,
                description: configPath,
                detail: validateRExecutablePath(configPath) ? '' : 'Invalid R folder',
                picked: false
            });
        }

        const renvVersion = getRenvVersion(this.currentFolder.uri.fsPath) ?? undefined;
        const recommendedItems: vscode.QuickPickItem[] = [
            {
                label: 'Recommended',
                kind: vscode.QuickPickItemKind.Separator
            }
        ];
        const virtualItems: vscode.QuickPickItem[] = [
            {
                label: 'Virtual',
                kind: vscode.QuickPickItemKind.Separator
            }
        ];
        const globalItems: vscode.QuickPickItem[] = [
            {
                label: 'Global',
                kind: vscode.QuickPickItemKind.Separator
            }
        ];

        [...this.service.executables].sort(sortExecutables).forEach((v) => {
            const item = new ExecutableQuickPickItem(v, recommendPath(v, this.currentFolder, renvVersion));
            if (item.recommended) {
                recommendedItems.push(item);
            } else {
                switch (item.category) {
                    case 'Virtual': {
                        virtualItems.push(item);
                        break;
                    }
                    case 'Global': {
                        globalItems.push(item);
                        break;
                    }
                }
            }
        });


        this.quickpick.items = [...qpItems, ...recommendedItems, ...virtualItems, ...globalItems];
        for (const item of this.quickpick.items) {
            if (item.description === this.service.getWorkspaceExecutable(this.currentFolder?.uri?.fsPath)?.rBin) {
                this.quickpick.activeItems = [item];
            }
        }
    }

    /**
     * @description
     * Basic display of the quickpick is:
     *    - Manual executable selection
     *    - Configuration path (may be hidden)
     *    - Recommended paths (may be hidden)
     *    - Virtual paths
     *    - Global paths
     * @returns {*}  {Promise<void>}
     * @memberof ExecutableQuickPick
     */
    public async showQuickPick(): Promise<void> {
        const setupQuickpickOpts = () => {
            this.quickpick = vscode.window.createQuickPick();
            this.quickpick.title = 'Select R executable path';
            this.quickpick.canSelectMany = false;
            this.quickpick.ignoreFocusOut = true;
            this.quickpick.matchOnDescription = true;
            this.quickpick.buttons = [
                { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear stored path' },
                { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh paths' }
            ];
        };

        const setupQuickpickListeners = (resolver: () => void) => {
            this.quickpick.onDidTriggerButton(async (item: vscode.QuickInputButton) => {
                if (item.tooltip === 'Refresh paths') {
                    await this.service.executablePathLocator.refreshPaths();
                    this.setItems();
                    this.quickpick.show();
                } else {
                    this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, undefined);
                    this.quickpick.hide();
                }
            });
            this.quickpick.onDidChangeSelection((items: vscode.QuickPickItem[]) => {
                const qpItem = items[0];
                if (qpItem.label) {
                    switch (qpItem.label) {
                        case PathQuickPickMenu.search: {
                            const opts: vscode.OpenDialogOptions = {
                                canSelectFiles: true,
                                canSelectFolders: false,
                                canSelectMany: false,
                                title: ' R executable file'
                            };
                            void vscode.window.showOpenDialog(opts).then((epath) => {
                                const execPath = path.normalize(epath?.[0].fsPath);
                                if (execPath && validateRExecutablePath(execPath)) {
                                    const rExec = this.service.executableFactory.create(execPath);
                                    this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, rExec);
                                } else {
                                    void vscode.window.showErrorMessage(ExecutableNotifications.badFolder);
                                    this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, undefined);
                                }
                            });
                            break;
                        }
                        case PathQuickPickMenu.configuration: {
                            const configPath = config().get<string>(getRPathConfigEntry());
                            if (configPath && validateRExecutablePath(configPath)) {
                                const rExec = this.service.executableFactory.create(configPath);
                                this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, rExec);
                            } else {
                                void vscode.window.showErrorMessage(ExecutableNotifications.badConfig);
                                this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, undefined);
                            }
                            break;
                        }
                        default: {
                            this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, (qpItem as ExecutableQuickPickItem).executable);
                            break;
                        }
                    }
                }
                this.quickpick.hide();
                resolver();
            });
        };

        return await new Promise((res) => {
            setupQuickpickOpts();
            setupQuickpickListeners(res);
            void showWorkspaceFolderQP().then((folder: vscode.WorkspaceFolder) => {
                this.currentFolder = folder;
                const currentExec = this.service.getWorkspaceExecutable(folder?.uri?.fsPath);
                if (currentExec) {
                    this.quickpick.placeholder = `Current path: ${currentExec.rBin}`;
                } else {
                    this.quickpick.placeholder = '';
                }
                this.setItems();
                this.quickpick.show();
            });
        });
    }
}

async function showWorkspaceFolderQP(): Promise<vscode.WorkspaceFolder | undefined> {
    const opts: vscode.WorkspaceFolderPickOptions = {
        ignoreFocusOut: true,
        placeHolder: 'Select a workspace folder to define an R path for'
    };
    const currentDocument = vscode?.window?.activeTextEditor?.document?.uri;
    if (isMultiRoot()) {
        const workspaceFolder = await vscode.window.showWorkspaceFolderPick(opts);
        if (workspaceFolder) {
            return workspaceFolder;
        } else if (currentDocument) {
            return {
                index: 0,
                uri: currentDocument,
                name: 'untitled'
            };
        }
    }

    if (currentDocument) {
        const folder = vscode.workspace.getWorkspaceFolder(currentDocument);
        if (folder) {
            return folder;
        } else {
            return {
                index: 0,
                uri: currentDocument,
                name: 'untitled'
            };
        }
    }

    return undefined;
}

function recommendPath(executable: ExecutableType, workspaceFolder: vscode.WorkspaceFolder, renvVersion?: string): boolean {
    if (renvVersion) {
        const compatibleBin = renvVersion === executable.rVersion;
        if (compatibleBin) {
            return true;
        }

    }
    const uri = vscode.Uri.file(executable.rBin);
    const possibleWorkspace = vscode.workspace.getWorkspaceFolder(uri);
    return !!possibleWorkspace && possibleWorkspace === workspaceFolder;
}