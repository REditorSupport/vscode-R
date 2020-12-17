/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-inferrable-types */

import * as vscode from 'vscode';
import { globalRHelp } from './rHelp';

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
    CALLBACK: 'r.helpPanel.internalCallback', // called when the item is clicked and node.command is as Node
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

async function removePackage(pkgName: string, showProgress = true): Promise<boolean> {
    const options: vscode.ProgressOptions = {
        location: {
            viewId: (showProgress ? 'rHelpPages' : '')
        },
        cancellable: false
    };

    let success: boolean;
    await vscode.window.withProgress(options, async () => {
        const rPath = await getRpath(true);
        const cmd = `${rPath} --silent -e remove.packages('${pkgName}')`;
        const confirmation = 'Yes, delete package!';
        const items: vscode.QuickPickItem[] = [
            {
                label: confirmation,
                detail: cmd,
            },
            {
                label: 'Cancel'
            }
        ];
        const answer = await vscode.window.showQuickPick(items, {
            placeHolder: `Are you sure you want to delete package ${pkgName}?`
        });
        if(answer !== items[0]){
            return false;
        }
        let ret: string;
        try{
            cp.execSync(cmd, {encoding: 'utf-8'});
            success = true;
        } catch(e){
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            ret = <string>(e.message);
            void vscode.window.showErrorMessage('Failed to remove package: ' + ret);
            success = false;
        }
    });
    return(success);
}


export class HelpTreeWrapper {
    treeView: vscode.TreeView<Node>;
    helpViewProvider: HelpViewProvider;
    state: vscode.Memento;

    constructor(state: vscode.Memento){
        this.helpViewProvider = new HelpViewProvider(this);
        this.state = state;
        this.treeView = vscode.window.createTreeView(
            'rHelpPages',
            {
                treeDataProvider: this.helpViewProvider,
                showCollapseAll: true
            }
        );

        for(const cmd in nodeCommands){
            vscode.commands.registerCommand(nodeCommands[cmd], (node: Node) => {
                node.handleCommand(cmd);
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

    public contextValue = '';

    public wrapper: HelpTreeWrapper;

    static newId: number = 0;

    constructor(parent?: Node){
        super('');
        this.parent = parent;
        this.id = `${Node.newId++}`;

        // needs to be in constructor since this.id needs to be known
        this.command = {
            title: 'treeNodeCallback',
            command: nodeCommands.CALLBACK,
            arguments: [this]
        };
    }

    public callBack?: string;

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

    public getRoot(): Node {
        if(this.parent){
            return this.parent.getRoot();
        } else{
            return this;
        }
    }

    public refresh(){
        this.children = undefined;
        this.wrapper.refreshNode(this);
    }

    static makeContextValue(...args: cmdName[]){
        return [...args].join('_');
    }
    public addContextValue(...args: cmdName[]){
        args.forEach(val => {
            this.contextValue += '_' + val;
        });
        return this.contextValue;
    }
    public removeContextValue(...args: cmdName[]){
        args.forEach(val => {
            this.contextValue = this.contextValue.replace(new RegExp(`${val}_?`), '');
        });
        return this.contextValue;
    }
}

class MetaNode extends Node {
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
    contextValue = Node.makeContextValue('searchPackage', 'clearCache', 'filterPackages', 'showOnlyFavorites');
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
            this.addContextValue('showAllPackages');
            this.removeContextValue('showOnlyFavorites');
            this.iconPath = new vscode.ThemeIcon('star-full');
            this.refresh();
        } else if(cmd === 'showAllPackages'){
            this.showOnlyFavorites = false;
            this.addContextValue('showOnlyFavorites');
            this.removeContextValue('showAllPackages');
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
        } else if(cmd === 'searchPackage'){
            void globalRHelp.showHelpMenu('pkgList');
        }
    }

    private pullFavoriteNames(){
        const state = this.getRoot().wrapper.state;
        if(state){
            this.favoriteNames = state.get('r.helpPanel.favoriteNames') || this.favoriteNames;
        }
    }
    private pushFavoriteNames(){
        const state = this.getRoot().wrapper.state;
        if(state){
            void state.update('r.helpPanel.favoriteNames', this.favoriteNames);
        }
    }

    refresh(clearCache: boolean = false){
        this.pullFavoriteNames();
        if(clearCache){
            globalRHelp.clearCachedFiles(`/doc/html/packages.html`);
        }
        super.refresh();
    }

    addFavorite(pkgName: string){
        this.pullFavoriteNames();
        if(this.favoriteNames.indexOf(pkgName) === -1){
            this.favoriteNames.push(pkgName);
        }
        this.pushFavoriteNames();
        this.refresh();
    }

    removeFavorite(pkgName: string){
        this.pullFavoriteNames();
        const ind = this.favoriteNames.indexOf(pkgName);
        if(ind>=0){
            this.favoriteNames.splice(ind, 1);
        }
        this.pushFavoriteNames();
        this.refresh();
    }

    async makeChildren() {
        this.pullFavoriteNames();
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
    contextValue = Node.makeContextValue('searchPackage', 'clearCache', 'removePackage');

    constructor(parent: PkgRootNode, pkgName: string, isFavorite: boolean = false, showAllPackages: boolean = true){
        super(parent);
        this.pkgName = pkgName;
        this.label = pkgName;
        this.isFavorite = isFavorite;
        if(this.isFavorite){
            this.addContextValue('removeFromFavorites');
        } else{
            this.addContextValue('addToFavorites');
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
            const success = await removePackage(this.pkgName, true);
            if(success){
                this.parent.refresh(true);
            }
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
    contextValue = Node.makeContextValue('openInNewPanel');

    topicType: 'home'|'index'|'normal' = 'normal';

    collapsibleState = CollapsibleState.None;

    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.showHelpForPath(this.path);
        } else if(cmd === 'openInNewPanel'){
            void globalRHelp.makeNewHelpPanel();
            void globalRHelp.showHelpForPath(this.path);
        }
    }

    constructor(parent: PackageNode, fncName: string, pkgName: string, href: string){
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
}


class HomeNode extends MetaNode {
    label = 'Home';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('home');

    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.showHelpForFunctionName('doc', 'index.html');
        }
    }
}

class Search1Node extends MetaNode {
	label = 'Open Help Topic using `?`';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('zap');
    
    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.searchHelpByAlias();
        }
    }
}

class Search2Node extends MetaNode {
	label = 'Search Help Topics using `??`';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('search');

    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.searchHelpByText();
        }
    }
}

class RefreshNode extends MetaNode {
    parent: RootNode;
	label = 'Clear Cached Index Files';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('refresh');

    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            globalRHelp.refresh();
            this.parent.pkgRootNode.refresh();
        }
    }
}

class NewHelpPanelNode extends MetaNode {
    label = 'Make New Helppanel';
    description = '(Opened with next help command)';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('add');

    handleCommand(cmd: cmdName){
        if(cmd === 'CALLBACK'){
            void globalRHelp.makeNewHelpPanel();
        }
    }
}



