import { Memento, window } from 'vscode';
import * as nodeFetch from 'node-fetch';
import * as cp from 'child_process';

import * as rHelp from '.';
import { extensionContext } from '../extension';
import { catchAsError, config, DisposableProcess, getRLibPaths, spawn, spawnAsync } from '../util';

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
        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-e',
            'base::source(base::commandArgs(TRUE))',
            '--args',
            scriptPath
        ];
        const cpOptions = {
            cwd: this.cwd,
            env: {
                ...process.env,
                VSCR_LIB_PATHS: getRLibPaths(),
                VSCR_LIM: lim,
                VSCR_USE_RENV_LIB_PATH: config().get<boolean>('useRenvLibPath') ? 'TRUE' : 'FALSE'
            },
        };

        const childProcess: ChildProcessWithPort = spawn(this.rPath, args, cpOptions);

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
            requestPath = requestPath.slice(1);
        }

        // forward request to R instance
        const url = `http://localhost:${port}/${requestPath}`;
        const rep = await nodeFetch.default(url);
        if(rep.status !== 200){
            return undefined;
        }
        const html = await rep.text();

        // read "corrected" request path, that was forwarded to
        const requestPath1 = rep.url.replace(/^http:\/\/localhost:[0-9]*\//, '');

        // return help file
        const ret: rHelp.HelpFile = {
            requestPath: requestPath1,
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
    },
    error?: string
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
        await this.makeAllAliases();
    }

    // get a list of all aliases
    public async getAllAliases(): Promise<rHelp.Alias[] | undefined> {
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
        const newAliases = await this.makeAllAliases();
        this.aliases = newAliases;
        await this.persistentState?.update('r.helpPanel.cachedAliases', newAliases);
        return newAliases;
    }

    // converts aliases grouped by package to a flat list of aliases
    private async makeAllAliases(): Promise<rHelp.Alias[] | undefined> {
        // get aliases from R (nested format)
        const allPackageAliases = await this.getAliasesFromR();
        if(!allPackageAliases){
            return undefined;
        }

        // flatten aliases into one list:
        const allAliases: rHelp.Alias[] = [];
        for (const pkg in allPackageAliases) {
            const item = allPackageAliases[pkg];
            const pkgName = item.package || pkg;

            if (item.error) {
                void window.showErrorMessage(`An error occurred while reading the aliases file for package ${pkgName}: ${item.error}. The package files may be corrupted. Try reinstalling the package.`);
                continue;
            }

            const pkgAliases = item.aliases || {};
            for(const fncName in pkgAliases){
                allAliases.push({
                    name: pkgAliases[fncName],
                    alias: fncName,
                    package: pkgName
                });
            }
        }
        return allAliases;
    }

    // call R script `getAliases.R` and parse the output
    private async getAliasesFromR(): Promise<undefined | AllPackageAliases> {
        const lim = '---vsc---';
        const options: cp.CommonOptions = {
            cwd: this.cwd,
            env: {
                ...process.env,
                VSCR_LIB_PATHS: getRLibPaths(),
                VSCR_LIM: lim,
                VSCR_USE_RENV_LIB_PATH: config().get<boolean>('useRenvLibPath') ? 'TRUE' : 'FALSE'
            }
        };

        const args = [
            '--silent',
            '--slave',
            '--no-save',
            '--no-restore',
            '-f',
            this.rScriptFile
        ];

        try {
            const result = await spawnAsync(this.rPath, args, options);
            if (result.status !== 0) {
                throw result.error || new Error(result.stderr);
            }
            const re = new RegExp(`${lim}(.*)${lim}`, 'ms');
            const match = re.exec(result.stdout);
            if (match?.length !== 2) {
                throw new Error('Could not parse R output.');
            }
            const json = match[1];
            return <AllPackageAliases>JSON.parse(json) || {};
        } catch (e) {
            console.log(e);
            void window.showErrorMessage(catchAsError(e).message);
        }
    }
}
