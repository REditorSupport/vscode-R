import * as vscode from 'vscode';

import { ExecutableNotifications } from '.';
import { validateRFolder } from '..';
import { config, getCurrentWorkspaceFolder, getRPathConfigEntry } from '../../util';
import { RExecutable, RExecutableFactory, VirtualRExecutable } from '../executable';
import { AbstractLocatorService } from '../locator';
import { RExecutableService } from '../service';


const confRpath = () => {
    return config().get<string>(getRPathConfigEntry());
};

class ExecutableQuickPickItem implements vscode.QuickPickItem {
    public label: string;
    public description: string;
    public detail?: string;
    public picked?: boolean;
    public alwaysShow?: boolean;

    private _executable: RExecutable = undefined;

    constructor(executable: RExecutable) {
        this._executable = executable;
        this.label = executable.tooltip;
        this.description = executable.rBin;
    }

    public get executable(): RExecutable {
        return this._executable;
    }

}

enum PathQuickPickMenu {
    search = '$(plus) Enter R binary path...',
    configuration = '$(settings-gear) Configuration path'
}

export class ExecutableQuickPick implements vscode.Disposable {
    private qp: vscode.QuickPick<vscode.QuickPickItem>;
    private retriever: AbstractLocatorService;
    private service: RExecutableService;
    private currentFolder: string;

    public constructor(service: RExecutableService, retriever: AbstractLocatorService) {
        this.service = service;
        this.retriever = retriever;
        this.currentFolder = getCurrentWorkspaceFolder().uri.fsPath;
    }

    public dispose(): void {
        this.qp.dispose();
    }

    private setItems(): void {
        function sortBins(bins: RExecutable[]) {
            return bins.sort((a, b) => {
                if (a instanceof RExecutable && b instanceof VirtualRExecutable) {
                    return 1;
                } else if (b instanceof RExecutable && a instanceof VirtualRExecutable) {
                    return -1;
                } else {
                    return a.rVersion.localeCompare(b.rVersion, undefined, { numeric: true, sensitivity: 'base' });
                }
            });
        }
        const qpItems: vscode.QuickPickItem[] = [];
        const executables: RExecutable[] = [];
        const configPath = confRpath();
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
                detail: validateRFolder(configPath) ? '' : 'Invalid R folder',
                picked: false
            }
        );

        this.retriever.binaryPaths.forEach(home => {
            if (validateRFolder(home)) {
                executables.push(this.retriever.executables.filter(exec => exec.rBin === home)?.[0]);
            }
        });
        sortBins(executables).forEach((bin: RExecutable) => {
            qpItems.push(new ExecutableQuickPickItem(bin));
        });

        this.qp.items = qpItems;
        for (const item of this.qp.items) {
            if (item.description === this.service.getWorkspaceExecutable(this.currentFolder)?.rBin) {
                this.qp.activeItems = [item];
            }
        }
    }

    public async showQuickPick(): Promise<void> {
        function setupQuickpickOpts(self: ExecutableQuickPick): void {
            self.qp = vscode.window.createQuickPick();
            self.qp.title = 'Select R executable path';
            self.qp.canSelectMany = false;
            self.qp.ignoreFocusOut = true;
            self.qp.matchOnDescription = true;
            self.qp.placeholder = '';
            self.qp.buttons = [
                { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear stored path' },
                { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh paths' }
            ];
        }

        function setupQuickpickListeners(self: ExecutableQuickPick, resolver: () => void): void {
            self.qp.onDidTriggerButton((item: vscode.QuickInputButton) => {
                if (item.tooltip === 'Refresh paths') {
                    self.retriever.refreshPaths();
                    self.setItems();
                    self.qp.show();
                } else {
                    self.service.setWorkspaceExecutable(self.currentFolder, null);
                    self.qp.hide();
                }
            });
            self.qp.onDidChangeSelection((items: vscode.QuickPickItem[]) => {
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
                            void vscode.window.showOpenDialog(opts).then((exec_path) => {
                                if (validateRFolder(exec_path[0].fsPath)) {
                                    const rExec = RExecutableFactory.createExecutable(exec_path[0].fsPath);
                                    self.service.setWorkspaceExecutable(self.currentFolder, rExec);
                                } else {
                                    void vscode.window.showErrorMessage(ExecutableNotifications.badFolder);
                                    self.service.setWorkspaceExecutable(self.currentFolder, null);
                                }
                            });
                            break;
                        }
                        case PathQuickPickMenu.configuration: {
                            if (validateRFolder(confRpath())) {
                                const rExec = RExecutableFactory.createExecutable(confRpath());
                                self.service.setWorkspaceExecutable(self.currentFolder, rExec);
                            } else {
                                void vscode.window.showErrorMessage(ExecutableNotifications.badConfig);
                                self.service.setWorkspaceExecutable(self.currentFolder, null);
                            }
                            break;
                        }
                        default: {
                            self.service.setWorkspaceExecutable(self.currentFolder, (qpItem as ExecutableQuickPickItem).executable);
                            break;
                        }
                    }
                }
                self.qp.hide();
                resolver();
            });
        }

        return await new Promise((res) => {
            setupQuickpickOpts(this);
            setupQuickpickListeners(this, res);
            void showWorkspaceFolderQP().then((folder: vscode.WorkspaceFolder) => {
                this.currentFolder = folder.uri.fsPath;
                this.setItems();
                this.qp.show();
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