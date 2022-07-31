import path = require('path');
import * as vscode from 'vscode';

import { validateRExecutablePath } from '..';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry, isMultiRoot } from '../../util';
import { isVirtual, ExecutableType } from '../service';
import { RExecutableService } from '../service';
import { getRenvVersion } from '../virtual';
import { extensionContext } from '../../extension';

enum ExecutableNotifications {
    badFolder = 'Supplied R executable path is not a valid R path.',
    badConfig = 'Configured path is not a valid R executable path.',
    badInstallation = 'Supplied R executable cannot be launched on this operating system.'
}

enum PathQuickPickMenu {
    search = '$(add) Enter R executable path...',
    configuration = '$(settings-gear) Configuration path'
}

class ExecutableQuickPickItem implements vscode.QuickPickItem {
    public recommended: boolean;
    public category: string;
    public label: string;
    public description: string;
    public detail?: string;
    public picked?: boolean;
    public alwaysShow?: boolean;
    public active: boolean;
    private _executable: ExecutableType;

    constructor(executable: ExecutableType, service: RExecutableService, workspaceFolder: vscode.WorkspaceFolder, renvVersion?: string) {
        this._executable = executable;
        this.description = executable.rBin;
        this.recommended = recommendPath(executable, workspaceFolder, renvVersion);

        if (isVirtual(executable)) {
            this.category = 'Virtual';
        } else {
            this.category = 'Global';
        }

        if (this.recommended) {
            this.label = `$(star-full) ${executable.tooltip}`;
        } else {
            this.label = executable.tooltip;
        }

        if (service.getWorkspaceExecutable(workspaceFolder?.uri?.fsPath)?.rBin === executable.rBin) {
            this.label = `$(indent) ${this.label}`;
            this.active = true;
        }

    }

    public get executable(): ExecutableType {
        return this._executable;
    }

}

export class ExecutableQuickPick {
    private readonly service: RExecutableService;
    private quickpick: vscode.QuickPick<vscode.QuickPickItem | ExecutableQuickPickItem>;
    private currentFolder: vscode.WorkspaceFolder;

    public constructor(service: RExecutableService) {
        this.service = service;
        this.currentFolder = getCurrentWorkspaceFolder();
        extensionContext.subscriptions.push(this.quickpick);
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

        [...this.service.executables].sort(sortExecutables).forEach((executable) => {
            const quickPickItem = new ExecutableQuickPickItem(
                executable,
                this.service,
                this.currentFolder,
                renvVersion
            );
            if (quickPickItem.recommended) {
                recommendedItems.push(quickPickItem);
            } else {
                switch (quickPickItem.category) {
                    case 'Virtual': {
                        virtualItems.push(quickPickItem);
                        break;
                    }
                    case 'Global': {
                        globalItems.push(quickPickItem);
                        break;
                    }
                }
            }
        });


        this.quickpick.items = [...qpItems, ...recommendedItems, ...virtualItems, ...globalItems];
        for (const quickPickItem of this.quickpick.items) {
            if ((quickPickItem as ExecutableQuickPickItem)?.active) {
                this.quickpick.activeItems = [quickPickItem];
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
                    this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, null);
                    this.quickpick.hide();
                }
            });
            this.quickpick.onDidChangeSelection((items: vscode.QuickPickItem[] | ExecutableQuickPickItem[]) => {
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
                            void vscode.window.showOpenDialog(opts).then((epath: vscode.Uri[]) => {
                                if (epath) {
                                    const execPath = path.normalize(epath?.[0].fsPath);
                                    if (execPath && validateRExecutablePath(execPath)) {
                                        const rExec = this.service.executableFactory.create(execPath);
                                        this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, rExec);
                                    } else {
                                        void vscode.window.showErrorMessage(ExecutableNotifications.badFolder);
                                        this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, null);
                                    }
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
                                this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, null);
                            }
                            break;
                        }
                        default: {
                            const executable = (qpItem as ExecutableQuickPickItem).executable;
                            if (executable?.rVersion) {
                                this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, executable);
                            } else {
                                void vscode.window.showErrorMessage(ExecutableNotifications.badInstallation);
                                this.service.setWorkspaceExecutable(this.currentFolder?.uri?.fsPath, null);
                            }
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