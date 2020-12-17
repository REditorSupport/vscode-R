/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-inferrable-types */

import * as vscode from 'vscode';
import { globalRHelp } from './extension';

import { IndexFileEntry, RHelp } from './rHelp';
import { RHelpPanel } from './rHelpPanel';
import { getRpath } from './util';

import * as cp from 'child_process';

class Disposable {
    dispose(): void {
        // pass
    }
}

// type QuickPickAction = 'runCommand'|'openPath'|'showChildren';
const CollapsibleState = vscode.TreeItemCollapsibleState;

const nodeCommands = {
    searchPackage: 'r.helpPanel.searchPackage',
    openInNewPanel: 'r.helpPanel.openInNewPanel',
    clearCache: 'r.helpPanel.clearCache',
    removeFromFavorites: 'r.helpPanel.removeFromFavorites',
    addToFavorites: 'r.helpPanel.addToFavorites',
    removePackage: 'r.helpPanel.removePackage',
    showOnlyFavorites: 'r.helpPanel.showOnlyFavorites',
    showAllPackages: 'r.helpPanel.showAllPackages',
    filterPackages: 'r.helpPanel.filterPackages'
};

type cmdName = keyof typeof nodeCommands;

function makeContextValue(...args: cmdName[]){
    return [...args].join('_');
}

function modifyContextValue(v0: string, add?: cmdName, remove?: cmdName) {
    if(add){
        v0 += '_' + add;
    }
    if(remove){
        v0 = v0.replace(new RegExp(`${remove}_?`), '');
    }
    return v0;
}


async function removePackage(pkgName: string){
    const rPath = await getRpath(true);
    const cmd = `${rPath} --silent -e remove.packages('${pkgName}')`;
    let ret: string;
    let success: boolean;
    try{
        ret = cp.execSync(cmd, {encoding: 'utf-8'});
        success = true;
    } catch(e){
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        ret = <string>(e.message);
        success = false;
    }
    return {
        ret: ret,
        success: success
    };
}



export function initializeHelpTree(helpPanel: RHelp): void {
    const helpTreeWrapper = new HelpTreeWrapper(helpPanel);
    for(const cmd in nodeCommands){
        vscode.commands.registerCommand(nodeCommands[cmd], (node: Node) => {
            node.handleCommand(cmd);
        });
    }
}

export class HelpTreeWrapper {
    treeView: vscode.TreeView<Node>;
    helpViewProvider: HelpViewProvider;

    constructor(helpPanel: RHelp){
        this.helpViewProvider = new HelpViewProvider(this);
        this.treeView = vscode.window.createTreeView(
            'rHelpPages',
            {
                treeDataProvider: this.helpViewProvider,
                showCollapseAll: true
            }
        );
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

        vscode.commands.registerCommand('r.helpPanel.internalCallback', (node: Node) => {
            if(node.callBack){
                node.callBack();
            }
        });
    }

    onDidChangeTreeData(listener: (e: Node) => void): Disposable {
        this.listeners.push(listener);
        return new Disposable();
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

class Node extends vscode.TreeItem{
    public id: string;
    public parent: Node | undefined;
    public children?: Node[] = undefined;
    public readonly nodeType: string;
    public collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    public description: string;

    public wrapper: HelpTreeWrapper;

    static newId: number = 0;

    constructor(parent?: Node){
        super('');
        this.parent = parent;
        this.id = `${Node.newId++}`;

        // needs to be in constructor since this.id needs to be known
        this.command = {
            title: 'treeNodeCallback',
            command: 'r.helpPanel.internalCallback',
            arguments: [this]
        };
    }

    public callBack?: () => void;

    public handleCommand(cmd: string){
        // to be overwritten
    }

    public async getChildren(lazy: boolean = false): Promise<Node[]|null> | null {
        if(this.children === undefined && !lazy){
            await this.makeChildren();
            for(const child of this.children){
                child.parent = this;
                child.wrapper = this.wrapper;
            }
        }
        return this.children;
    }
    
    public makeChildren(): void | Promise<void> {
        this.children = [];
    }

    public findChild(id?: string): Node {
        if(!id){
            // do nothing
        } else if(this.id === id){
            return this;
        } else if(this.children) { 
            for(const child of this.children){
                const match = child.findChild(id);
                if(match){
                    return match;
                }
            }
        }
        return null;
    }

    public refresh(){
        this.children = undefined;
        this.wrapper.refreshNode(this);
    }
}

class MetaNode extends Node {
    constructor(parent: Node){
        super(parent);
    }
}

class RootNode extends MetaNode {
    public collapsibleState = vscode.TreeItemCollapsibleState.None;
    public label = 'root';
    public pkgRootNode?: PkgRootNode;

    constructor(wrapper: HelpTreeWrapper){
        super(undefined);
        this.wrapper = wrapper;
    }
    makeChildren(){
        this.pkgRootNode = new PkgRootNode(this);
        this.children = [
            new HomeNode(this),
            new Search1Node(this),
            new Search2Node(this),
            new RefreshNode(this),
            new NewHelpPanelNode(this),
            this.pkgRootNode,
        ];
    }
    refresh(){
        this.wrapper.refreshNode(undefined);
    }
}


class PkgRootNode extends MetaNode {
    label = 'Help Topics by Package';
    collapsibleState = CollapsibleState.Collapsed;
    iconPath = new vscode.ThemeIcon('list-unordered');
    command = null;
    contextValue = makeContextValue('clearCache', 'filterPackages', 'showOnlyFavorites');
    description = '';
    private showOnlyFavorites: boolean = false;
    public favoriteNames: string[] = [];
    public children?: PackageNode[];
    public favorites?: PackageNode[];
    public parent: RootNode;
    public filterText: string = '';


    async handleCommand(cmd: cmdName){
        if(cmd === 'clearCache'){
            this.refresh(true);
        } else if(cmd === 'showOnlyFavorites'){
            this.showOnlyFavorites = true;
            this.contextValue = modifyContextValue(this.contextValue, 'showAllPackages', 'showOnlyFavorites');
            this.iconPath = new vscode.ThemeIcon('star-full');
            this.refresh();
        } else if(cmd === 'showAllPackages'){
            this.showOnlyFavorites = false;
            this.contextValue = modifyContextValue(this.contextValue, 'showOnlyFavorites', 'showAllPackages');
            this.iconPath = new vscode.ThemeIcon('list-unordered');
            this.refresh();
        } else if(cmd === 'filterPackages'){
            const validateInput = (value: string) => {
                this.filterText = value;
                this.refresh();
                return '';
            };
            this.filterText = await vscode.window.showInputBox({
                validateInput: validateInput,
                value: this.filterText,
            });
            this.description = (this.filterText ? `"${this.filterText}"` : '');
            this.refresh();
        }
    }

    refresh(clearCache: boolean = false){
        if(clearCache){
            globalRHelp.clearCachedFiles(`/doc/html/packages.html`);
        }
        super.refresh();
    }

    addFavorite(pkgName: string){
        if(this.favoriteNames.indexOf(pkgName) === -1){
            this.favoriteNames.push(pkgName);
            this.refresh();
        }
    }

    removeFavorite(pkgName: string){
        const ind = this.favoriteNames.indexOf(pkgName);
        if(ind>=0){
            this.favoriteNames.splice(ind, 1);
            this.refresh();
        }
    }

    async makeChildren() {
        const packages = await globalRHelp.getParsedIndexFile(`/doc/html/packages.html`);
        const favorites: PackageNode[] = [];
        const children: PackageNode[] = [];
        const showAllPackages = !this.showOnlyFavorites;
        for(const pkg of packages){
            const re = new RegExp(this.filterText, 'i');
            if(this.filterText && !re.exec(pkg.label)){
                continue;
            }
            const isFavorite = this.favoriteNames.includes(pkg.label);
            const child = new PackageNode(this, pkg.label, isFavorite, showAllPackages);
            child.tooltip = pkg.description;
            if(isFavorite){
                favorites.push(child);
            } else{
                children.push(child);
            }
        }
        this.favorites = [...favorites];
        this.children = [...favorites];
        if(showAllPackages){
            this.children.push(...children);
        }
    }
}


class PackageNode extends Node {
    collapsibleState = CollapsibleState.Collapsed;
    pkgName: string;
    command = null;
    public isFavorite: boolean;
    parent: PkgRootNode;
    contextValue = makeContextValue('searchPackage', 'clearCache', 'removePackage');

    constructor(parent: PkgRootNode, pkgName: string, isFavorite: boolean = false, showAllPackages: boolean = true){
        super(parent);
        this.pkgName = pkgName;
        this.label = pkgName;
        this.isFavorite = isFavorite;
        if(this.isFavorite){
            this.contextValue = modifyContextValue(this.contextValue, 'removeFromFavorites');
        } else{
            this.contextValue = modifyContextValue(this.contextValue, 'addToFavorites');
        }
        if(this.isFavorite && showAllPackages){
            this.iconPath = new vscode.ThemeIcon('star-full');
        }
    }

    public async handleCommand(cmd: cmdName){
        if(cmd === 'searchPackage'){
            void globalRHelp.showHelpForFunctions(this.pkgName);
        } else if(cmd === 'clearCache'){
            globalRHelp.clearCachedFiles(new RegExp(`^/library/${this.label}/`));
            this.refresh();
        } else if(cmd === 'addToFavorites'){
            this.parent.addFavorite(this.pkgName);
        } else if(cmd === 'removeFromFavorites'){
            this.parent.removeFavorite(this.pkgName);
        } else if(cmd === 'removePackage'){
            // getAllAliases is synchronous, but might take a while => make async and show progress
            const options: vscode.ProgressOptions = {
                location: {
                    viewId: 'rHelpPages'
                },
                cancellable: false
            };
            await vscode.window.withProgress(options, async () => {
                const confirmation = await vscode.window.showQuickPick(['Yes', 'No'], {
                    placeHolder: `Are you sure you want to delete package ${this.pkgName}?`
                });
                if(confirmation !== 'Yes'){
                    return;
                }
                const {ret: ret, success: success} = await removePackage(this.pkgName);
                if(!success){
                    void vscode.window.showErrorMessage('Failed to remove package: ' + ret);
                }
            });
            this.parent.refresh(true);
        }
    }

    async makeChildren() {
        const functions = await globalRHelp.getParsedIndexFile(`/library/${this.pkgName}/html/00Index.html`);
        const topics = new Map<string, TopicNode>();
        for(const fnc of functions){
            fnc.href = fnc.href || fnc.label;
            let topic: TopicNode;
            if(topics.has(fnc.href)){
                topic = topics.get(fnc.href);
                topic.tooltip += `\n- ${fnc.label}`;
            } else{
                topic = new TopicNode(this, fnc.description, this.pkgName, fnc.href);
                topic.tooltip = `Aliases:\n- ${fnc.label}`;
                topics.set(fnc.href, topic);
            }
            if(fnc.label === `${this.pkgName}-package`){
                topic.topicType = 'home';
            }
        }

        // convert to array and do some highlighting etc.
        const children = [...topics.values()];

        // highlight package home-topic
        let homeNode: TopicNode = undefined;
        for(let i = 0; i<children.length; i++){
            if(children[i].topicType === 'home'){
                homeNode = children.splice(i, 1)[0];
                homeNode.label = this.pkgName;
                homeNode.description = '';
                homeNode.iconPath = new vscode.ThemeIcon('home');
                break;
            }
        }

        // make index topic
        const indexNode = new TopicNode(this, 'Index', this.pkgName, '00Index.html');
        indexNode.topicType = 'index';
        indexNode.iconPath = new vscode.ThemeIcon('list-unordered');

        // make DESCRIPTION topic
        const descriptionNode = new TopicNode(this, 'DESCRIPTION', this.pkgName, '../DESCRIPTION');
        descriptionNode.topicType = 'index';
        descriptionNode.iconPath = new vscode.ThemeIcon('file-code');

        // (re-)add index and home topic
        children.unshift(descriptionNode);
        children.unshift(indexNode);
        if(homeNode){
            children.unshift(homeNode);
        }

        this.children = children;
    }
}

class TopicNode extends Node {
    fncName: string;
    pkgName: string;
    href: string;
    path: string;
    iconPath = new vscode.ThemeIcon('circle-filled');
    contextValue = makeContextValue('openInNewPanel');

    topicType: 'home'|'index'|'normal' = 'normal';

    collapsibleState = CollapsibleState.None;

    handleCommand(cmd: cmdName){
        if(cmd === 'openInNewPanel'){
            void globalRHelp.makeNewHelpPanel();
            this.callBack();
        }
    }

    constructor(parent: Node, fncName: string, pkgName: string, href: string){
        super(parent);
        this.fncName = fncName;
        this.pkgName = pkgName;
        this.href = (href || fncName);

        if(this.pkgName === 'doc'){
            this.path = `/doc/html/${this.fncName}`;
        } else{
            this.path = `/library/${this.pkgName}/html/${this.href}`;
        }

        this.label = fncName;
    }

    callBack = () => {
        void globalRHelp.showHelpForPath(this.path);
    }
}


class HomeNode extends MetaNode {
    label = 'Home';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('home');

    callBack = () => {
        void globalRHelp.showHelpForFunctionName('doc', 'index.html');
    }
}

class Search1Node extends MetaNode {
	label = 'Open Help Topic using `?`';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('zap');
    
    callBack = () => {
        void globalRHelp.searchHelpByAlias();
    }
}

class Search2Node extends MetaNode {
	label = 'Search Help Topics using `??`';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('search');

    callBack = () => {
        void globalRHelp.searchHelpByText();
    }
}

class RefreshNode extends MetaNode {
    parent: RootNode;
	label = 'Clear Cached Index Files';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('refresh');

    callBack = () => {
        globalRHelp.refresh();
        this.parent.pkgRootNode.refresh();
    }
}

class NewHelpPanelNode extends MetaNode {
    label = 'Make New Helppanel';
    description = '(Opened with next help command)';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('add');

    callBack = () => {
        void globalRHelp.makeNewHelpPanel();
    }
}



