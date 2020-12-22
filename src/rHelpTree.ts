/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-inferrable-types */

import * as vscode from 'vscode';

import { globalRHelp, RHelp } from './rHelp';
import { Package, Topic, TopicType } from './rHelpPackages';


// type QuickPickAction = 'runCommand'|'openPath'|'showChildren';
const CollapsibleState = vscode.TreeItemCollapsibleState;

const nodeCommands = {
    QUICKPICK: 'r.helpPanel.showQuickPick',
    CALLBACK: 'r.helpPanel.internalCallback', // called when the item is clicked and node.command is not null
    searchPackage: 'r.helpPanel.searchPackage',
    openInNewPanel: 'r.helpPanel.openInNewPanel',
    clearCache: 'r.helpPanel.clearCache',
    removeFromFavorites: 'r.helpPanel.removeFromFavorites',
    addToFavorites: 'r.helpPanel.addToFavorites',
    removePackage: 'r.helpPanel.removePackage',
    showOnlyFavorites: 'r.helpPanel.showOnlyFavorites',
    showAllPackages: 'r.helpPanel.showAllPackages',
    filterPackages: 'r.helpPanel.filterPackages',
    summarizeTopics: 'r.helpPanel.summarizeTopics',
    unsummarizeTopics: 'r.helpPanel.unsummarizeTopics'
};

type cmdName = keyof typeof nodeCommands;



export class HelpTreeWrapper {
    public rHelp: RHelp;
    public helpView: vscode.TreeView<Node>;
    public helpViewProvider: HelpViewProvider;

    constructor(rHelp: RHelp){
        this.rHelp = rHelp;
        this.helpViewProvider = new HelpViewProvider(this);
        this.helpView = vscode.window.createTreeView(
            'rHelpPages',
            {
                treeDataProvider: this.helpViewProvider,
                showCollapseAll: true
            }
        );

        for(const cmd in nodeCommands){
            vscode.commands.registerCommand(nodeCommands[cmd], (node: Node) => {
                node ||= this.helpViewProvider.rootItem;
                node.handleCommand(<cmdName>cmd);
            });
        }
    }

    refreshNode(node: Node): void {
        for(const listener of this.helpViewProvider.listeners){
            listener(node);
        }
    }
}


export class HelpViewProvider implements vscode.TreeDataProvider<Node> {
    public rootItem: RootNode;

    public listeners: ((e: Node) => void)[] = [];

    constructor(wrapper: HelpTreeWrapper){
        this.rootItem = new RootNode(wrapper);
    }

    onDidChangeTreeData(listener: (e: Node) => void): vscode.Disposable {
        this.listeners.push(listener);
        return new vscode.Disposable(() => {});
    }

    getChildren(element?: Node): Node[] | Promise<Node[]> {
        element ||= this.rootItem;
        return element.getChildren();
    }
    getTreeItem(element: Node): Node {
        return element;
    }
    getParent(element: Node): Node {
        return element.parent;
    }
}

// Abstract base class for nodes of the treeview
abstract class Node extends vscode.TreeItem{
    // TreeItem (defaults for this usecase)
    public description: string;
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None;
    public command = {
        title: 'treeNodeCallback', // is this title used anywhere?
        command: nodeCommands.CALLBACK,
        arguments: [this]
    };

    // Node
    public readonly parent: Node | undefined;
    public children?: Node[] = undefined;

    // When used in quickpick
    public showInQuickPick: boolean = true;
    public quickPickCommand: cmdName;
    public qpLabel?: string;
    public qpDetail?: string;
    public qpPrompt?: string;

    protected readonly wrapper: HelpTreeWrapper;
    protected readonly rootNode: RootNode;
    protected readonly rHelp: RHelp;

    // used to give unique ids to nodes
    static newId: number = 0;

    constructor(parent: Node, wrapper?: HelpTreeWrapper){
        super('');
        if(parent){
            wrapper ||= parent.wrapper;
            this.parent = parent;
            this.rootNode = parent.rootNode;
        }
        if(wrapper){
            this.wrapper = wrapper;
            this.rHelp = this.wrapper.rHelp;
        }
        this.id = `${Node.newId++}`;
    }

    public handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK' && this.callBack){
            this.callBack();
        } else if(cmd === 'QUICKPICK'){
            if(this.quickPickCommand){
                this._handleCommand(this.quickPickCommand);
            } else if(this.collapsibleState !== CollapsibleState.None){
                void this.showQuickPick();
            } else{
                this.handleCommand('CALLBACK');
            }
        } else {
            this._handleCommand(cmd);
        }
    }

    protected _handleCommand(cmd: cmdName){
        // to be overwritten
    }

    public callBack?(): void;

    public async showQuickPick(){
        const children = await this.makeChildren(true);
        const qpItems: (vscode.QuickPickItem & {child: Node})[] = children.map(v => {
            let label = v.label;
            if(typeof v.iconPath === 'object' && 'id' in v.iconPath){
                label = `$(${v.iconPath.id}) ${label}`;
            }
            return {
                label: v.qpLabel ?? label,
                detail: v.qpDetail ?? v.description ?? v.tooltip,
                child: v
            };
        });
        const qp = await vscode.window.showQuickPick(qpItems, {
            placeHolder: this.qpPrompt
        });
        if(qp){
            const child = qp.child;
            child.handleCommand('QUICKPICK');
        }
    }

    public async getChildren(): Promise<Node[]|null> | null {
        if(this.children === undefined){
            this.children = await this.makeChildren();
        }
        return this.children;
    }

    // to be overwritten, if the node has any children
    protected makeChildren(_forQuickPick: boolean = false): Node[] | Promise<Node[]> {
        return [];
    }

    public refresh(refreshChildren: boolean = true){
        if(refreshChildren){
            this.children = undefined;
        }
        this.wrapper.refreshNode(this);
    }

    public reveal(options?: { select?: boolean, focus?: boolean, expand?: boolean | number }){
        void this.wrapper.helpView.reveal(this, options);
    }

    static makeContextValue(...args: cmdName[]){
        return args.map(v => `_${v}_`).join('');
    }
    public addContextValues(...args: cmdName[]){
        args.forEach(val => {
            this.contextValue += `_${val}_`;
        });
        return this.contextValue;
    }
    public removeContextValues(...args: cmdName[]){
        args.forEach(val => {
            this.contextValue = this.contextValue.replace(new RegExp(`_${val}_`), '');
        });
        return this.contextValue;
    }
    public replaceContextValue(oldCmd: cmdName, newCmd: cmdName){
        this.removeContextValues(oldCmd);
        return this.addContextValues(newCmd);
    }
}

abstract class MetaNode extends Node {
    // abstract parent class nodes that don't represent packages, topics etc.
}

// Root of the node. Is not actually used as TreeItem, but as 'imaginary' root item.
class RootNode extends MetaNode {
    public collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    public label = 'root';
    public pkgRootNode: PkgRootNode;
    protected readonly rootNode = this;

    constructor(wrapper: HelpTreeWrapper){
        super(undefined, wrapper);
    }
    makeChildren(){
        this.pkgRootNode = new PkgRootNode(this);
        return [
            new HomeNode(this),
            new Search1Node(this),
            new Search2Node(this),
            new RefreshNode(this),
            new InstallPackageNode(this),
            this.pkgRootNode,
        ];
    }
    refresh(){
        this.wrapper.refreshNode(undefined);
    }
}


class PkgRootNode extends MetaNode {
    // TreeItem
    public label = 'Help Topics by Package';
    public iconPath = new vscode.ThemeIcon('list-unordered');
    public description = '';
    public command = null;
    public collapsibleState = CollapsibleState.Collapsed;
    public contextValue = Node.makeContextValue('QUICKPICK', 'clearCache', 'filterPackages', 'showOnlyFavorites', 'unsummarizeTopics');

    // Node
    public children?: PackageNode[];
    public parent: RootNode;
    // public quickPickCommand: cmdName = 'searchPackage';
    public qpPrompt = 'Please select a package.';

    // PkgRootNode
    public showOnlyFavorites: boolean = false;
    public filterText: string = '';
    public summarizeTopics: boolean = true;

    async _handleCommand(cmd: cmdName){
        if(cmd === 'clearCache'){
            this.refresh(true);
        } else if(cmd === 'showOnlyFavorites'){
            this.showOnlyFavorites = true;
            this.iconPath = new vscode.ThemeIcon('star-full');
            this.replaceContextValue('showOnlyFavorites', 'showAllPackages');
            this.refresh();
        } else if(cmd === 'showAllPackages'){
            this.showOnlyFavorites = false;
            this.iconPath = new vscode.ThemeIcon('list-unordered');
            this.replaceContextValue('showAllPackages', 'showOnlyFavorites');
            this.refresh();
        } else if(cmd === 'filterPackages'){
            // use validation function to continuously update filtered packages
            const validateInput = (value: string) => {
                this.filterText = value;
                this.refresh();
                return '';
            };
            // let user input filter text
            this.filterText = await vscode.window.showInputBox({
                validateInput: validateInput,
                value: this.filterText,
            });
            this.description = (this.filterText ? `"${this.filterText}"` : '');
            this.refresh();
        } else if(cmd === 'unsummarizeTopics'){
            this.summarizeTopics = false;
            this.replaceContextValue('unsummarizeTopics', 'summarizeTopics');
            this.refreshChildren();
            this.refresh(false, false);
        } else if(cmd === 'summarizeTopics'){
            this.summarizeTopics = true;
            this.replaceContextValue('summarizeTopics', 'unsummarizeTopics');
            this.refreshChildren();
            this.refresh(false, false);
        }
    }


    refresh(clearCache: boolean = false, refreshChildren: boolean = true){
        if(clearCache){
            this.rHelp.clearCachedFiles(`/doc/html/packages.html`);
            void this.rHelp.packageManager.clearCachedFiles(`/doc/html/packages.html`);
        }
        super.refresh(refreshChildren);
    }

    refreshChildren(){
        if(this.children){
            for(const child of this.children){
                child.children = undefined;
            }
        }
    }


    async makeChildren() {
        let packages = await this.rHelp.packageManager.getPackages(false);

        if(this.filterText){
            const re = new RegExp(this.filterText);
            packages = packages.filter(pkg => re.exec(pkg.name));
        }

        // favorites at the top
        const children = packages.filter(pkg => pkg.isFavorite);

        // nonFavorites below (if shown)
        if(!this.showOnlyFavorites){
            children.push(...packages.filter(pkg => !pkg.isFavorite));
        }

        // make packageNode for each child
        return children.map(
            pkg => new PackageNode(this, pkg)
        );
    }
}


class PackageNode extends Node {
    // TreeItem
    public command = null;
    public collapsibleState = CollapsibleState.Collapsed;
    public contextValue = Node.makeContextValue('QUICKPICK', 'clearCache', 'removePackage');

    // Node
    public parent: PkgRootNode;
    // public quickPickCommand: cmdName = 'searchPackage';
    public qpPrompt = 'Please select a Topic.';

    // Package
    public pkg: Package;

    constructor(parent: PkgRootNode, pkg: Package){
        super(parent);
        this.pkg = pkg;
        this.label = pkg.name;
        this.tooltip = pkg.description;
        this.qpDetail = pkg.description;
        if(this.pkg.isFavorite){
            this.addContextValues('removeFromFavorites');
        } else{
            this.addContextValues('addToFavorites');
        }
        if(this.pkg.isFavorite && !this.parent.showOnlyFavorites){
            this.iconPath = new vscode.ThemeIcon('star-full');
        }
    }

    public async _handleCommand(cmd: cmdName){
        if(cmd === 'clearCache'){
            this.rHelp.clearCachedFiles(new RegExp(`^/library/${this.pkg.name}/`));
            this.refresh();
        } else if(cmd === 'addToFavorites'){
            this.rHelp.packageManager.addFavorite(this.pkg.name);
            this.parent.refresh();
        } else if(cmd === 'removeFromFavorites'){
            this.rHelp.packageManager.removeFavorite(this.pkg.name);
            this.parent.refresh();
        } else if(cmd === 'removePackage'){
            const success = await this.rHelp.packageManager.removePackage(this.pkg.name, true);
            if(success){
                this.parent.refresh(true);
            }
        }
    }

    async makeChildren(forQuickPick: boolean = false) {
        const summarizeTopics = (
            forQuickPick ? false : (this.parent.summarizeTopics ?? true)
        );
        const topics = await this.rHelp.packageManager.getTopics(this.pkg.name, summarizeTopics, false);
        const ret = topics.map(topic => new TopicNode(this, topic));
        return ret;
    }
}

class TopicNode extends Node {
    // TreeItem
    iconPath = new vscode.ThemeIcon('circle-filled');
    contextValue = Node.makeContextValue('openInNewPanel');

    // Node
    parent: PackageNode;

    // Topic
    topic: Topic;

    static iconPaths = new Map<TopicType, string>([
        [TopicType.HOME, 'home'],
        [TopicType.INDEX, 'list-unordered'],
        [TopicType.META, 'file-code'],
        [TopicType.NORMAL, 'circle-filled']
    ]);

    protected _handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.showHelpForPath(this.topic.helpPath);
        } else if(cmd === 'openInNewPanel'){
            void globalRHelp.makeNewHelpPanel();
            void globalRHelp.showHelpForPath(this.topic.helpPath);
        }
    }

    constructor(parent: PackageNode, topic: Topic){
        super(parent);
        this.topic = topic;
        this.label = topic.name;
        this.iconPath = new vscode.ThemeIcon(TopicNode.iconPaths.get(this.topic.type) || 'circle-filled');
        if(this.topic.type === TopicType.NORMAL){
            this.qpLabel = this.topic.name;
        }
        if(this.topic.aliases){
            this.tooltip = `Aliases:\n - ${this.topic.aliases.join('\n - ')}`;
        } else{
            this.tooltip = this.topic.description;
        }
    }
}

class HomeNode extends MetaNode {
    label = 'Home';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('home');

    callBack(){
        void this.rHelp.showHelpForPath('doc/html/index.html');
    }
}

class Search1Node extends MetaNode {
	label = 'Open Help Topic using `?`';
    iconPath = new vscode.ThemeIcon('zap');
    
    callBack(){
        void this.rHelp.searchHelpByAlias();
    }
}

class Search2Node extends MetaNode {
	label = 'Search Help Topics using `??`';
    iconPath = new vscode.ThemeIcon('search');

    callBack(){
        void this.rHelp.searchHelpByText();
    }
}

class RefreshNode extends MetaNode {
    parent: RootNode;
	label = 'Clear Cached Index Files & Restart Help Server';
    iconPath = new vscode.ThemeIcon('refresh');

    callBack(){
        this.rHelp.refresh();
        this.parent.pkgRootNode.refresh();
    }
}

class NewHelpPanelNode extends MetaNode {
    label = 'Make New Helppanel';
    description = '(Opened with next help command)';
    iconPath = new vscode.ThemeIcon('add');

    callBack(){
        this.rHelp.makeNewHelpPanel();
    }
}

class InstallPackageNode extends MetaNode {
    label = 'Install CRAN Package';
    iconPath = new vscode.ThemeIcon('cloud-download');

    async callBack(){
        await this.rHelp.packageManager.pickAndInstallPackage();
        this.rootNode.pkgRootNode.refresh(true);
    }
}



