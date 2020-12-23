
import * as cheerio from 'cheerio';
import * as http from 'http';
import * as vscode from 'vscode';

import { RHelp } from './rHelp';
import { getRpath, getConfirmation, executeAsTask, doWithProgress } from './util';
import { AliasProvider } from './rHelpProvider';


// This file implements a rudimentary 'package manager'
// The exported class PackageManager contains methods to
//  * list installed packages
//  * list help topics from a package
//  * let the user pick a package and/or help topic
//  * remove installed packages
//  * install packages, selected from CRAN using a quickpick


export enum TopicType {
    HOME,
    INDEX,
    META,
    NORMAL
}


// interface containing information about an individual help topic
export interface Topic {
    name: string;
    description: string;

    pkgName?: string;

    href?: string;

    helpPath?: string;

    type?: TopicType;

    aliases?: string[];

    isGrouped?: boolean;
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
export interface CranPackage extends Package {
    href: string;
    date: string;
    isCran: true;
}
export interface InstalledPackage extends Package {
    isInstalled: true;
}


// used to store package info parsed from /doc/html/00Index.html and /library/.../html/index.html
export interface IndexFileEntry {
    name: string;
    description: string;
    href?: string;
}

type CachedIndexFiles = {path: string, items: IndexFileEntry[] | null}[];


export interface PackageManagerOptions {
    rPath: string,
    rHelp: RHelp,
    persistentState: vscode.Memento
}

export class PackageManager {

    readonly cranUrl = 'http://cran.r-project.org/web/packages/available_packages_by_date.html';

	// the object that actually provides help pages:
    readonly rHelp: RHelp;
	readonly aliasProvider: AliasProvider;
    readonly state: vscode.Memento;

    public favoriteNames: string[] = [];

    constructor(args: PackageManagerOptions){
        this.rHelp = args.rHelp;
        this.state = args.persistentState;
        this.pullFavoriteNames();
    }

    public refresh(): void {
        this.pullFavoriteNames();
        void this.clearCachedFiles();
    }

	public async clearCachedFiles(re?: string|RegExp): Promise<void> {
        let cache: CachedIndexFiles;
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

    public addFavorite(pkgName: string): string[] {
        this.pullFavoriteNames();
        if(pkgName && this.favoriteNames.indexOf(pkgName) === -1){
            this.favoriteNames.push(pkgName);
        }
        this.pushFavoriteNames();
        return this.favoriteNames;
    }
    public removeFavorite(pkgName: string): string[] {
        this.pullFavoriteNames();
        const ind = this.favoriteNames.indexOf(pkgName);
        if(ind>=0){
            this.favoriteNames.splice(ind, 1);
        }
        this.pushFavoriteNames();
        return this.favoriteNames;
    }

    private getCachedIndexFile(path: string){
        const cache = this.state.get<CachedIndexFiles>('r.helpPanel.cachedIndexFiles', []);
        const ind = cache.findIndex(v => v.path === path);
        if(ind < 0){
            return undefined;
        } else{
            return cache[ind].items;
        }
    }

    private async updateCachedIndexFile(path: string, items: IndexFileEntry[] | null){
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

    // private functions used to sync favoriteNames with global state / workspace state
    private pullFavoriteNames(){
        if(this.state){
            this.favoriteNames = this.state.get('r.helpPanel.favoriteNames') || this.favoriteNames;
        }
    }
    private pushFavoriteNames(){
        if(this.state){
            void this.state.update('r.helpPanel.favoriteNames', this.favoriteNames);
        }
    }

    // let the user pick and install a package from CRAN 
    public async pickAndInstallPackage(): Promise<boolean> {
        const pkg = await this.pickPackage('Please selecte a package.', true);
        if(!pkg){
            return false;
        }
        const ret = await this.installPackage(pkg.name);
        return ret;
    }

    // remove a specified package. The packagename is selected e.g. in the help tree-view
    public async removePackage(pkgName: string): Promise<boolean> {
        const rPath = await getRpath(false);
        const args = ['--silent', '-e', `remove.packages('${pkgName}')`];
        const cmd = `${rPath} ${args.join(' ')}`;
        const confirmation = 'Yes, remove package!';
        const prompt = `Are you sure you want to remove package ${pkgName}?`;

        if(await getConfirmation(prompt, confirmation, cmd)){
            await executeAsTask('Remove Package', rPath, args);
            return true;
        } else{
            return false;
        }
    }

    public async installPackage(pkgName: string): Promise<boolean> {
        const rPath = await getRpath(false);
        const args = [`--silent`, `-e`, `install.packages('${pkgName}')`];
        const cmd = `${rPath} ${args.join(' ')}`;
        const confirmation = 'Yes, install package!';
        const prompt = `Are you sure you want to install package ${pkgName}?`;

        if(await getConfirmation(prompt, confirmation, cmd)){
            await executeAsTask('Install Package', rPath, args);
            return true;
        } else{
            return false;
        }
    }

    public async getPackages(fromCran: boolean = false): Promise<Package[]> {
        let packages: Package[];
        this.pullFavoriteNames();
        if(fromCran){
            packages = await this.getParsedCranFile(this.cranUrl);
        } else{
            packages = await this.getParsedIndexFile(`/doc/html/packages.html`);
        }
        if(packages){
            for(const pkg of packages){
                pkg.isFavorite = this.favoriteNames.includes(pkg.name);
                pkg.helpPath = (
                    pkg.name === 'doc' ?
                    '/doc/html/packages.html' :
                    `/library/${pkg.name}/html/00Index.html`
                );
            }
        }
        return packages;
    }

    // Let the user pick a package, either from local installation or CRAN
    public async pickPackage(placeHolder: string = '', fromCran: boolean = false): Promise<Package> {

        const packages = await doWithProgress(() => this.getPackages(fromCran));

		if(!packages || packages.length === 0){
			void vscode.window.showErrorMessage('Help provider not available!');
			return undefined;
		}

        const qpItems: (vscode.QuickPickItem & {package: Package})[] = packages.map(pkg => {
            return {
                label: pkg.name,
                detail: pkg.description,
                package: pkg
            };
        });
        const qpOptions: vscode.QuickPickOptions = {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: placeHolder
        };
        const qp = await vscode.window.showQuickPick(qpItems, qpOptions);
        
        return (qp ? qp.package : undefined);
    }

    // let the user pick a help topic from a package
    public async pickTopic(pkgName: string, placeHolder: string = '', summarize: boolean = false): Promise<Topic> {

        const topics = await this.getTopics(pkgName, summarize);

        const qpItems: (vscode.QuickPickItem & {topic: Topic})[] = topics.map(topic => {

            return {
                label: topic.name,
                description: topic.description,
                topic: topic
            };
        });

        const qp = await vscode.window.showQuickPick(qpItems, {
            placeHolder: placeHolder,
            matchOnDescription: true
        });

        return qp.topic;
    }

    // parses a package's index file to produce a list of help topics
    // highlights ths 'home' topic and adds entries for the package index and DESCRIPTION file
    public async getTopics(pkgName: string, summarize: boolean = false, skipMeta: boolean = false): Promise<Topic[]> {

        const indexEntries = await this.getParsedIndexFile(`/library/${pkgName}/html/00Index.html`);

        const topics: Topic[] = indexEntries.map(v => {
            const topic: Topic = {
                pkgName: pkgName,
                name: v.name,
                description: v.description,
                href: v.href || v.name
            };

            topic.type = (topic.name === `${topic.pkgName}-package` ? TopicType.HOME : TopicType.NORMAL);

            topic.helpPath = (
                topic.pkgName === 'doc' ?
                `/doc/html/${topic.href}` :
                `/library/${topic.pkgName}/html/${topic.href}`
            );
            return topic;
        });

        if(!skipMeta){
            const ind = topics.findIndex(v => v.type === TopicType.HOME);
            let homeTopic: Topic = undefined;
            if(ind >= 0){
                homeTopic = topics.splice(ind, 1)[0];
            }

            const indexTopic: Topic = {
                pkgName: pkgName,
                name: 'Index',
                description: '',
                href: '00Index.html',
                helpPath: `/library/${pkgName}/html/00Index.html`,
                type: TopicType.INDEX
            };

            const descriptionTopic: Topic = {
                pkgName: pkgName,
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
        }

        const ret = (summarize ? this.summarizeTopics(topics) : topics);

        ret.sort((a, b) => {
            if(a.type === b.type){
                return a.name.localeCompare(b.name);
            } else{
                return a.type - b.type;
            }
        });

        return ret;
    }

    // Used to summarize index-entries that point to the same help file
    public summarizeTopics(topics: Topic[]): Topic[] {
        const topicMap = new Map<string, Topic>();
        for(const topic of topics){
            if(topicMap.has(topic.helpPath)){
                const newTopic = topicMap.get(topic.helpPath);
                if(newTopic.aliases){
                    newTopic.aliases.push(topic.name);
                }
                // newTopic.topicType ||= topic.topicType;
                newTopic.type = (newTopic.type === TopicType.NORMAL ? topic.type : newTopic.type);
            } else{
                const newTopic: Topic = {
                    ...topic,
                    isGrouped: true
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


	// retrieve and parse an index file
	// (either list of all packages, or documentation entries of a package)
	public async getParsedIndexFile(path: string): Promise<IndexFileEntry[]> {

        let indexItems = this.getCachedIndexFile(path);

		// only read and parse file if not cached yet
		if(!indexItems){
			const helpFile = await this.rHelp.getHelpFileForPath(path, false);
			if(!helpFile || !helpFile.html){
				// set missing files to null
                indexItems = null;
			} else{
				// parse and cache file
				indexItems = this.parseIndexFile(helpFile.html);
			}
            void this.updateCachedIndexFile(path, indexItems);
		}

		// return cache entry. make new array to avoid messing with the cache
		const ret: IndexFileEntry[] = [];
		ret.push(...indexItems);
		return ret;
	}

	private parseIndexFile(html: string): IndexFileEntry[] {

		const $ = cheerio.load(html);

		const tables = $('table');

		const ret: IndexFileEntry[] = [];

		// loop over all tables on document and each row as one index entry
		// assumes that the provided html is from a valid index file
		tables.each((tableIndex, table) => {
			const rows = $('tr', table);
			rows.each((rowIndex, row) => {
				const elements = $('td', row);
				if(elements.length === 2){
					const href = elements[0].firstChild.attribs['href'];
					const name = elements[0].firstChild.firstChild.data || '';
					const description = elements[1].firstChild.data || '';
					ret.push({
						name: name,
						description: description,
						href: href,
					});
				}
			});
		});

		const retSorted = ret.sort((a, b) => a.name.localeCompare(b.name));

		return retSorted;
	}

    // retrieves and parses a list of packages from CRAN
	public async getParsedCranFile(url: string): Promise<Package[]> {

        // return cache entry if present
        const cacheEntry = this.getCachedIndexFile(url);
        if(cacheEntry){
            return cacheEntry;
        }

        // retrieve html from website
		const htmlPromise = new Promise<string>((resolve) => {
			let content = '';
			http.get(url, (res: http.IncomingMessage) => {
				res.on('data', (chunk: Buffer) => {
					content += chunk.toString();
				});
				res.on('close', () => {
					resolve(content);
				});
				res.on('error', () => {
					resolve('');
				});
			});
		});
		const html = await htmlPromise;

        // parse file
		const cranPackages = this.parseCranFile(html, url);

        // update cache and return
        void this.updateCachedIndexFile(url, cranPackages);
        const ret = [...cranPackages];
		return ret;
	}

	private parseCranFile(html: string, baseUrl: string): CranPackage[] {
		if(!html){
			return [];
		}
		const $ = cheerio.load(html);
		const tables = $('table');
		const ret: CranPackage[] = [];

		// loop over all tables on document and each row as one index entry
		// assumes that the provided html is from a valid index file
		tables.each((tableIndex, table) => {
			const rows = $('tr', table);
			rows.each((rowIndex, row) => {
				const elements = $('td', row);
				if(elements.length === 3){
					const href = elements[1].children[1].attribs['href'];
					const url = new URL(href, baseUrl).toString();
					ret.push({
						date: (elements[0].firstChild.data || '').trim(),
						name: (elements[1].children[1].firstChild.data || '').trim(),
						href: url,
						description: (elements[2].firstChild.data || '').trim(),
                        isCran: true
					});
				}
			});
		});

		const retSorted = ret.sort((a, b) => a.name.localeCompare(b.name));

		return retSorted;
	}

}




