'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window, ThemeIcon } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { workspaceData, workingDir, WorkspaceData, GlobalEnv, globalPipePath, sessionRequest } from './session';
import { config } from './util';
import { extensionContext, globalRHelp } from './extension';
import { PackageNode } from './helpViewer/treeView';

const collapsibleTypes: string[] = [
    'list',
    'environment',
    'pairlist',
    'S4'
];

interface WorkspaceChild {
    str: string;
    class: string;
    type: string;
    has_children: boolean;
    selector?: WorkspaceSelector;
}

interface WorkspaceSelector {
    kind: 'index' | 'name' | 'slot';
    value: number | string;
}

interface WorkspaceChildPage {
    children: WorkspaceChild[];
    nextStart?: number;
}

function getFirstClass(rClass: string[] | string | undefined): string {
    return Array.isArray(rClass) ? rClass[0] : rClass ?? '';
}

async function populatePackageNodes(): Promise<void> {
    const rootNode = globalRHelp?.treeViewWrapper.helpViewProvider.rootItem;
    if (rootNode) {
        // ensure the pkgRootNode is populated.
        await rootNode.getChildren();
        await rootNode?.pkgRootNode?.getChildren();
    }
}

function getPackageNode(name: string): PackageNode | undefined {
    const rootNode = globalRHelp?.treeViewWrapper.helpViewProvider.rootItem;
    if (rootNode) {
        return rootNode?.pkgRootNode?.children?.find(node => node.label === name);
    }
}

export class WorkspaceDataProvider implements TreeDataProvider<TreeItem> {
    private readonly attachedNamespacesRootItem: TreeItem;
    private readonly loadedNamespacesRootItem: TreeItem;
    private readonly globalEnvRootItem: TreeItem;
    private readonly childPages = new Map<string, WorkspaceChildPage>();
    private readonly childPageLoads = new Set<string>();
    private childPageGeneration = 0;
    private _onDidChangeTreeData: EventEmitter<TreeItem | undefined> = new EventEmitter();

    public readonly onDidChangeTreeData: Event<TreeItem | undefined> = this._onDidChangeTreeData.event;
    public data: WorkspaceData | undefined;

    public refresh(): void {
        this.data = workspaceData;
        this.childPageGeneration++;
        this.childPages.clear();
        this.childPageLoads.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    public constructor() {
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
            }),
            vscode.commands.registerCommand(LoadMoreItem.command, async (node: LoadMoreItem) => {
                await this.loadMore(node.parent, node.start);
            })
        );

        vscode.window.registerTreeDataProvider('workspaceViewer', this);
    }

    public getTreeItem(element: TreeItem): TreeItem {
        return element;
    }

    public async getChildren(element?: TreeItem): Promise<TreeItem[]> {
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
                const page = await this.getGlobalEnvChildren(element);
                const items: TreeItem[] = page.children.map(child =>
                    new GlobalEnvItem(
                        '',
                        child.class,
                        child.str.replace(/\s+/g, ' ').trim(),
                        child.type,
                        0,
                        element.treeLevel + 1,
                        undefined,
                        child.has_children,
                        element.rootName,
                        child.selector ? [...element.objectPath, child.selector] : element.objectPath
                    )
                );
                if (page.nextStart !== undefined) {
                    items.push(new LoadMoreItem(element, page.nextStart));
                }
                return items;
            } else {
                return [];
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
            dim?: number[],
            hasChildren?: boolean
        ): GlobalEnvItem => {
            return new GlobalEnvItem(
                key,
                rClass,
                str,
                type,
                size,
                TreeLevel.Parent,
                dim,
                hasChildren,
            );
        };

        const items = globalenv ? Object.keys(globalenv).map((key) =>
            toItem(
                key,
                getFirstClass(globalenv[key].class),
                globalenv[key].str,
                globalenv[key].type,
                globalenv[key].size,
                globalenv[key].dim,
                globalenv[key].has_children,
            )) : [];

        function sortItems(a: GlobalEnvItem, b: GlobalEnvItem) {
            if (a.priority > b.priority) {
                return -1;
            } else if (a.priority < b.priority) {
                return 1;
            } else {
                return (a.label && b.label) ? a.label.localeCompare(b.label) : 0;
            }
        }

        return items.sort((a, b) => sortItems(a, b));
    }

    private getChildPageKey(element: GlobalEnvItem): string {
        return JSON.stringify([element.rootName, element.objectPath]);
    }

    private async getGlobalEnvChildren(element: GlobalEnvItem): Promise<WorkspaceChildPage> {
        const key = this.getChildPageKey(element);
        const cached = this.childPages.get(key);
        if (cached) {
            return cached;
        }

        const generation = this.childPageGeneration;
        const page = await this.requestGlobalEnvChildren(element, 1);
        if (generation === this.childPageGeneration) {
            this.childPages.set(key, page);
            return page;
        }
        return { children: [] };
    }

    private async requestGlobalEnvChildren(element: GlobalEnvItem, start: number): Promise<WorkspaceChildPage> {
        if (globalPipePath && element.rootName) {
            try {
                const response = await sessionRequest({
                    method: 'workspace_children',
                    params: {
                        name: element.rootName,
                        path: element.objectPath,
                        start,
                    },
                }) as { children?: unknown, next_start?: unknown } | undefined;
                if (response && Array.isArray(response.children)) {
                    const children = response.children.filter((child): child is WorkspaceChild =>
                        typeof child === 'object' &&
                        child !== null &&
                        'str' in child &&
                        'type' in child &&
                        'has_children' in child
                    );
                    const nextStart = typeof response.next_start === 'number' ?
                        response.next_start :
                        undefined;
                    return { children, nextStart };
                }
            } catch {
                return { children: [] };
            }
        }

        return { children: [] };
    }

    private async loadMore(parent: GlobalEnvItem, start: number): Promise<void> {
        const key = this.getChildPageKey(parent);
        const loadKey = `${key}:${start}`;
        if (this.childPageLoads.has(loadKey)) {
            return;
        }

        this.childPageLoads.add(loadKey);
        const generation = this.childPageGeneration;
        try {
            const current = this.childPages.get(key) ?? { children: [] };
            const next = await this.requestGlobalEnvChildren(parent, start);
            if (generation !== this.childPageGeneration) {
                return;
            }
            this.childPages.set(key, {
                children: [...current.children, ...next.children],
                nextStart: next.nextStart
            });
            this._onDidChangeTreeData.fire(parent);
        } finally {
            this.childPageLoads.delete(loadKey);
        }
    }
}

class PackageItem extends TreeItem {
    public static command: string = 'r.workspaceViewer.package.showQuickPick';
    declare public label?: string;
    public name: string;
    public pkgNode?: PackageNode;
    public constructor(label: string, name: string, pkgNode?: PackageNode) {
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

class LoadMoreItem extends TreeItem {
    public static command = 'r.workspaceViewer.loadMore';

    public constructor(
        public readonly parent: GlobalEnvItem,
        public readonly start: number
    ) {
        super('...', TreeItemCollapsibleState.None);
        this.tooltip = 'Load next 500 items';
        this.iconPath = new ThemeIcon('ellipsis');
        this.command = {
            command: LoadMoreItem.command,
            title: 'Load next 500 items',
            arguments: [this]
        };
    }
}

enum TreeLevel {
    Parent = 0,
    Scalar = 1
}

export class GlobalEnvItem extends TreeItem {
    declare public label?: string;
    public treeLevel: number;
    public contextValue: string;
    public priority: number;
    public rootName: string;
    public objectPath: WorkspaceSelector[];

    constructor(
        label: string,
        rClass: string,
        str: string,
        type: string,
        size?: number,
        treeLevel?: number,
        dim?: number[],
        hasChildren?: boolean,
        rootName?: string,
        objectPath?: WorkspaceSelector[],
    ) {
        super(
            label,
            GlobalEnvItem.setCollapsibleState(type, hasChildren)
        );
        this.treeLevel = treeLevel ?? TreeLevel.Scalar;
        this.priority = dim ? 1 : 0;
        this.rootName = rootName ?? label;
        this.objectPath = objectPath ?? [];

        this.description = this.getDescription(
            dim,
            str,
            rClass,
            type
        );
        this.tooltip = this.getTooltip(label, rClass, size, treeLevel);
        this.iconPath = this.getIcon(type, dim);
        this.contextValue = treeLevel === 0 ? 'rootNode' : `childNode${this.treeLevel}`;
    }

    private getDescription(dim: number[] | undefined, str: string, rClass: string, type: string): string {
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

    private getTooltip(
        label: string,
        rClass: string,
        size?: number,
        treeLevel?: number
    ): string {
        if (size && treeLevel === TreeLevel.Parent) {
            return `${label} (${rClass}, ${this.getSizeString(size)})`;
        } else if (treeLevel === TreeLevel.Scalar) {
            return '';
        } else {
            return `${label} (${rClass})`;
        }
    }

    private getIcon(type: string, dim?: number[]): vscode.ThemeIcon {
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
    private static setCollapsibleState(
        type: string,
        hasChildren?: boolean
    ): vscode.TreeItemCollapsibleState {
        if (collapsibleTypes.includes(type) && hasChildren) {
            return TreeItemCollapsibleState.Collapsed;
        } else {
            return TreeItemCollapsibleState.None;
        }
    }
}

export function clearWorkspace(): void {
    const removeHiddenItems: boolean | undefined = config().get('workspaceViewer.removeHiddenItems');
    const promptUser: boolean | undefined = config().get('workspaceViewer.clearPrompt');

    if (workspaceData !== undefined) {
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
    if (workspaceData) {
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
    const defaultUri = workingDir ? Uri.file(workingDir) : vscode.window.activeTextEditor?.document.uri;
    void window.showOpenDialog({
        defaultUri: defaultUri,
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

export function viewItem(node: string): void {
    void runTextInTerm(`View(${node})`);
}

export function removeItem(node: string): void {
    void runTextInTerm(`rm(${node})`);
}
