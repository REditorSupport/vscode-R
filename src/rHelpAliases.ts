

import * as cp from 'child_process';

import * as rHelp from './rHelp';

interface PackageAliases {
    package?: string;
    libPath?: string;
    aliasFile?: string;
    aliases?: {
        [key: string]: string;
    }
}


export interface AliasProviderArgs {
	// R path, must be vanilla R
	rPath: string;
	// getAliases.R
    rScriptFile: string;
}

// Implements the aliasProvider required by the help panel
export class AliasProvider {

    private readonly rPath: string;
    private readonly rScriptFile: string;
    private allPackageAliases?: null | {
        [key: string]: PackageAliases;
    }
    private aliases?: null | rHelp.Alias[];

    constructor(args: AliasProviderArgs){
        this.rPath = args.rPath;
        this.rScriptFile = args.rScriptFile;
    }

    // delete stored aliases, will be generated on next request
    public refresh(): void {
        this.aliases = null;
        this.allPackageAliases = null;
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
    }
}
