
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as rHelp from './index';
import * as ejs from 'ejs';
import { isDirSafe, isFileSafe, readFileSyncSafe, config } from '../util';
import { Topic, TopicType } from './packages';


// Information from the corresponding fields in DESCRIPION
interface LocalPackageInfo {
    name?: string;
    version?: string;
    title?: string;
}

// Used to create a preview of 00Index.html
interface IndexEjsTopic {
    name: string;
    href: string;
    title: string;
}
interface IndexEjsData {
    packageTitle: string;
    packageName: string;
    packageVersion: string;
    topics: IndexEjsTopic[];
}

interface RdAlias {
    // path of .Rd file
    filepath: string;
    // (unique) name of the topic
    name: string;
    // title of the topic
    title?: string;
    // (possibly multiple) aliases of the topic
    aliases: string[];
}

interface AliasExtra extends rHelp.Alias {
    // title of the topic
    title?: string;
    // filepath of the corresponding .Rd file
    rdPath?: string;
}

export interface RHelpPreviewerOptions {
    // path of the R executable
    rPath: string;
    // listener to notify when package-files change
    previewListener?: (previewer: RLocalHelpPreviewer) => void;
    // path to .ejs file to be used as 00Index.html in previewed packages
    indexTemplatePath: string;
}

export function makePreviewerList(options: RHelpPreviewerOptions): RLocalHelpPreviewer[] {
    const subDirs = config().get<string[]>('helpPanel.previewLocalPackages', []);
    const workspaces = vscode.workspace.workspaceFolders || [];
    const ret: RLocalHelpPreviewer[] = [];
    let previewCounter = 1;
    for (const workspace of workspaces) {
        for(const subDir of subDirs){
            const dir = vscode.Uri.joinPath(workspace.uri, subDir);
            const dirPath = dir.fsPath;
            const tmpPreviewer = new RLocalHelpPreviewer(options, dirPath, previewCounter);
            if(tmpPreviewer.isPackageDir){
                ret.push(tmpPreviewer);
                previewCounter = previewCounter + 1;
            } else{
                tmpPreviewer.dispose();
            }
        }
    }
    return ret;
}

const DUMMY_TOPIC_TITLE = '<UNNAMED TOPIC>';
const DUMMY_TOPIC_VERSION = '?.?.?';
const DUMMY_PACKAGE_TITLE = '<UNTITLED PACKAGE>';

export class RLocalHelpPreviewer {

    public readonly packageDir: string;
    private readonly descriptionPath: string;
    private readonly manDir: string;
    private readonly rPath: string;
    private readonly indexTemplate: string;
    private callPreviewListener: () => void;

    public isPackageDir: boolean = false;
    public isDisposed: boolean = false;

    private readonly fileWatchers: fs.FSWatcher[] = [];
    private cachedRdAliases?: Map<string, RdAlias>;
    private cachedPackageInfo?: LocalPackageInfo;

    private readonly dummyPackageName: string;

    constructor(options: RHelpPreviewerOptions, packageDir: string, unnamedId: number = 1){
        this.packageDir = packageDir;
        this.descriptionPath = path.join(this.packageDir, 'DESCRIPTION');
        this.manDir = path.join(this.packageDir, 'man');
        this.rPath = options.rPath;
        this.callPreviewListener = () => options.previewListener?.(this);
        this.isPackageDir = this.watchFiles();
        this.dummyPackageName = `UnnamedPackage${unnamedId}`;
        this.indexTemplate = fs.readFileSync(options.indexTemplatePath, 'utf-8');
    }

    public refresh(): void {
        // nothing to do, since file watchers keep everything updated
    }
    public dispose(callListener = false): void {
        this.isPackageDir = false;
        while(this.fileWatchers.length){
            this.fileWatchers.pop()?.close();
        }
        this.isDisposed = true;
        if(callListener){
            this.callPreviewListener();
        }
    }

    // Is only called once as part of the constructor
    // It is expected that this instance will be disposed if this method returns false
    private watchFiles(): boolean {
        // Only watch any files, if both man dir and DESCRIPTION exist
        if(!isFileSafe(this.descriptionPath) || !isDirSafe(this.manDir)){
            return false;
        }

        // Prepare listeners
        const errorListener = () => {
            console.log(`Disposing previewer for pkgDir: ${this.packageDir}`);
            void this.dispose(true);
        };
        const descriptionListener: fs.WatchListener<string> = () => {
            this.cachedPackageInfo = undefined;
            this.callPreviewListener();
        };
        const manDirListener: fs.WatchListener<string> = (event: fs.WatchEventType, filename: string) => {
            if(this.isDisposed){
                return;
            }
            if(!isDirSafe(this.manDir)){
                this.dispose(true);
                return;
            }
            const fullPath = path.join(this.manDir, filename);
            // The cache is only initialized when it is needed for the first time:
            if(this.cachedRdAliases){
                const rdAlias = getRdAlias(fullPath);
                if(rdAlias){
                    this.cachedRdAliases.set(fullPath, rdAlias);
                } else{
                    this.cachedRdAliases.delete(fullPath);
                }
            }
            this.callPreviewListener();
        };

        // Watch man dir/DESCRIPTION
        const descWatcher = fs.watch(this.descriptionPath, {encoding: 'utf-8'});
        descWatcher.on('change', descriptionListener);
        descWatcher.on('error', errorListener);
        this.fileWatchers.push(descWatcher);

        const manDirWatcher = fs.watch(this.manDir, {encoding: 'utf-8'});
        manDirWatcher.on('change', manDirListener);
        manDirWatcher.on('error', errorListener);
        this.fileWatchers.push(manDirWatcher);

        return true;
    }

    public getPackageInfo(): LocalPackageInfo | undefined {
        if(this.cachedPackageInfo){
            return this.cachedPackageInfo;
        }
        const desc = readFileSyncSafe(this.descriptionPath, 'utf-8');
        if(!desc){
            return undefined;
        }
        const packageInfo: LocalPackageInfo = {};
        const nameMatch = /^Package:\s*(.*?)\s*$/m.exec(desc);
        packageInfo.name = nameMatch?.[1];
        const versionMatch = /^Version:\s*(.*?)\s*$/m.exec(desc);
        packageInfo.version = versionMatch?.[1];
        const titleMatch = /^Title:\s*(.*?)\s*$/m.exec(desc);
        packageInfo.title = titleMatch?.[1];
        this.cachedPackageInfo = packageInfo;
        return packageInfo;
    }

    public getPackageName(safe?: boolean): string {
        let ret = this.getPackageInfo()?.name || this.dummyPackageName;
        if(safe){
            ret = ret.replaceAll(/[^a-zA-Z0-9.]/g, '');
            if(ret.match(/^[0-9.]/) || ret.length < 2 || ret.match(/\.$/)){
                ret = this.dummyPackageName;
            }
        }
        return ret;
    }

    // Methods that imitate the HelpProvider
    public getHelpFileFromRequestPath(requestPath: string): undefined | rHelp.HelpFile {
        if(this.isDisposed){
            return undefined;
        }
        const {pkg, topic} = parseRequestPath(requestPath);
        if(!topic || !pkg || (pkg !== this.getPackageName() && pkg !== this.getPackageName(true))){
            return undefined;
        }
        if(topic === '00Index'){
            return this.getHelpForIndex(requestPath);
        }
        if(topic === 'DESCRIPTION'){
            return this.getHelpForDescription(requestPath);
        }
        return this.getHelpForTopic(topic, requestPath);
    }

    private getHelpForTopic(topic: string, requestPath: string): undefined | rHelp.HelpFile {
        // Make sure the topic has a valid .Rd file
        const rdFileName = this.getRdPathForTopic(topic);
        if(!rdFileName || !isFileSafe(rdFileName)){
            return undefined;
        }

        // Convert .Rd to HTML
        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-e',
            'tools::Rd2HTML(base::commandArgs(TRUE)[1],package=base::commandArgs(TRUE)[2:3],dynamic=TRUE)',
            '--args',
            rdFileName,
            this.getPackageName(true),
            this.getPackageInfo()?.version || DUMMY_TOPIC_VERSION
        ];
        const spawnRet = cp.spawnSync(this.rPath, args, {encoding: 'utf-8'});
        if(spawnRet.status){
            console.log(`Failed to convert .Rd file ${rdFileName} (status: ${spawnRet.status})`);
            console.log(spawnRet.stderr);
            console.log(spawnRet.error);
            return undefined;
        }

        // Prepare HelpFile
        const helpFile: rHelp.HelpFile = {
            html: spawnRet.stdout,
            requestPath: requestPath,
            isPreview: true,
            rdPath: rdFileName,
            packageDir: this.packageDir
        };

        // Add path of .R containing Roxygen documentation
        const rdTxt = fs.readFileSync(rdFileName, 'utf-8').replaceAll(/\r/g, '');
        const rFileMatch = rdTxt.match(/^% Please edit documentation in (.*\.R)$/m);
        if(rFileMatch){
            helpFile.rPath = path.join(this.packageDir, rFileMatch?.[1]);
        }
        return helpFile;
    }

    private getRdPathForTopic(topic: string): string | undefined {
        const rdAliases = this.getRdAliases();
        for(const [fullPath, rdAlias] of rdAliases){
            if(rdAlias.aliases.includes(topic)){
                return fullPath;
            }
        }
        return undefined;
    }

    private getHelpForDescription(requestPath: string): rHelp.HelpFile | undefined {
        const desc = readFileSyncSafe(this.descriptionPath);
        if(!desc){
            return undefined;
        }
        // might need to be handled differently if the handling in index.ts changes:
        const helpFile: rHelp.HelpFile = {
            html: desc,
            requestPath: requestPath,
            isPreview: true,
            rdPath: this.descriptionPath,
            packageDir: this.packageDir
        };
        return helpFile;
    }

    private getHelpForIndex(requestPath: string): rHelp.HelpFile | undefined {
        const html = this.makeIndexHtml();
        if(!html){
            return undefined;
        }
        const helpFile: rHelp.HelpFile = {
            html: html,
            requestPath: requestPath,
            isPreview: true,
            isIndex: true,
            rdPath: undefined,
            packageDir: this.packageDir
        };

        return helpFile;
    }

    private makeIndexHtml(): string | undefined {
        const pkgInfo = this.getPackageInfo();
        if(!pkgInfo){
            return undefined;
        }
        const aliases = this.getAliases();
        const topics = aliases.map(alias => ({
            name: alias.name,
            title: alias.title || DUMMY_TOPIC_TITLE,
            href: `${alias.name}.html`
        }));
        const ejsData: IndexEjsData = {
            packageName: pkgInfo.name || this.dummyPackageName,
            packageTitle: pkgInfo.title || DUMMY_PACKAGE_TITLE,
            packageVersion: pkgInfo.version || DUMMY_TOPIC_VERSION,
            topics: topics
        };
        const html = ejs.render(this.indexTemplate, ejsData);
        return html;
    }

    // Method that imitates the AliasProvider
    public getAliases(): AliasExtra[]  {
        const rdAliases = this.getRdAliases().values();
        const pkgName = this.getPackageName();
        const aliases = [...rdAliases].flatMap(rdAlias => rdAliasToAliases(rdAlias, pkgName));
        return aliases;
    }

    private getRdAliases(): Map<string, RdAlias> {
        // Return cache if exists (is updated by file watchers)
        if(this.cachedRdAliases){
            return this.cachedRdAliases;
        }
        // Else, initialize and populate cache
        const rdAliases = getRdAliases(this.manDir);
        this.cachedRdAliases = new Map();
        for (const rdAlias of rdAliases) {
            this.cachedRdAliases.set(rdAlias.filepath, rdAlias);
        }
        return this.cachedRdAliases;
    }

    // Method that imitates the PackageManager
    public getTreeViewTopics(summarize: boolean = false): Topic[] {
        const pkgName = this.getPackageName(true);
        let topics: Topic[];
        if(summarize){
            const rdAliases = getRdAliases(this.manDir);
            topics = rdAliases.map(rdAlias => rdAliasToTreeViewTopic(rdAlias, pkgName));
        } else{
            const aliases = this.getAliases();
            topics = aliases.map(alias => {
                const helpPath = `/library/${pkgName}/html/${alias.alias}.html`;
                const topic: Topic = {
                    name: alias.alias,
                    description: alias.title || DUMMY_TOPIC_TITLE,
                    type: TopicType.NORMAL,
                    helpPath: helpPath
                };
                return topic;
            });
        }

        const descriptionTopic: Topic = {
            name: 'DESCRIPTION',
            description: '',
            helpPath: `/library/${pkgName}/DESCRIPTION`,
            type: TopicType.META
        };

        const indexTopic: Topic = {
            name: 'Index',
            description: '',
            helpPath: `/library/${pkgName}/html/00Index.html`,
            type: TopicType.INDEX
        };
        topics.unshift(indexTopic, descriptionTopic);
        return topics;
    }

}

// Helper function to parse a request path
// Accepts e.g. paths of the forms
// - library/PKG/html/TOPIC
// - library/PKG/help/TOPIC
// - library/PKG/help/TOPIC.html/....
// - library/PKG/TOPIC
function parseRequestPath(requestPath: string): {
    pkg?: string,
    topic?: string
} {
    const re = /^\/?library\/([^/]*)\/(?:html|help)?\/?([^/]*?)(?:\.html.*)?$/;
    const m = re.exec(requestPath);
    return {
        pkg: m?.[1],
        topic: m?.[2].replace(/^dot-/, '.')
    };
}

// Convert a single rdAlias to a (summarized) tree view topic entry
function rdAliasToTreeViewTopic(rdAlias: RdAlias, pkgName: string): Topic {
    const ret: Topic = {
        helpPath: `/library/${pkgName}/html/${rdAlias.name}.html`,
        name: rdAlias.title || rdAlias.name || DUMMY_TOPIC_TITLE,
        type: TopicType.NORMAL,
        aliases: rdAlias.aliases,
        description: rdAlias.title || DUMMY_TOPIC_TITLE
    };
    return ret;
}


// Helper functions to read/convert rdAliases and aliases

function rdAliasToAliases(rdAlias: RdAlias, pkgName: string): AliasExtra[] {
    return rdAlias.aliases.map(alias => ({
        package: pkgName,
        name: rdAlias.name,
        alias: alias,
        title: rdAlias.title,
        rdPath: rdAlias.filepath
    }));
}

function getRdAliases(manDir: string): RdAlias[] {
    const manFiles = fs.readdirSync(manDir) || [];
    const aliases: RdAlias[] = [];
    manFiles.forEach(filename => {
        if(!filename.match(/\.[Rr][Dd]$/)){
            return;
        }
        const fullPath = path.join(manDir, filename);
        const rdAlias = getRdAlias(fullPath);
        if(rdAlias){
            aliases.push(rdAlias);
        }
    });
    return aliases;
}

function getRdAlias(rdFile: string): RdAlias | undefined {
    const txt = readFileSyncSafe(rdFile, 'utf-8');
    if(!txt){
        return undefined;
    }
    const nameMatch = txt.match(/\\name\{(.*)\}/);
    const name = nameMatch?.[1];
    if(!name){
        return undefined;
    }
    const ret: RdAlias = {
        filepath: rdFile,
        name: name,
        aliases: []
    };
    const titleMatch = txt.match(/\\title\{(.*)\}/);
    ret.title = titleMatch?.[1];
    const aliasMatches = txt.matchAll(/\\alias\{(.*)\}/g);
    for (const m of aliasMatches) {
        ret.aliases.push(m[1]);
    }
    return ret;
}
