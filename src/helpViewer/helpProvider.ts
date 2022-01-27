
import { Memento, window } from 'vscode';
import * as http from 'http';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import * as rHelp from '.';
import { extensionContext } from '../extension';
import { DisposableProcess, exec } from '../util';

export interface RHelpProviderOptions {
	// path of the R executable
    rPath: string;
	// directory in which to launch R processes
	cwd?: string;
    // listener to notify when new packages are installed
    pkgListener?: () => void;
}

type ChildProcessWithPort = DisposableProcess & {
    port?: number | Promise<number>;
};

// Class to forward help requests to a backgorund R instance that is running a help server
export class HelpProvider {
    private cp: ChildProcessWithPort;
    private readonly rPath: string;
    private readonly cwd?: string;
    private readonly pkgListener?: () => void;

    public constructor(options: RHelpProviderOptions){
        this.rPath = options.rPath || 'R';
        this.cwd = options.cwd;
        this.pkgListener = options.pkgListener;
        this.cp = this.launchRHelpServer();
    }

    public async refresh(): Promise<void> {
        this.cp.dispose();
        this.cp = this.launchRHelpServer();
        await this.cp.port;
    }

    public launchRHelpServer(): ChildProcessWithPort{
		const lim = '---vsc---';
		const portRegex = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
        
        const newPackageRegex = new RegExp('NEW_PACKAGES');

        // starts the background help server and waits forever to keep the R process running
        const scriptPath = extensionContext.asAbsolutePath('R/help/helpServer.R');
        // const cmd = `${this.rPath} --silent --slave --no-save --no-restore -f "${scriptPath}"`;
        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-f',
            scriptPath
        ];
        const cpOptions = {
            cwd: this.cwd,
            env: { ...process.env, 'VSCR_LIM': lim },
        };

        const childProcess: ChildProcessWithPort = exec(this.rPath, args, cpOptions);

        let str = '';
        // promise containing the port number of the process (or 0)
        const portPromise = new Promise<number>((resolve) => {
            childProcess.stdout?.on('data', (data) => {
                try{
                    // eslint-disable-next-line
                    str += data.toString();
                } catch(e){
                    resolve(0);
                }
                if(portRegex.exec(str)){
                    resolve(Number(str.replace(portRegex, '$1')));
                    str = str.replace(portRegex, '');
                }
                if(newPackageRegex.exec(str)){
                    this.pkgListener?.();
                    str = str.replace(newPackageRegex, '');
                }
            });
            childProcess.on('close', () => {
                resolve(0);
            });
        });
        
        const exitHandler = () => {
            childProcess.port = 0;
        };
        childProcess.on('exit', exitHandler);
        childProcess.on('error', exitHandler);

        // await and store port number
        childProcess.port = portPromise;

        // is returned as a promise if not called with "await":
        return childProcess;
    }

	public async getHelpFileFromRequestPath(requestPath: string): Promise<undefined|rHelp.HelpFile> {

        const port = await this.cp?.port;
        if(!port || typeof port !== 'number'){
            return undefined;
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
        let url = `http://localhost:${port}/${requestPath}`;
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
                            try{
                                // eslint-disable-next-line
                                content += chunk.toString();
                            } catch(e){
                                reject();
                            }
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
        this.cp.dispose();
    }
}


export interface AliasProviderArgs {
	// R path, must be vanilla R
	rPath: string;
    // cwd
    cwd?: string;
	// getAliases.R
    rScriptFile: string;

    persistentState: Memento;
}

interface PackageAliases {
    package?: string;
    libPath?: string;
    aliasFile?: string;
    aliases?: {
        [key: string]: string;
    }
}
interface AllPackageAliases {
    [key: string]: PackageAliases
}

// Implements the aliasProvider required by the help panel
export class AliasProvider {

    private readonly rPath: string;
    private readonly cwd?: string;
    private readonly rScriptFile: string;
    private aliases?: undefined | rHelp.Alias[];
	private readonly persistentState?: Memento;

    constructor(args: AliasProviderArgs){
        this.rPath = args.rPath;
        this.cwd = args.cwd;
        this.rScriptFile = args.rScriptFile;
        this.persistentState = args.persistentState;
    }

    // delete stored aliases, will be generated on next request
    public async refresh(): Promise<void> {
        this.aliases = undefined;
        await this.persistentState?.update('r.helpPanel.cachedAliases', undefined);
        this.makeAllAliases();
    }

    // get a list of all aliases
    public getAllAliases(): rHelp.Alias[] | undefined {
        // try this.aliases:
        if(this.aliases){
            return this.aliases;
        }
        
        // try cached aliases:
        const cachedAliases = this.persistentState?.get<rHelp.Alias[]>('r.helpPanel.cachedAliases');
        if(cachedAliases){
            this.aliases = cachedAliases;
            return cachedAliases;
        }
        
        // try to make new aliases (returns undefined if unsuccessful):
        const newAliases = this.makeAllAliases();
        this.aliases = newAliases;
        this.persistentState?.update('r.helpPanel.cachedAliases', newAliases);
        return newAliases;
    }

    // converts aliases grouped by package to a flat list of aliases
    private makeAllAliases(): rHelp.Alias[] | undefined {
        // get aliases from R (nested format)
        const allPackageAliases = this.getAliasesFromR();
        if(!allPackageAliases){
            return undefined;
        }
        
        // flatten aliases into one list:
        const allAliases: rHelp.Alias[] = [];
        for(const pkg in allPackageAliases){
            const pkgName = allPackageAliases[pkg].package || pkg;
            const pkgAliases = allPackageAliases[pkg].aliases || {};
            for(const fncName in pkgAliases){
                allAliases.push({
                    name: fncName,
                    alias: pkgAliases[fncName],
                    package: pkgName
                });
            }
        }
        return allAliases;
    }

    // call R script `getAliases.R` and parse the output
    private getAliasesFromR(): undefined | AllPackageAliases {

        // get from R
		const lim = '---vsc---'; // must match the lim used in R!
		const re = new RegExp(`^.*?${lim}(.*)${lim}.*$`, 'ms');
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-R-aliases'));
        const tempFile = path.join(tempDir, 'aliases.json');
        const cmd = `"${this.rPath}" --silent --no-save --no-restore --slave -f "${this.rScriptFile}" > "${tempFile}"`;

        let allPackageAliases: undefined | AllPackageAliases = undefined;
        try{
            // execute R script 'getAliases.R'
            // aliases will be written to tempFile
            cp.execSync(cmd, { cwd: this.cwd });

            // read and parse aliases
            const txt = fs.readFileSync(tempFile, 'utf-8');
            const json = txt.replace(re, '$1');
            if(json){
                allPackageAliases = <{[key: string]: PackageAliases}> JSON.parse(json) || {};
            }
        } catch(e: unknown){
            console.log(e);
            void window.showErrorMessage((<{message: string}>e).message);
        } finally {
            fs.rmdirSync(tempDir, {recursive: true});
        }
        return allPackageAliases;
    }
}
