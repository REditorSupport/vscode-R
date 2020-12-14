
import * as vscode from 'vscode';
import { RHelp } from './rHelp';
import { globalRHelp } from './extension';


class TreeItem extends vscode.TreeItem {
    id: string;
    public readonly itemType: 'root'|'pkg'|'topic'|'pkgRoot';
    constructor(label: string, collapsibleState?: vscode.TreeItemCollapsibleState){
        super(label, collapsibleState);
    }
    getChildren(): TreeItem[] | Promise<TreeItem[]> {
        return [];
    }
}

class RootItem extends TreeItem {
    public readonly itemType = 'root';
    public id: 'root';
    constructor(){
        super('root', vscode.TreeItemCollapsibleState.Collapsed);
    }
    getChildren(){
        return [new PkgRootItem('Installed packages')];
    }
}

class PkgRootItem extends TreeItem {
    public readonly itemType = 'pkgRoot';
    children?: PkgItem[];

    constructor(label: string){
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.description = 'List of all packages';
    }
    async getChildren(){
        if(!this.children){
            const packages = await globalRHelp.getParsedIndexFile(`/doc/html/packages.html`);
            this.children = packages.map(pkg => {
                const item = new PkgItem(pkg.label);
                item.description = pkg.description;
                return item;
            });
        }
        return this.children;
    }
}

class PkgItem extends TreeItem {
    public readonly itemType = 'pkg';
    public readonly pkgName: string;
    children?: TopicItem[];
    constructor(label: string){
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.pkgName = label;
        this.description = 'This is package with name: ' + label;
    }
    async getChildren(){
        if(!this.children){
            const functions = await globalRHelp.getParsedIndexFile(`/library/${this.label}/html/00Index.html`);
            const topics = new Map<string, TopicItem>();
            for(const fnc of functions){
                fnc.href = fnc.href.replace(/\.html$/, '') || fnc.label;
                if(topics.has(fnc.href)){
                    const tpc = topics.get(fnc.href);
                    tpc.description += `, ${fnc.label}`;
                } else{
                    const item = new TopicItem(fnc.description, this.pkgName, fnc.href);
                    item.description = fnc.label;
                    topics.set(fnc.href, item);
                }
            }
            this.children = [...topics.values()];
        }
        return this.children;
    }
}

class TopicItem extends TreeItem {
    public readonly itemType = 'topic';
    public readonly pkgName: string;
    public readonly fncName: string;
    public readonly href?: string;
    constructor(label: string, pkgName: string, href?: string){
        super(label, vscode.TreeItemCollapsibleState.None);
        this.fncName = label;
        this.pkgName = pkgName;
        this.href = href;
        this.command = {
            title: 'Show Help Page',
            command: 'internalShowHelpPage',
            arguments: [this.pkgName, this.fncName, this.href]
        };
    }
}


export class HelpViewProvider implements vscode.TreeDataProvider<TreeItem> {
    public rootItem: RootItem;
    public helpPanel: RHelp;

    constructor(helpPanel: RHelp){
        this.rootItem = new RootItem();
        this.helpPanel = helpPanel;
        vscode.commands.registerCommand('internalShowHelpPage', (pkg: string, fnc: string, href?: string) => {
            fnc = (href || '').replace(/\.html$/, '') || fnc;
            void globalRHelp.showHelpForFunctionName(pkg, fnc);
        });
    }

    getChildren(element?: TreeItem): TreeItem[] | Promise<TreeItem[]> {
        element ||= this.rootItem;
        return element.getChildren();
    }
    getTreeItem(element: TreeItem): TreeItem {
        return element;
    }
}
