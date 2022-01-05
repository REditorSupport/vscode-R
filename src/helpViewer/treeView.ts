import * as vscode from 'vscode';

import { RHelp } from '.';
import { doWithProgress } from '../util';
import { Package, Topic, TopicType } from './packages';

// this enum is re-assigned just for code readability
const CollapsibleState = vscode.TreeItemCollapsibleState;


// the commands contributed in package.json for the tree view 
// the commands are registered in HelpTreeWrapper.constructor
// the node-objects only need to handle the keys ('QUICKPICK' etc.) in Node.handleCommand()
const nodeCommands = {
    QUICKPICK: 'r.helpPanel.showQuickPick', // called to show the children of a node in a quickpick
    CALLBACK: 'r.helpPanel.internalCallback', // called when the item is clicked and node.command is not null
    searchPackage: 'r.helpPanel.searchPackage',
    openInNewPanel: 'r.helpPanel.openInNewPanel',
    clearCache: 'r.helpPanel.clearCache',
    removeFromFavorites: 'r.helpPanel.removeFromFavorites',
    addToFavorites: 'r.helpPanel.addToFavorites',
    removePackage: 'r.helpPanel.removePackage',
    updatePackage: 'r.helpPanel.updatePackage',
    showOnlyFavorites: 'r.helpPanel.showOnlyFavorites',
    showAllPackages: 'r.helpPanel.showAllPackages',
    filterPackages: 'r.helpPanel.filterPackages',
    summarizeTopics: 'r.helpPanel.summarizeTopics',
    unsummarizeTopics: 'r.helpPanel.unsummarizeTopics',
    installPackages: 'r.helpPanel.installPackages',
    updateInstalledPackages: 'r.helpPanel.updateInstalledPackages'
};

// used to avoid typos when handling commands
type cmdName = keyof typeof nodeCommands;


////////////////////
// The following classes are mostly just an 'adapter layer' between vscode's treeview interface
// and the object oriented approach used here to present nodes of the treeview.
// The 'interesting' part of the nodes is implemented below


// wrapper around vscode.window.createTreeView()
// necessary to implement Node.refresh(),
// which is used to signal from a node that its contents/children have changed
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

        // register the commands defiend in `nodeCommands`
        // they still need to be defined in package.json (apart from CALLBACK)
        for(const cmd in nodeCommands){
            vscode.commands.registerCommand(nodeCommands[cmd], (node: Node | undefined) => {
                // treeview-root is represented by `undefined`
                node ||= this.helpViewProvider.rootItem;
                node.handleCommand(<cmdName>cmd);
            });
        }
    }

    refreshNode(node: Node | undefined): void {
        for(const listener of this.helpViewProvider.listeners){
            listener(node);
        }
    }
    
    public refreshPackageRootNode(): void {
        this.helpViewProvider.rootItem?.pkgRootNode?.refresh();
    }
}


// mostly just a wrapper to implement vscode.TreeDataProvider
export class HelpViewProvider implements vscode.TreeDataProvider<Node> {
    public rootItem: RootNode;

    public listeners: ((e: Node | undefined) => void)[] = [];

    constructor(wrapper: HelpTreeWrapper){
        this.rootItem = new RootNode(wrapper);
    }

    onDidChangeTreeData(listener: (e: Node) => void): vscode.Disposable {
        this.listeners.push(listener);
        return new vscode.Disposable(() => {
            // do nothing
        });
    }

    getChildren(element?: Node): vscode.ProviderResult<Node[]>{
        element ||= this.rootItem;
        return element.getChildren();
    }
    getTreeItem(element: Node): Node {
        return element;
    }
    getParent(element: Node): Node | undefined {
        return element.parent;
    }
}

// Abstract base class for nodes of the treeview
// Is a rather technical base class to handle the intricacies of vscode's treeview API
// All the 'interesting' stuff hapens in the derived classes
// New commands should (if possible) be implemented by defining a new derived class,
// rather than modifying this class!
abstract class Node extends vscode.TreeItem{
    // TreeItem (defaults for this usecase)
    public description: string;
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None;
    public contextValue: string = '';
    public label: string;
    public tooltip: string;

    // set to null/undefined in derived class to expand/collapse on click
    public command = {
        title: 'treeNodeCallback', // is this title used anywhere?
        command: nodeCommands.CALLBACK,
        arguments: [this]
    } as vscode.Command | undefined;

    // Node
    public parent: Node | undefined;
    public children?: Node[] = undefined;

    // These can be used to modify the behaviour of a node when showed as/in a quickpick:
    public quickPickCommand?: cmdName; // defaults to this.showQuickPick or callBack
    public qpLabel?: string; // defaults to node.icon + node.label
    public qpDetail?: string; // defaults to node.detail || node.description || node.toolTip
    public qpPrompt?: string; // defaults to empty input bar

    // These are shared between nodes to access functions of the help panel etc.
    // could also be static?
    protected readonly wrapper: HelpTreeWrapper;
    protected readonly rootNode: RootNode;
    protected readonly rHelp: RHelp;

    // used to give unique ids to nodes
    static newId: number = 0;

    // The default constructor just copies some info from parent
    constructor(parent?: Node, wrapper?: HelpTreeWrapper){
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

    // Called when a node or command-button on a node is clicked
    // Only internal commands are handled here, custom commands are implemented in _handleCommand!
    public handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK' && this.callBack){
            void this.callBack();
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

    // overwrite this in derived classes to handle custom commands
    protected _handleCommand(cmd: cmdName): void;
    protected _handleCommand(){
        // to be overwritten
    }

    // implement this to handle callBacks (simple clicks on a node)
    // can also be implemented in _handleCommand('CALLBACK')
    public callBack?(): void | Promise<void>;

    // Shows a quickpick containing the children of a node
    // If the picked child has children itself, another quickpick is shown
    // Otherwise, its QUICKPICK or CALLBACK command is executed
    public async showQuickPick(){
        const children = await this.makeChildren(true);
        if(!children){
            return undefined;
        }
        const qpItems: (vscode.QuickPickItem & {child: Node})[] = children.map(v => {
            let label = v.label || '';
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

    // Called by vscode etc. to get the children of a node
    // Not meant to be modified in derived classes!
    public async getChildren(): Promise<Node[]|undefined> {
        if(this.children === undefined){
            this.children = await this.makeChildren();
        }
        return this.children;
    }

    // to be overwritten, if the node has any children
    protected makeChildren(forQuickPick?: boolean): Promise<Node[]|undefined> | Node[] | undefined;
    protected makeChildren(): Promise<Node[]|undefined> | Node[] | undefined {
        return [];
    }

    // Can be called by a method from the node itself or externally to refresh the node in the treeview
    public refresh(refreshChildren: boolean = true){
        if(refreshChildren){
            this.children = undefined;
        }
        this.wrapper.refreshNode(this);
    }

    // Clear 'grandchildren' without triggering the treeview to update too often
    public refreshChildren(){
        if(this.children){
            for(const child of this.children){
                child.children = undefined;
            }
        }
    }

    // show/focus the node in the treeview
    public reveal(options?: { select?: boolean, focus?: boolean, expand?: boolean | number }){
        void this.wrapper.helpView.reveal(this, options);
    }

    // These methods are used to update this.contextValue with possible command names
    // The constructed contextValue contains the command names of the commands applying to this node
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
    // delete?
}








///////////////////////////////////
// The following classes contain the implementation of the help-view-specific behaviour
// PkgRootNode, PackageNode, and TopicNode are a bit more complex
// The remaining nodes mostly just contain an icon and a callback



// Root of the node. Is not actually used by vscode, but as 'imaginary' root item.
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
            new OpenForSelectionNode(this),
            new RefreshNode(this),
            new InstallPackageNode(this),
            this.pkgRootNode,
        ];
    }
    refresh(){
        this.wrapper.refreshNode(undefined);
    }
}

// contains the list of installed packages
class PkgRootNode extends MetaNode {
    // TreeItem
    public label = 'Help Topics by Package';
    public iconPath = new vscode.ThemeIcon('list-unordered');
    public description = '';
    public command = undefined;
    public collapsibleState = CollapsibleState.Collapsed;
    public contextValue = Node.makeContextValue('QUICKPICK', 'clearCache', 'filterPackages', 'showOnlyFavorites', 'unsummarizeTopics');

    // Node
    public children?: PackageNode[];
    public parent: RootNode;

    // quickpick
    public qpPrompt = 'Please select a package.';

    // PkgRootNode
    public showOnlyFavorites: boolean = false;
    public filterText?: string;
    public summarizeTopics: boolean = true;

    async _handleCommand(cmd: cmdName){
        if(cmd === 'clearCache'){
            // used e.g. after manually installing/removing a package
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
            this.refreshChildren(); // clears the 'grandchildren'
            this.refresh(false, false);
        } else if(cmd === 'summarizeTopics'){
            this.summarizeTopics = true;
            this.replaceContextValue('summarizeTopics', 'unsummarizeTopics');
            this.refreshChildren(); // clears the 'grandchildren'
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

    async makeChildren() {
        let packages = await this.rHelp.packageManager.getPackages(false);

        if(!packages){
            return [];
        }

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


// contains the topics belonging to an individual package
class PackageNode extends Node {
    // TreeItem
    public command = undefined;
    public collapsibleState = CollapsibleState.Collapsed;
    public contextValue = Node.makeContextValue('QUICKPICK', 'clearCache', 'removePackage', 'updatePackage');

    // Node
    public parent: PkgRootNode;

    // QuickPick
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
            // useful e.g. when working on a package
            this.rHelp.clearCachedFiles(new RegExp(`^/library/${this.pkg.name}/`));
            this.refresh();
        } else if(cmd === 'addToFavorites'){
            this.rHelp.packageManager.addFavorite(this.pkg.name);
            this.parent.refresh();
        } else if(cmd === 'removeFromFavorites'){
            this.rHelp.packageManager.removeFavorite(this.pkg.name);
            this.parent.refresh();
        } else if(cmd === 'updatePackage'){
            const success = await this.rHelp.packageManager.installPackages([this.pkg.name]);
            // only reinstall if user confirmed removing the package (success === true)
            // might still refresh if install was attempted but failed
            if(success){
                this.parent.refresh(true);
            }
        } else if(cmd === 'removePackage'){
            const success = await this.rHelp.packageManager.removePackage(this.pkg.name);
            // only refresh if user confirmed removing the package (success === true)
            // might still refresh if removing was attempted but failed
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
        const ret = topics?.map(topic => new TopicNode(this, topic)) || [];
        return ret;
    }
}

// Node representing an individual topic/help page
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
            void this.rHelp.showHelpForPath(this.topic.helpPath);
        } else if(cmd === 'openInNewPanel'){
            void this.rHelp.makeNewHelpPanel();
            void this.rHelp.showHelpForPath(this.topic.helpPath);
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


/////////////
// The following nodes only implement an individual command each

class HomeNode extends MetaNode {
    label = 'Home';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('home');
    contextValue = Node.makeContextValue('openInNewPanel');
    
    _handleCommand(cmd: cmdName){
        if(cmd === 'openInNewPanel'){
            void this.rHelp.makeNewHelpPanel();
            void this.rHelp.showHelpForPath('doc/html/index.html');
        }
    }

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
	label = 'Clear Cache & Restart Help Server';
    iconPath = new vscode.ThemeIcon('refresh');

    async callBack(){
        await doWithProgress(() => this.rHelp.refresh());
        this.parent.pkgRootNode.refresh();
    }
}

class OpenForSelectionNode extends MetaNode {
    parent: RootNode;
    label = 'Open Help Page for Selected Text';
    iconPath = new vscode.ThemeIcon('symbol-key');
    
    callBack(){
        void this.rHelp.openHelpForSelection();
    }
}

class InstallPackageNode extends MetaNode {
    label = 'Install CRAN Package';
    iconPath = new vscode.ThemeIcon('cloud-download');

    contextValue = Node.makeContextValue('installPackages', 'updateInstalledPackages');

    public async _handleCommand(cmd: cmdName){
        if(cmd === 'installPackages'){
            const ret = await this.rHelp.packageManager.pickAndInstallPackages(true);
            if(ret){
                this.rootNode.pkgRootNode.refresh(true);
            }
        } else if(cmd === 'updateInstalledPackages'){
            const ret = await this.rHelp.packageManager.updatePackages();
            if(ret){
                this.rootNode.pkgRootNode.refresh(true);
            }
        }
    }

    async callBack(){
        await this.rHelp.packageManager.pickAndInstallPackages();
        this.rootNode.pkgRootNode.refresh(true);
    }
}



