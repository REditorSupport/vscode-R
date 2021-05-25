
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Alias } from '.';
import * as rHelp from '.';
import * as util from '../util';
import { IHelpProvider, IAliasProvider } from './helpProvider';



export class HelpProvider implements IHelpProvider, IAliasProvider {
    
    private packageDir: string;
    private descriptionPath: string;

    constructor(options: {cwd?: string}){
        this.packageDir = options.cwd || '';
        this.descriptionPath = path.join(this.packageDir, 'DESCRIPTION');
    }
    
    public refresh(): void {
        // pass
    }
    
    public async getHelpFileFromRequestPath(requestPath: string): Promise<undefined|rHelp.HelpFile> {
        
        // const m = /
        const re = /^\/?library\/([^/]*)\/html\/([^/]*).html.*$/;
        const m = re.exec(requestPath);
        const pkg = m?.[1];
        const topic = m?.[2];
        
        if(!pkg || !topic){
            console.log(`Invalid path: ${requestPath}`);
            return undefined;
        } else if(pkg !== this.getPackageName()){
            console.log(`Package name does not match: ${pkg}`);
            return undefined;
        }
        
        console.log(`Open topic: ${topic}`);
        
        const htmlAndFilePath = await this.getHtml(topic);
        
        if(htmlAndFilePath){
            
            fs.writeFileSync(path.join(this.packageDir, 'test.html'), htmlAndFilePath.html);
            const ret: rHelp.HelpFile = {
                requestPath: requestPath,
                html: htmlAndFilePath.html,
                filePath: htmlAndFilePath.filePath,
                isRealFile: true
            };
            return ret;
        }
        
        return undefined;
    }
    
    private getPackageName(): string | undefined {
        if(!fs.existsSync(this.descriptionPath)) {
            return undefined;
        }
        const desc = fs.readFileSync(this.descriptionPath, 'utf-8');
        const m = /^Package:\s*(.*?)\s*$/m.exec(desc);
        const pkgName = m?.[1];
        return pkgName;
    }
    
    private async getHtml(topic: string): Promise<{html: string, filePath: string} | undefined> {
        const rdFileName = path.join(this.packageDir, 'man', `${topic}.Rd`);
        if(!fs.existsSync(rdFileName)){
            return undefined;
        }
        const rPath = await util.getRpath(true);
        const cmd = `${rPath} CMD Rdconv --type=html ${rdFileName}`;
		const options: cp.ExecSyncOptionsWithStringEncoding = {
			encoding: 'utf-8'
		};
        let html = '';
        try{
            html = cp.execSync(cmd, options);
        } catch(e){
            console.log(`Failed to convert .Rd file: ${rdFileName}`);
            console.log(e);
            return undefined;
        }
        
        return {
            filePath: rdFileName,
            html: html
        };
    }

    getAliasesForName(name: string, pkgName?: string): Alias[] | undefined {
        const aliases = this.getAliases();
        return aliases.filter(v => (
            v.name === name && (!pkgName || pkgName === v.package)
        ));
    }
    getAllAliases(): Alias[] | undefined {
        return this.getAliases();
    }
    private getAliases(): Alias[] | undefined {
        const manDir = path.join(this.packageDir, 'man');
        if(!fs.existsSync(manDir)){
            return undefined;
        }
        const pkgName = this.getPackageName();
        const files = fs.readdirSync(manDir, 'utf-8');
        const rdFiles = files.filter(v => /\.Rd$/.exec(v));
        const aliases: Alias[] = rdFiles.map(v => {
            const alias = v.replace(/\.Rd$/, '');
            const name = alias.replace(/^dot-/, '.');
            return {
                package: pkgName,
                alias: alias,
                name: name
            };
        });
        return aliases;
    }
}
