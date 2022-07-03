import * as vscode from 'vscode';
import * as path from 'path';
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window, ThemeIcon } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { workspaceData, workingDir, WorkspaceData, GlobalEnv } from './session';
import { config } from './util';
import { isGuestSession, isLiveShare, UUID, guestWorkspace } from './liveShare';
import { extensionContext, globalRHelp } from './extension';
import { PackageNode } from './helpViewer/treeView';

const collapsibleTypes: string[] = [
    'list',
    'environment'
];

async function populatePackageNodes(): Promise<void> {
    const rootNode = globalRHelp?.treeViewWrapper.helpViewProvider.rootItem;
    if (rootNode) {
        // ensure the pkgRootNode is populated.
        await rootNode.getChildren();
        await rootNode.pkgRootNode.getChildren();
    }
}

function getPackageNode(name: string): PackageNode {
    const rootNode = globalRHelp?.treeViewWrapper.helpViewProvider.rootItem;
    if (rootNode) {
        return rootNode.pkgRootNode.children?.find(node => node.label === name);
    }
}

export class WorkspaceDataProvider implements TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData: EventEmitter<void> = new EventEmitter();
    readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this.data = isGuestSession ? guestWorkspace : workspaceData;
        this._onDidChangeTreeData.fire();
    }

    data: WorkspaceData;

    private readonly attachedNamespacesRootItem: TreeItem;
    private readonly loadedNamespacesRootItem: TreeItem;
    private readonly globalEnvRootItem: TreeItem;

    constructor() {
        this.attachedNamespacesRootItem = new TreeItem('Attached Namespaces', TreeItemCollapsibleState.Collapsed);
        this.attachedNamespacesRootItem.id = 'attached-namespaces';
        this.attachedNamespacesRootItem.iconPath = new ThemeIcon('library');

        this.loadedNamespacesRootItem = new TreeItem('Loaded Namespaces', TreeItemCollapsibleState.Collapsed);
        this.loadedNamespacesRootItem.id = 'loaded-namespaces';
        this.loadedNamespacesRootItem.iconPath = new ThemeIcon('package');

        this.globalEnvRootItem = new TreeItem('Global Environment', TreeItemCollapsibleState.Expanded);
        this.globalEnvRootItem.id = 'globalenv';
        this.globalEnvRootItem.iconPath = new ThemeIcon('menu');

        extensionContext.subscriptions.push(
            vscode.commands.registerCommand(PackageItem.command, async (node: PackageNode) => {
                await node.showQuickPick();
            })
        );
    }

    getTreeItem(element: TreeItem): TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (element) {
            if (this.data === undefined) {
                return [];
            }
            const pkgPrefix = 'package:';
            if (element.id === 'attached-namespaces') {
                await populatePackageNodes();
                return this.data.search.map(name => {
                    if (name.startsWith(pkgPrefix)) {
                        const pkgName = name.substring(pkgPrefix.length);
                        const pkgNode = getPackageNode(pkgName);
                        return new PackageItem(name, pkgName, pkgNode);
                    } else {
                        const item = new TreeItem(name, TreeItemCollapsibleState.None);
                        item.iconPath = new ThemeIcon('symbol-array');
                        return item;
                    }
                });
            } else if (element.id === 'loaded-namespaces') {
                await populatePackageNodes();
                const attached_packages = this.data.search
                    .filter(name => name.startsWith(pkgPrefix))
                    .map(name => name.substring(pkgPrefix.length));
                return this.data.loaded_namespaces.map(name => {
                    const pkgNode = getPackageNode(name);
                    const item = new PackageItem(name, name, pkgNode);
                    if (attached_packages.includes(name)) {
                        item.description = 'attached';
                    }
                    return item;
                });
            } else if (element.id === 'globalenv') {
                return this.getGlobalEnvItems(this.data.globalenv);
            } else if (element instanceof GlobalEnvItem) {
                return element.str
                    .split('\n')
                    .filter((elem, index) => { return index > 0; })
                    .map(strItem =>
                        new GlobalEnvItem(
                            '',
                            '',
                            strItem.replace(/\s+/g, ' ').trim(),
                            '',
                            0,
                            element.treeLevel + 1
                        )
                    );
            }
        } else {
            const treeItems = [this.attachedNamespacesRootItem, this.loadedNamespacesRootItem];
            if (config().get<boolean>('session.watchGlobalEnvironment')) {
                treeItems.push(this.globalEnvRootItem);
            }
            return treeItems;
        }
    }

    private getGlobalEnvItems(globalenv: GlobalEnv): GlobalEnvItem[] {
        const toItem = (
            key: string,
            rClass: string,
            str: string,
            type: string,
            size?: number,
            dim?: number[]
        ): GlobalEnvItem => {
            return new GlobalEnvItem(
                key,
                rClass,
                str,
                type,
                size,
                0,
                dim,
            );
        };

        const items = globalenv ? Object.keys(globalenv).map((key) =>
            toItem(
                key,
                globalenv[key].class[0],
                globalenv[key].str,
                globalenv[key].type,
                globalenv[key].size,
                globalenv[key].dim,
            )) : [];

        function sortItems(a: GlobalEnvItem, b: GlobalEnvItem) {
            if (a.priority > b.priority) {
                return -1;
            } else if (a.priority < b.priority) {
                return 1;
            } else {
                return 0 || a.label.localeCompare(b.label);
            }
        }

        return items.sort((a, b) => sortItems(a, b));
    }
}

class PackageItem extends TreeItem {
    static command : string = 'r.workspaceViewer.package.showQuickPick';
    label: string;
    name: string;
    pkgNode?: PackageNode;
    constructor(label: string, name: string, pkgNode?: PackageNode) {
        super(label, TreeItemCollapsibleState.None);
        this.name = name;
        this.iconPath = new ThemeIcon('symbol-package');
        this.pkgNode = pkgNode;
        if (pkgNode) {
            this.tooltip = new vscode.MarkdownString(pkgNode.pkg.description);
            this.command = {
                command: PackageItem.command,
                title: 'Show Quick Pick',
                arguments: [pkgNode]
            };
        }
    }
}

export class GlobalEnvItem extends TreeItem {
    label: string;
    desc: string;
    str: string;
    type: string;
    treeLevel: number;
    contextValue: string;
    priority: number;

    constructor(
        label: string,
        rClass: string,
        str: string,
        type: string,
        size: number,
        treeLevel: number,
        dim?: number[],
    ) {
        super(label, GlobalEnvItem.setCollapsibleState(treeLevel, type, str));
        this.description = this.getDescription(dim, str, rClass, type);
        this.tooltip = this.getTooltip(label, rClass, size, treeLevel);
        this.iconPath = this.getIcon(type, dim);
        this.type = type;
        this.str = str;
        this.treeLevel = treeLevel;
        this.contextValue = treeLevel === 0 ? 'rootNode' : `childNode${treeLevel}`;
        this.priority = dim ? 1 : 0;
    }

    private getDescription(dim: number[], str: string, rClass: string, type: string): string {
        if (dim && type === 'list') {
            if (dim[1] === 1) {
                return `${rClass}: ${dim[0]} obs. of ${dim[1]} variable`;
            } else {
                return `${rClass}: ${dim[0]} obs. of ${dim[1]} variables`;
            }
        } else {
            return str;
        }
    }

    private getSizeString(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} bytes`;
        } else {
            const e = Math.floor(Math.log(bytes) / Math.log(1024));
            return (bytes / Math.pow(1024, e)).toFixed(0) + 'KMGTP'.charAt(e - 1) + 'b';
        }
    }

    private getTooltip(label:string, rClass: string,
                size: number, treeLevel: number): string {
        if (size !== undefined && treeLevel === 0) {
            return `${label} (${rClass}, ${this.getSizeString(size)})`;
        } else if (treeLevel === 1) {
            return null;
        } else {
            return `${label} (${rClass})`;
        }
    }

    private getIcon(type: string, dim?: number[]) {
        let name: string;
        if (dim) {
            name = 'symbol-array';
        } else if (type === 'closure' || type === 'builtin') {
            name = 'symbol-function';
        } else if (type === '') {
            name = 'symbol-variable';
        } else {
            name = 'symbol-field';
        }
        return new ThemeIcon(name);
    }

    /* This logic has to be implemented this way to allow it to be called
    during the super constructor above. I created it to give full control
    of what elements can have have 'child' nodes os not. It can be expanded
    in the futere for more tree levels.*/

    private static setCollapsibleState(treeLevel: number, type: string, str: string) {
        if (treeLevel === 0 && collapsibleTypes.includes(type) && str.includes('\n')){
            return TreeItemCollapsibleState.Collapsed;
        } else {
            return TreeItemCollapsibleState.None;
        }
    }
}

export function clearWorkspace(): void {
    const removeHiddenItems: boolean = config().get('workspaceViewer.removeHiddenItems');
    const promptUser: boolean = config().get('workspaceViewer.clearPrompt');

    if ((isGuestSession ? guestWorkspace : workspaceData) !== undefined) {
        if (promptUser) {
            void window.showInformationMessage(
                'Are you sure you want to clear the workspace? This cannot be reversed.',
                'Confirm',
                'Cancel'
            ).then(selection => {
                if (selection === 'Confirm') {
                    clear();
                }
            });
        } else {
            clear();
        }
    }

    function clear() {
        const hiddenText = 'rm(list = ls(all.names = TRUE))';
        const text = 'rm(list = ls())';
        if (removeHiddenItems) {
            void runTextInTerm(`${hiddenText}`);
        } else {
            void runTextInTerm(`${text}`);
        }
    }
}

export function saveWorkspace(): void {
    if (workspaceData !== undefined) {
        void window.showSaveDialog({
            defaultUri: Uri.file(path.join(workingDir, 'workspace.RData')),
            filters: {
                'RData': ['RData']
            },
            title: 'Save Workspace'
        }
        ).then(async (uri: Uri | undefined) => {
            if (uri) {
                return runTextInTerm(
                    `save.image("${(uri.fsPath.split(path.sep).join(path.posix.sep))}")`
                );
            }
        });
    }
}

export function loadWorkspace(): void {
    if (workspaceData !== undefined) {
        void window.showOpenDialog({
            defaultUri: Uri.file(workingDir),
            filters: {
                'Data': ['RData'],
            },
            title: 'Load workspace'
        }).then(async (uri: Uri[] | undefined) => {
            if (uri) {
                const savePath = uri[0].fsPath.split(path.sep).join(path.posix.sep);
                return runTextInTerm(
                    `load("${(savePath)}")`
                );
            }
        });
    }
}

export function viewItem(node: string): void {
    if (isLiveShare()) {
        void runTextInTerm(`View(${node}, uuid = ${UUID})`);
    } else {
        void runTextInTerm(`View(${node})`);
    }
}

export function removeItem(node: string): void {
    void runTextInTerm(`rm(${node})`);
}
