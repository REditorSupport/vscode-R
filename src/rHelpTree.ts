/* eslint-disable @typescript-eslint/no-inferrable-types */

import * as vscode from 'vscode';
import { globalRHelp } from './extension';

import { IndexFileEntry, RHelp } from './rHelp';
import { RHelpPanel } from './rHelpPanel';

// type QuickPickAction = 'runCommand'|'openPath'|'showChildren';
const CollapsibleState = vscode.TreeItemCollapsibleState;


export class HelpTreeWrapper {
    treeView: vscode.TreeView<Node>;

    constructor(helpPanel: RHelp){
        this.treeView = vscode.window.createTreeView(
            'rHelpPages',
            {
                treeDataProvider: new HelpViewProvider(helpPanel),
                showCollapseAll: true
            }
        );
    }
}



export class HelpViewProvider implements vscode.TreeDataProvider<Node> {
    public rootItem: RootNode;
    public helpPanel: RHelp;

    constructor(helpPanel: RHelp){
        this.rootItem = new RootNode();
        this.helpPanel = helpPanel;

        vscode.commands.registerCommand('rInternalHelpTreeCallback', (id?: string) => {
            const node = this.rootItem.findChild(id);
            if(node.callBack){
                node.callBack();
            }
        });
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

    static newId: number = 0;

    constructor(parent?: Node, includeCommand: boolean = true, label: string = ''){
        super(label);
        this.parent = parent;
        this.id = `${Node.newId++}`;
        if(includeCommand){
            this.command = {
                title: 'treeNodeCallback',
                command: 'rInternalHelpTreeCallback',
                arguments: [this.id]
            };
        }
    }

    public callBack?: () => void;

    async getChildren(lazy: boolean = false): Promise<Node[]|null> | null {
        if(this.children === undefined && !lazy){
            await this.makeChildren();
        }
        return this.children;
    }
    
    makeChildren(): void | Promise<void> {
        this.children = [];
    }

    findChild(id?: string): Node {
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
}

class MetaNode extends Node {
    constructor(parent: Node){
        super(parent);
    }
}

class RootNode extends MetaNode {
    public collapsibleState = vscode.TreeItemCollapsibleState.None;
    public label = 'root';
    constructor(){
        super(undefined);
    }
    makeChildren(){
        this.children = [
            new HomeNode(this),
            new Search1Node(this),
            new Search2Node(this),
            new RefreshNode(this),
            new PkgRootNode(this),
            new NewHelpPanelNode(this),
        ];
    }
}


class PkgRootNode extends MetaNode {
    label = 'Help Topics by Package';
    collapsibleState = CollapsibleState.Collapsed;
    iconPath = new vscode.ThemeIcon('list-unordered');
    command = null;

    async makeChildren() {
        const packages = await globalRHelp.getParsedIndexFile(`/doc/html/packages.html`);
        this.children = packages.map(pkg => {
            const child = new PackageNode(this, pkg.label);
            child.description = pkg.description;
            return child;
        });
    }
}

class PackageNode extends Node {
    collapsibleState = CollapsibleState.Collapsed;
    pkgName: string;
    command = null;

    constructor(parent: Node, pkgName: string){
        super(parent);
        this.pkgName = pkgName;
        this.label = pkgName;
    }

    async makeChildren() {
        const functions = await globalRHelp.getParsedIndexFile(`/library/${this.label}/html/00Index.html`);
        const topics = new Map<string, TopicNode>();
        for(const fnc of functions){
            fnc.href = fnc.href.replace(/\.html$/, '') || fnc.label;
            let topic: TopicNode;
            if(topics.has(fnc.href)){
                topic = topics.get(fnc.href);
                topic.description += `, ${fnc.label}`;
            } else{
                topic = new TopicNode(this, fnc.description, this.pkgName, fnc.href);
                topic.description = fnc.label;
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
        const indexNode = new TopicNode(this, 'Index', this.pkgName, '00Index');
        indexNode.topicType = 'index';
        indexNode.iconPath = new vscode.ThemeIcon('list-unordered');

        // (re-)add index and home topic
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
    iconPath = new vscode.ThemeIcon('circle-filled');

    topicType: 'home'|'index'|'normal' = 'normal';

    collapsibleState = CollapsibleState.None;

    constructor(parent: Node, fncName: string, pkgName: string, href: string){
        super(parent);
        this.fncName = fncName;
        this.pkgName = pkgName;
        this.href = href;

        this.label = fncName;
    }

    callBack = () => {
        void globalRHelp.showHelpForFunctionName(this.pkgName, (this.href || this.fncName).replace(/\.html$/, ''));
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
	label = 'Clear Cached Index Files';
    collapsibleState = CollapsibleState.None;
    iconPath = new vscode.ThemeIcon('refresh');

    callBack = () => {
        void globalRHelp.refresh();
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



