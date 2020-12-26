/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import * as vscode from 'vscode';
import * as http from 'http';
import * as cp from 'child_process';
import * as kill from 'tree-kill';

import * as rHelp from './rHelp';


export interface RHelpProviderOptions {
	// path of the R executable
    rPath: string;
	// directory in which to launch R processes
	cwd?: string;
}

// Class to forward help requests to a backgorund R instance that is running a help server
export class HelpProvider {
    private cp: cp.ChildProcess;
    private port: number|Promise<number>;
    private readonly rPath: string;
    private readonly cwd?: string;

    public constructor(options: RHelpProviderOptions){
        this.rPath = options.rPath || 'R';
        this.cwd = options.cwd;
        this.port = this.launchRHelpServer(); // is a promise for now!
    }

    public refresh(): void {
        kill(this.cp.pid); // more reliable than cp.kill (?)
        this.port = this.launchRHelpServer();
    }

    public async launchRHelpServer(): Promise<number>{
		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');

        // starts the background help server and waits forever to keep the R process running
        const cmd = (
            `${this.rPath} --silent --slave --no-save --no-restore -e ` +
            `"cat('${lim}', tools::startDynamicHelp(), '${lim}', sep=''); while(TRUE) Sys.sleep(1)" ` 
        );
        const cpOptions = {
            cwd: this.cwd
        };
        this.cp = cp.exec(cmd, cpOptions);

        let str = '';
        // promise containing the first output of the r process (contains only the port number)
        const outputPromise = new Promise<string>((resolve, reject) => {
            this.cp.stdout.on('data', (data) => {
                str += data.toString();
                if(re.exec(str)){
                    resolve(str.replace(re, '$1'));
                }
            });
            this.cp.on('close', () => {
                reject();
            });
        });

        // await and store port number
        const output = await outputPromise;
        const port = Number(output);

        // is returned as a promise if not called with "await":
        return port;
    }

	public async getHelpFileFromRequestPath(requestPath: string): Promise<null|rHelp.HelpFile> {
        // make sure the server is actually running
        this.port = await this.port;

        if(!this.port || typeof this.port !== 'number'){
            return null;
        }

        // remove leading '/'
        while(requestPath.startsWith('/')){
            requestPath = requestPath.substr(1);
        }

        interface HtmlResult {
            content?: string,
            redirect?: string
        }
    
        // forward request to R instance
        // below is just a complicated way of getting a http response from the help server
        let url = `http://localhost:${this.port}/${requestPath}`;
        let html = '';
        const maxForwards = 3;
        for (let index = 0; index < maxForwards; index++) {
            const htmlPromise = new Promise<HtmlResult>((resolve, reject) => {
                let content = '';
                http.get(url, (res: http.IncomingMessage) => {
                    if(res.statusCode === 302){
                        resolve({redirect: res.headers.location});
                    } else{
                        res.on('data', (chunk) => {
                            content += chunk.toString();
                        });
                        res.on('close', () => {
                            resolve({content: content});
                        });
                        res.on('error', () => {
                            reject();
                        });
                    }
                });
            });
            const htmlResult = await htmlPromise;
            if(htmlResult.redirect){
                const newUrl = new URL(htmlResult.redirect, url);
                requestPath = newUrl.pathname;
                url = newUrl.toString();
            } else{
                html = htmlResult.content || '';
                break;
            }
        }

        // return help file
        const ret: rHelp.HelpFile = {
            requestPath: requestPath,
            html: html,
            isRealFile: false,
            url: url
        };
        return ret;
    }


    dispose(): void {
        if(this.cp){
            kill(this.cp.pid);
        }
    }
}


export interface AliasProviderArgs {
	// R path, must be vanilla R
	rPath: string;
	// getAliases.R
    rScriptFile: string;
    
    persistentState: vscode.Memento;
}

interface PackageAliases {
    package?: string;
    libPath?: string;
    aliasFile?: string;
    aliases?: {
        [key: string]: string;
    }
}

// Implements the aliasProvider required by the help panel
export class AliasProvider {

    private readonly rPath: string;
    private readonly rScriptFile: string;
    private allPackageAliases?: null | {
        [key: string]: PackageAliases;
    }
    private aliases?: null | rHelp.Alias[];
	private readonly persistentState?: vscode.Memento;

    constructor(args: AliasProviderArgs){
        this.rPath = args.rPath;
        this.rScriptFile = args.rScriptFile;
        this.persistentState = args.persistentState;
    }

    // delete stored aliases, will be generated on next request
    public refresh(): void {
        this.aliases = null;
        this.allPackageAliases = null;
        if(this.persistentState){
            void this.persistentState.update('r.helpPanel.cachedPackageAliases', undefined);
        }
    }

    // get all aliases that match the given name, if specified only from 1 package
    public getAliasesForName(name: string, pkgName?: string): rHelp.Alias[] | null {
        const aliases = this.getAliasesForPackage(pkgName);
        if(aliases){
            return aliases.filter((v) => v.name === name);
        } else{
            return null;
        }
    }

    // get a list of all aliases
    public getAllAliases(): rHelp.Alias[] {
        if(!this.aliases){
            this.makeAllAliases();
        }
        return this.aliases;
    }

    // get all aliases, grouped by package
    private getPackageAliases() {
        if(!this.allPackageAliases){
            this.readAliases();
        }
        return this.allPackageAliases;
    }

    // get all aliases provided by one package
    private getAliasesForPackage(pkgName?: string): rHelp.Alias[] | null {
        if(!pkgName){
            return this.getAllAliases();
        }
        const packageAliases = this.getPackageAliases();
        if(pkgName in packageAliases){
            const al = packageAliases[pkgName].aliases;
            if(al){
                const ret: rHelp.Alias[] = [];
                for(const fncName in al){
                    ret.push({
                        name: fncName,
                        alias: al[fncName],
                        package: pkgName
                    });
                }
                return ret;
            }
        }
        return null;
    }

    // converts aliases grouped by package to a flat list of aliases
    private makeAllAliases(): void {
        if(!this.allPackageAliases){
            this.readAliases();
        }
        if(this.allPackageAliases){
            const ret: rHelp.Alias[] = [];
            for(const pkg in this.allPackageAliases){
                const pkgName = this.allPackageAliases[pkg].package || pkg;
                const al = this.allPackageAliases[pkg].aliases;
                if(al){
                    for(const fncName in al){
                        ret.push({
                            name: fncName,
                            alias: al[fncName],
                            package: pkgName
                        });
                    }
                }
            }
            this.aliases = ret;
        } else{
            this.aliases = null;
        }
    }

    // call R script `getAliases.R` and parse the output
    private readAliases(): void {
        // read from persistent workspace cache
        if(this.persistentState){
            const cachedAliases = this.persistentState.get<{[key: string]: PackageAliases}>('r.helpPanel.cachedPackageAliases', undefined);
            if(cachedAliases){
                this.allPackageAliases = cachedAliases;
                return;
            }
        }

        // get from R
        this.allPackageAliases = null; 
		const lim = '---vsc---'; // must match the lim used in R!
		const re = new RegExp(`^.*?${lim}(.*)${lim}.*$`, 'ms');
        const cmd = `${this.rPath} --silent --no-save --no-restore --slave -f "${this.rScriptFile}"`;
        try{
            const txt = cp.execSync(cmd, {encoding: 'utf-8'});
            const json = txt.replace(re, '$1');
            if(json){
                this.allPackageAliases = <{[key: string]: PackageAliases}> JSON.parse(json) || {};
            }
        } catch(e){
            // do nothing
        }
        // update persistent workspace cache
        if(this.persistentState){
            void this.persistentState.update('r.helpPanel.cachedPackageAliases', this.allPackageAliases);
        }
    }
}

