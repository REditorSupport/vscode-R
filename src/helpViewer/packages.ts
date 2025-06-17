
import * as cheerio from 'cheerio';
import * as vscode from 'vscode';

import { RHelp } from '.';
import { getConfirmation, executeAsTask, doWithProgress, getCranUrl } from '../util';
import { getPackagesFromCran } from './cran';


// This file implements a rudimentary 'package manager'
// The exported class PackageManager contains methods to
//  * list installed packages
//  * list help topics from a package
//  * let the user pick a package and/or help topic
//  * remove installed packages
//  * install packages, selected from CRAN using a quickpick


// Types of help topics
export enum TopicType {
    // "Home page" of a package, e.g. .../base-package.html
    HOME,
    // An Index file, e.g. list of packages or list of topics in a package
    INDEX,
    // E.g. DESCRIPTION
    META,
    // Regular help topic containing help about an R function etc.
    NORMAL
}


// interface containing information about an individual help topic
export interface Topic {
    name: string;
    description: string;
    type: TopicType;
    aliases?: string[];
    helpPath: string;
}
interface TopicExtra extends Topic {
    href: string;
}


// interface containing info about a package
// can be either installed locally or parsed from the CRAN website
export interface Package {
    name: string;
    description: string;

    href?: string;
    date?: string;

    helpPath?: string;

    isFavorite?: boolean;
    isRecent?: boolean;

    isCran?: boolean;
    isInstalled?: boolean;
}

export interface IndexEntry {
    name: string;
    description: string;
    href?: string;
}

type CachedIndexFiles = {path: string, items: IndexEntry[] | undefined}[];


export interface PackageManagerOptions {
    rPath: string,
    rHelp: RHelp,
    persistentState: vscode.Memento,
    cwd?: string
}


export class PackageManager {

    readonly rHelp: RHelp;

    readonly state: vscode.Memento;

    readonly cwd?: string;

    // names of packages to be highlighted in the package list
    // public favoriteNames: string[] = [];

    public favoriteNames: Set<string> = new Set();


    constructor(args: PackageManagerOptions){
        this.rHelp = args.rHelp;
        this.state = args.persistentState;
        this.cwd = args.cwd;
        this.pullFavoriteNames();
    }

    // Functions to force a refresh of listed packages
    // Useful e.g. after installing/removing packages
    public async refresh(): Promise<void> {
        await this.clearCachedFiles();
        this.pullFavoriteNames();
    }

    // Funciton to clear only the cached files regarding an individual package etc.
    public async clearCachedFiles(re?: string|RegExp): Promise<void> {
        let cache: CachedIndexFiles | undefined;
        if(re){
            const oldCache = this.state.get<CachedIndexFiles>('r.helpPanel.cachedIndexFiles', []);
            cache = oldCache.filter(v => !(
                (typeof re === 'string' && v.path === re)
                || (typeof re !== 'string' && re.exec(v.path))
            ));
        } else{
            cache = undefined;
        }
        await this.state.update('r.helpPanel.cachedIndexFiles', cache);
    }

    // Function to add/remove packages from favorites
    public addFavorite(pkgName: string): string[] {
        this.pullFavoriteNames();
        this.favoriteNames.add(pkgName);
        this.pushFavoriteNames();
        return [...this.favoriteNames.values()];
    }
    public removeFavorite(pkgName: string): string[] {
        this.pullFavoriteNames();
        this.favoriteNames.delete(pkgName);
        this.pushFavoriteNames();
        return [...this.favoriteNames.values()];
    }

    // return the index file if cached, else undefined
    private getCachedIndexFile(path: string): IndexEntry[] | undefined {
        const cache = this.state.get<CachedIndexFiles>('r.helpPanel.cachedIndexFiles', []);
        const ind = cache.findIndex(v => v.path === path);
        if(ind < 0){
            return undefined;
        } else{
            return cache[ind].items;
        }
    }

    // Save a new file to the cache (or update existing entry)
    private async updateCachedIndexFile(path: string, items: IndexEntry[] | undefined): Promise<void>{
        const cache = this.state.get<CachedIndexFiles>('r.helpPanel.cachedIndexFiles', []);
        const ind = cache.findIndex(v => v.path === path);
        if(ind < 0){
            cache.push({
                path: path,
                items: items
            });
        } else{
            cache[ind].items = items;
        }
        await this.state.update('r.helpPanel.cachedIndexFiles', cache);
    }

    // Private functions used to sync favoriteNames with global state / workspace state
    // Is used frequently when list of favorites is shared globally to sync between sessions
    private pullFavoriteNames(){
        if(this.state){
            this.favoriteNames = this.state.get('r.helpPanel.favoriteNamesSet') || this.favoriteNames;
        }
    }
    private pushFavoriteNames(){
        if(this.state){
            void this.state.update('r.helpPanel.favoriteNamesSet', this.favoriteNames);
        }
    }

    // let the user pick and install a package from CRAN
    public async pickAndInstallPackages(pickMany: boolean = false): Promise<boolean> {
        const packages = await doWithProgress(() => this.getPackages(true), this.rHelp.treeViewWrapper.viewId);
        if(!packages?.length){
            return false;
        }
        const pkgs = await pickPackages(packages, 'Please select a package.', pickMany);
        if(pkgs?.length){
            const pkgsConfirmed = await confirmPackages('Are you sure you want to install these packages?', pkgs);
            if(pkgsConfirmed?.length){
                const names = pkgsConfirmed.map(v => v.name);
                return await this.installPackages(names, true);
            }
        }
        return false;
    }

    // remove a specified package. The packagename is selected e.g. in the help tree-view
    public async removePackage(pkgName: string): Promise<boolean> {
        const rPath = this.rHelp.rPath;
        const args = ['--silent', '--no-echo', '--no-save', '--no-restore', '-e', `remove.packages('${pkgName}')`];
        const cmd = `${rPath} ${args.join(' ')}`;
        const confirmation = 'Yes, remove package!';
        const prompt = `Are you sure you want to remove package ${pkgName}?`;

        if(await getConfirmation(prompt, confirmation, cmd)){
            await executeAsTask('Remove Package', rPath, args, true);
            return true;
        } else{
            return false;
        }
    }

    // actually install packages
    // confirmation can be skipped (e.g. if the user has confimred before)
    public async installPackages(pkgNames: string[], skipConfirmation: boolean = false): Promise<boolean> {
        const rPath = this.rHelp.rPath;
        const cranUrl = await getCranUrl('', this.cwd);
        const args = [`--silent`, '--no-echo', `-e`, `install.packages(c(${pkgNames.map(v => `'${v}'`).join(',')}),repos='${cranUrl}')`];
        const cmd = `${rPath} ${args.join(' ')}`;
        const pluralS = pkgNames.length > 1? 's' : '';
        const confirmation = `Yes, install package${pluralS}!`;
        const prompt = `Are you sure you want to install package${pluralS}: ${pkgNames.join(', ')}?`;

        if(skipConfirmation || await getConfirmation(prompt, confirmation, cmd)){
            await executeAsTask('Install Package', rPath, args, true);
            return true;
        }
        return false;
    }

    public async updatePackages(skipConfirmation: boolean = false): Promise<boolean> {
        const rPath = this.rHelp.rPath;
        const cranUrl = await getCranUrl('', this.cwd);
        const args = ['--silent', '--no-echo', '--no-save', '--no-restore', '-e', `update.packages(ask=FALSE,repos='${cranUrl}')`];
        const cmd = `${rPath} ${args.join(' ')}`;
        const confirmation = 'Yes, update all packages!';
        const prompt = 'Are you sure you want to update all installed packages? This might take some time!';

        if(skipConfirmation || await getConfirmation(prompt, confirmation, cmd)){
            await executeAsTask('Update Packages', rPath, args, true);
            return true;
        } else{
            return false;
        }
    }

    public async getPackages(fromCran: boolean = false): Promise<Package[]|undefined> {
        let packages: Package[]|undefined;
        this.pullFavoriteNames();
        if(fromCran){
            // Use a placeholder, since multiple different urls are attempted
            const CRAN_PATH_PLACEHOLDER = 'CRAN_PATH_PLACEHOLDER';

            packages = this.getCachedIndexFile(CRAN_PATH_PLACEHOLDER);
            if(!packages?.length){
                const cranUrl = await getCranUrl('', this.cwd);
                packages = await getPackagesFromCran(cranUrl);
                await this.updateCachedIndexFile(CRAN_PATH_PLACEHOLDER, packages);
            }
        } else{
            packages = await this.getParsedIndexFile(`/doc/html/packages.html`);
            if(!packages?.length){
                void vscode.window.showErrorMessage('Help provider not available!');
            }
        }
        if(packages){
            for(const pkg of packages){
                pkg.isFavorite = this.favoriteNames.has(pkg.name);
                pkg.helpPath = (
                    pkg.name === 'doc' ?
                        '/doc/html/packages.html' :
                        `/library/${pkg.name}/html/00Index.html`
                );
            }
        }
        return packages;
    }


    // parses a package's index file to produce a list of help topics
    // highlights ths 'home' topic and adds entries for the package index and DESCRIPTION file
    public async getTopics(pkgName: string, summarize: boolean = false): Promise<Topic[] | undefined> {

        const indexEntries = await this.getParsedIndexFile(`/library/${pkgName}/html/00Index.html`);

        if(!indexEntries){
            return undefined;
        }

        const topics: TopicExtra[] = indexEntries.map(v => {
            const topic: TopicExtra = {
                name: v.name,
                description: v.description,
                href: v.href || v.name,
                type: TopicType.NORMAL, //replaced below
                helpPath: '' // replaced below
            };

            topic.type = (topic.name === `${pkgName}-package` ? TopicType.HOME : TopicType.NORMAL);

            topic.helpPath = (
                pkgName === 'doc' ?
                    `/doc/html/${topic.href}` :
                    `/library/${pkgName}/html/${topic.href}`
            );
            return topic;
        });

        const ind = topics.findIndex(v => v.type === TopicType.HOME);
        let homeTopic: TopicExtra | undefined = undefined;
        if(ind >= 0){
            homeTopic = topics.splice(ind, 1)[0];
        }

        const indexTopic: TopicExtra = {
            name: 'Index',
            description: '',
            href: '00Index.html',
            helpPath: `/library/${pkgName}/html/00Index.html`,
            type: TopicType.INDEX
        };

        const descriptionTopic: TopicExtra = {
            name: 'DESCRIPTION',
            description: '',
            href: '../DESCRIPTION',
            helpPath: `/library/${pkgName}/DESCRIPTION`,
            type: TopicType.META
        };

        topics.unshift(indexTopic, descriptionTopic);
        if(homeTopic){
            topics.unshift(homeTopic);
        }

        const ret = (summarize ? summarizeTopics(topics) : topics);

        ret.sort((a, b) => {
            if(a.type === b.type){
                return a.name.localeCompare(b.name);
            } else{
                return a.type - b.type;
            }
        });

        return ret;
    }

    // retrieve and parse an index file
    // (either list of all packages, or documentation entries of a package)
    private async getParsedIndexFile(path: string): Promise<IndexEntry[]|undefined> {

        let indexItems = this.getCachedIndexFile(path);

        // only read and parse file if not cached yet
        if(!indexItems){
            const helpFile = await this.rHelp.getHelpFileForPath(path, false);
            if(!helpFile?.html){
                // set missing files to null
                indexItems = undefined;
            } else{
                // parse and cache file
                indexItems = parseIndexFile(helpFile.html);
            }
            void this.updateCachedIndexFile(path, indexItems);
        }

        // return cache entry. make new array to avoid messing with the cache
        let ret: IndexEntry[] | undefined = undefined;
        if(indexItems){
            ret = [];
            ret.push(...indexItems);
        }
        return ret;
    }
}


function parseIndexFile(html: string): IndexEntry[] {

    const $ = cheerio.load(html);

    const tables = $('table');

    const ret: IndexEntry[] = [];

    // loop over all tables on document and each row as one index entry
    // assumes that the provided html is from a valid index file
    tables.each((tableIndex, table) => {
        const rows = $('tr', table);
        rows.each((rowIndex, row) => {
            const elements = $('td', row);
            if(elements.length === 2){
                const e0 = elements[0];
                const e1 = elements[1];
                if(
                    e0.type === 'tag' && e1.type === 'tag' &&
                    e0.firstChild?.type === 'tag'
                ){
                    const href = e0.firstChild.attribs['href'];
                    const name = e0.firstChild?.firstChild?.data || '';
                    const description = e1.firstChild?.data || '';
                    ret.push({
                        name: name,
                        description: description,
                        href: href,
                    });
                }
            }
        });
    });

    const retSorted = ret.sort((a, b) => a.name.localeCompare(b.name));

    return retSorted;
}


// Used to let the user confirm their choice when installing/removing packages
async function confirmPackages(placeHolder: string, packages: Package[]): Promise<Package[]> {
    const qpItems: (vscode.QuickPickItem & {package: Package})[] = packages.map(pkg => ({
        label: pkg.name,
        detail: pkg.description,
        package: pkg,
        picked: true
    }));
    const qpOptions: vscode.QuickPickOptions = {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: placeHolder
    };
    const qp = await vscode.window.showQuickPick(qpItems, {...qpOptions, canPickMany: true});
    const ret = qp?.map(v => v.package) || [];
    return ret;
}

// Let the user pick a package, either from local installation or CRAN
async function pickPackages(packages: Package[], placeHolder: string, pickMany: boolean = false): Promise<Package[]|undefined> {
    if(!packages?.length){
        return undefined;
    }

    const qpItems: (vscode.QuickPickItem & {package: Package})[] = packages.map(pkg => ({
        label: pkg.name,
        detail: pkg.description,
        package: pkg
    }));

    const qpOptions: vscode.QuickPickOptions = {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: placeHolder
    };
    let ret: Package | Package[] | undefined;
    if(pickMany){
        const qp = await vscode.window.showQuickPick(qpItems, {...qpOptions, canPickMany: true});
        ret = qp?.map(v => v.package);
    } else{
        const qp = await vscode.window.showQuickPick(qpItems, qpOptions);
        ret = (qp ? [qp.package] : undefined);
    }

    return ret;
}

// Used to summarize index-entries that point to the same help file
function summarizeTopics(topics: Topic[]): Topic[] {
    const topicMap = new Map<string, Topic>();
    for(const topic of topics){
        if(topicMap.has(topic.helpPath)){
            const newTopic = <Topic>topicMap.get(topic.helpPath); // checked above that key is present
            if(newTopic.aliases){
                newTopic.aliases.push(topic.name);
            }
            // newTopic.topicType ||= topic.topicType;
            newTopic.type = (newTopic.type === TopicType.NORMAL ? topic.type : newTopic.type);
        } else{
            const newTopic: Topic = {
                ...topic,
            };
            if(newTopic.type === TopicType.NORMAL && newTopic.description){
                newTopic.aliases = [newTopic.name];
                [newTopic.name, newTopic.description] = [newTopic.description, newTopic.name];
            }
            topicMap.set(newTopic.helpPath, newTopic);
        }
    }
    const newTopics = [...topicMap.values()];
    return newTopics;
}
