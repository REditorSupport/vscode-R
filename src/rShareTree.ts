import * as vscode from 'vscode';
import { isLiveShare } from './rShare';
import { config } from './util';

export let forwardCommands: boolean;
export let shareWorkspace: boolean;
export let autoShareBrowser: boolean;
export let rLiveShareProvider: ShareTreeProvider;

export function initTreeView(): void {
    // get default bool values from settings
    shareWorkspace = config().get('liveShare.shareWorkspaceDefault');
    forwardCommands = config().get('liveShare.commandForwardDefault');
    autoShareBrowser = config().get('liveShare.shareBrowserDefault');

    // create tree view for host controls
    rLiveShareProvider = new ShareTreeProvider();
    void vscode.window.registerTreeDataProvider(
        'rLiveShare',
        rLiveShareProvider
    );
}

export class ShareTreeProvider implements vscode.TreeDataProvider<Node> {
    private _onDidChangeTreeData: vscode.EventEmitter<void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Node): vscode.TreeItem {
        return element;
    }

    // If a node needs to be collapsible,
    // change the element condition & return value
    async getChildren(element?: Node): Promise<Node[]> {
        if (element) {
            return;
        } else {
            return await this.getNodes();
        }
    }

    // To add a tree item to the LiveShare R view,
    // write a class object that extends Node and
    // add it to the list of nodes here
    private async getNodes(): Promise<Node[]> {
        let items: Node[] = undefined;
        if (await isLiveShare()) {
            items = [
                new ShareNode(),
                new CommandNode(),
                new PortNode()
            ];
        }

        return items;
    }
}

// Base class for adding to
abstract class Node extends vscode.TreeItem {
    public label: string;
    public tooltip: string;
    public contextValue: string;
    public description: string;
    public iconPath: vscode.ThemeIcon;
    public collapsibleState: vscode.TreeItemCollapsibleState;

    constructor() {
        super('');
    }
}

// Class for any tree item that should have a toggleable state
// To implement a ToggleNode, in the super, provide a boolean
// that is used for tracking state.
// If a toggle is not required, extend a different Node type.
export abstract class ToggleNode extends Node {
    public toggle(treeProvider: ShareTreeProvider): void { treeProvider.refresh(); }
    public label: string;
    public tooltip: string;
    public contextValue: string;
    public description: string;
    public iconPath: vscode.ThemeIcon;
    public collapsibleState: vscode.TreeItemCollapsibleState;

    constructor(bool: boolean) {
        super();
        this.description = bool === true ? 'Enabled' : 'Disabled';
    }

}

/// Nodes for changing R LiveShare variables
class ShareNode extends ToggleNode {
    toggle(treeProvider: ShareTreeProvider): void {
        shareWorkspace = !shareWorkspace;
        this.description = shareWorkspace === true ? 'Enabled' : 'Disabled';
        treeProvider.refresh();
    }

    public label: string = 'Share R Workspace';
    public tooltip: string = 'Whether guests can access the current R session and its workspace';
    public contextValue: string = 'shareNode';
    public description: string;
    public iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('broadcast');
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None;

    constructor() {
        super(shareWorkspace);
    }
}

class CommandNode extends ToggleNode {
    toggle(treeProvider: ShareTreeProvider): void {
        forwardCommands = !forwardCommands;
        this.description = forwardCommands === true ? 'Enabled' : 'Disabled';
        treeProvider.refresh();
    }

    public label: string = 'Forward guest commands';
    public tooltip: string = 'Whether R commands should be forwarded from the guest to the host terminal (bypasses terminal permissions)';
    public contextValue: string = 'commandNode';
    public iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('debug-step-over');
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None;

    constructor() {
        super(forwardCommands);
    }
}

class PortNode extends ToggleNode {
    toggle(treeProvider: ShareTreeProvider): void {
        autoShareBrowser = !autoShareBrowser;
        this.description = autoShareBrowser === true ? 'Enabled' : 'Disabled';
        treeProvider.refresh();
    }

    public label: string = 'Auto share ports';
    public tooltip: string = 'Whether opened R browsers should be shared with guests';
    public contextValue: string = 'portNode';
    public iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('plug');
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None;

    constructor() {
        super(autoShareBrowser);
    }
}
