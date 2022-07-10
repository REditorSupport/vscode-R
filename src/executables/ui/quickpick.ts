import * as vscode from 'vscode';

import { ExecutableNotifications } from '.';
import { validateRExecutablePath } from '..';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry } from '../../util';
import { isVirtual, ExecutableType } from '../service';
import { RExecutableService } from '../service';

class ExecutableQuickPickItem implements vscode.QuickPickItem {
    public label: string;
    public description: string;
    public detail?: string;
    public picked?: boolean;
    public alwaysShow?: boolean;
    private _executable: ExecutableType;

    constructor(executable: ExecutableType) {
        this._executable = executable;
        this.label = executable.tooltip;
        this.description = executable.rBin;
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
    private currentFolder: string;

    public constructor(service: RExecutableService) {
        this.service = service;
        this.currentFolder = getCurrentWorkspaceFolder().uri.fsPath;
    }

    public dispose(): void {
        this.quickpick.dispose();
    }

    private setItems(): void {
        function sortBins(bins: ExecutableType[]) {
            return bins.sort((a, b) => {
                if (!isVirtual(a) && isVirtual(b)) {
                    return 1;
                } else if (!isVirtual(b) && isVirtual(a)) {
                    return -1;
                } else {
                    return a.rVersion.localeCompare(b.rVersion, undefined, { numeric: true, sensitivity: 'base' });
                }
            });
        }
        const qpItems: vscode.QuickPickItem[] = [];
        const configPath = config().get<string>(getRPathConfigEntry());
        qpItems.push(
            {
                label: PathQuickPickMenu.search,
                alwaysShow: true,
                picked: false
            },
            {
                label: PathQuickPickMenu.configuration,
                alwaysShow: true,
                description: configPath,
                detail: validateRExecutablePath(configPath) ? '' : 'Invalid R folder',
                picked: false
            }
        );

        sortBins([...this.service.executables]).forEach((bin: ExecutableType) => {
            qpItems.push(new ExecutableQuickPickItem(bin));
        });

        this.quickpick.items = qpItems;

        for (const item of this.quickpick.items) {
            if (item.description === this.service.getWorkspaceExecutable(this.currentFolder)?.rBin) {
                this.quickpick.activeItems = [item];
            }
        }
    }

    public async showQuickPick(): Promise<void> {
        function setupQuickpickOpts(self: ExecutableQuickPick): void {
            self.quickpick = vscode.window.createQuickPick();
            self.quickpick.title = 'Select R executable path';
            self.quickpick.canSelectMany = false;
            self.quickpick.ignoreFocusOut = true;
            self.quickpick.matchOnDescription = true;
            self.quickpick.placeholder = '';
            self.quickpick.buttons = [
                { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear stored path' },
                { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh paths' }
            ];
        }

        function setupQuickpickListeners(self: ExecutableQuickPick, resolver: () => void): void {
            self.quickpick.onDidTriggerButton((item: vscode.QuickInputButton) => {
                if (item.tooltip === 'Refresh paths') {
                    self.service.executablePathLocator.refreshPaths();
                    self.setItems();
                    self.quickpick.show();
                } else {
                    self.service.setWorkspaceExecutable(self.currentFolder, undefined);
                    self.quickpick.hide();
                }
            });
            self.quickpick.onDidChangeSelection((items: vscode.QuickPickItem[]) => {
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
                            void vscode.window.showOpenDialog(opts).then((execPath) => {
                                if (validateRExecutablePath(execPath[0].fsPath)) {
                                    const rExec = self.service.executableFactory.create(execPath[0].fsPath);
                                    self.service.setWorkspaceExecutable(self.currentFolder, rExec);
                                } else {
                                    void vscode.window.showErrorMessage(ExecutableNotifications.badFolder);
                                    self.service.setWorkspaceExecutable(self.currentFolder, undefined);
                                }
                            });
                            break;
                        }
                        case PathQuickPickMenu.configuration: {
                            const configPath = config().get<string>(getRPathConfigEntry());
                            if (validateRExecutablePath(configPath)) {
                                const rExec = self.service.executableFactory.create(configPath);
                                self.service.setWorkspaceExecutable(self.currentFolder, rExec);
                            } else {
                                void vscode.window.showErrorMessage(ExecutableNotifications.badConfig);
                                self.service.setWorkspaceExecutable(self.currentFolder, undefined);
                            }
                            break;
                        }
                        default: {
                            self.service.setWorkspaceExecutable(self.currentFolder, (qpItem as ExecutableQuickPickItem).executable);
                            break;
                        }
                    }
                }
                self.quickpick.hide();
                resolver();
            });
        }

        return await new Promise((res) => {
            setupQuickpickOpts(this);
            setupQuickpickListeners(this, res);
            void showWorkspaceFolderQP().then((folder: vscode.WorkspaceFolder) => {
                this.currentFolder = folder.uri.fsPath;
                this.setItems();
                this.quickpick.show();
            });
        });
    }
}

async function showWorkspaceFolderQP() {
    const opts: vscode.WorkspaceFolderPickOptions = {
        ignoreFocusOut: true,
        placeHolder: 'Select a workspace folder to define an R path for'
    };
    if (vscode.workspace.workspaceFolders.length > 1) {
        return await vscode.window.showWorkspaceFolderPick(opts);
    } else {
        return vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    }
}