


import * as cp from 'child_process';

import * as path from 'path';

import * as fs from 'fs';

import * as os from 'os';

import { randomBytes } from 'crypto';

import * as rHelpPanel from './rHelpPanel';


export interface RHelpOptions extends rHelpPanel.RHelpProviderOptions {
	// path of the R executable. Could be left out (with limited functionality)
	rPath?: string;
	// paths of installed R packages. Can be left out if rPath is provided.
	libPaths?: string[];
	// value of R.home()
	homePath?: string;
}

// used internally to store the parts of the path of a help file
interface HelpFileLocation {
	// path of the libLoc/homePath where the file was found
	truncPath: string;
	// directory of the file relative to the truncPath. Not necessarily an actual dir!
	relPath: string;
	// filename (without any part of the path). Not necessarily an actual file!
	fileName: string;
}

// helper to quickly create an instance of the interface above
class HelpFileLocation implements HelpFileLocation {
	constructor(
		public truncPath: string='',
		public relPath: string='',
		public fileName: string=''
	){}
}

// include flag if file is real and (if applicable) file location on disk
interface HelpFile extends rHelpPanel.HelpFile {
    // file location
    fileLocation?: HelpFileLocation;
    // is real file
    isRealFile: boolean;
}


// is basically a cusotm implementation of the internal R help server
// might be useful to provide help for non installed packages, custom help pages etc.
// theoratically doesn't need to run R to provide help from .html files 
// (not sure if there is a scenario where this is useful...)
export class RHelp implements rHelpPanel.HelpProvider {
	// R executable
	readonly rPath: string;
	// libraries as returned by .libPaths()
	readonly libPaths: string[];
	// homepath as returned by R.hom()
	readonly homePath: string;
	// temp directory used to extract .Rd file to
	readonly tempDir: string;

	constructor(options: RHelpOptions = {}) {
		this.rPath = options.rPath || 'R';

		// make new (randomly named) temp dir for this session
		this.tempDir = path.join(os.tmpdir(), 'vscode-R-Help-' + randomBytes(10).toString('hex'));
		fs.mkdirSync(this.tempDir);

		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');

		const cpOptions = {
			cwd: options.cwd
		};

		// read homePath from options or query R
		if(options.homePath){
			this.homePath = options.homePath;
		} else if(this.rPath){
			// use R.home() in R
			const cmd = `${this.rPath} --silent --no-save --no-restore  --no-echo -e "cat('${lim}', R.home(), '${lim}', sep='')"`;
			this.homePath = cp.execSync(cmd, cpOptions).toString().replace(re, '$1');
		} else {
			this.homePath = '';
		}

		// read liPaths from options or query R
		if (options.libPaths) {
			// libPaths supplied -> store
			this.libPaths = options.libPaths;
		} else if (this.rPath) {
			// use .libPaths() in R
			const cmd = `${this.rPath} --silent --no-save --no-restore  --no-echo -e "cat('${lim}', paste(.libPaths(), collapse='\\n'), '${lim}', sep='')"`;
			const libPathString = cp.execSync(cmd, cpOptions).toString().replace(re, '$1');
			this.libPaths = libPathString.replace('\r', '').split('\n');
		} else {
			// not good... throw error?
			this.libPaths = [];
		}
	}

	public dispose() {
		// remove temp directory
		const options: fs.RmDirOptions = {
			recursive: true
		};
		fs.rmdir(this.tempDir, options, () => null);
    }

	// main public interface
    public getHelpFileFromRequestPath(requestPath: string, prevFileLocation?: HelpFileLocation): HelpFile|null {
		let helpFile: HelpFile|null;
		// try to read help from real file:
        helpFile = this.getRealFileFromRequestPath(requestPath, prevFileLocation);
        if(helpFile){
            return helpFile;
        }

		// fall back to extracting help form an .rdb file:
        helpFile = this.extractHelpFileFromRequestPath(requestPath);
		
        return helpFile; // (might be null)
    }

	// finds an actual (html)-file for the specified requestPath, if it exists
    private getRealFileFromRequestPath(requestPath: string, prevFileLocation?: HelpFileLocation): HelpFile|null {

		const fileName = path.basename(requestPath);
		const relPath = path.dirname(requestPath);

        const locs: HelpFileLocation[] = [];
		
		// check relative to location of currently displayed file (optional)
		if(prevFileLocation){
			const truncPath = prevFileLocation.truncPath;
			locs.push(new HelpFileLocation(truncPath, relPath, fileName));
		}

		// check relative to home path
		if(this.homePath){
			locs.push(new HelpFileLocation(this.homePath, relPath, fileName));
		}

		// remove leading '/'
		const parts = relPath.split('/');
		while(parts.length>0 && parts[0]===''){
			parts.shift();
		}

		// only use libPaths for library entries, not e.g. doc
		if(parts[0]==='library'){
			parts.shift();
			const relPath2 = path.join(...parts);

			for(const libPath of this.libPaths){
				locs.push(new HelpFileLocation(libPath, relPath2, fileName));
			}
		}

		// actually check each possible location for a file
		for(const loc of locs){
			const fullPath = path.normalize(path.join(loc.truncPath, loc.relPath, loc.fileName));
			if(fs.existsSync(fullPath)){
				const html = fs.readFileSync(fullPath, 'utf-8');
				console.log(`Found in file ${fullPath}`);
				const helpFile: HelpFile = {
					requestPath: requestPath,
                    html: html,
                    fileLocation: loc,
                    isRealFile: true
				};
				return helpFile;
			}
		}
		return null;
    }

	// used when no html file is found
	// extracts the .Rd file from an .rdb archive and converts it to html
    private extractHelpFileFromRequestPath(requestPath: string): HelpFile|null {

		// extract different parts of request path:
        const parts = requestPath.split('/');
        const htmlFileName = parts.pop();
        const htmlDir = parts.pop();
        const pkgName = parts.pop();
        const libraryDir = parts.pop();

		// check if request is for a package library entry:
        if(!htmlFileName || libraryDir !== 'library' || htmlDir !== 'html'){
            return null;
		}

        const fncName = htmlFileName.replace(/\.html$/, '');

		// check each libPath for the specified package:
        for(const libPath of this.libPaths){
            // directory containing compressed help files:
            const helpDir = path.join(libPath, pkgName, 'help');
            // actual compressed help files:
            const rdbFile = path.join(helpDir, pkgName + '.rdb');
            const rdxFile = path.join(helpDir, pkgName + '.rdx');

			if (fs.existsSync(rdbFile) && fs.existsSync(rdxFile)) {
                const html = this.extractHtmlFile(helpDir, pkgName, fncName);
                if(html){
                    const helpFile: HelpFile = {
						requestPath: requestPath,
                        html: html,
                        isRealFile: false
                    };
                    return helpFile;
                }
			}
        }

        return null;
    }

	private extractHtmlFile(helpDir: string, pkgName: string, fncName: string): string | null {

		// options used in cp.execSync():
		const options: cp.ExecSyncOptionsWithStringEncoding = {
			cwd: helpDir,
			encoding: 'utf-8'
		};

		// (lazy)loads the contents of the .rdb file
		const cmd1a = `"invisible(lazyLoad('${pkgName}'))"`;

		// prints the content of the .Rd file belonging to the requested function
		const cmd1b = `"cat(paste0(tools:::as.character.Rd(get('${fncName}')),collapse=''))"`;

		// output file (supposed to be temporary)
		const rdFileName = path.join(os.tmpdir(), fncName + '.Rd');

        // produce the .Rd file of a function:
		const cmd1 = `${this.rPath} -e ${cmd1a} -e ${cmd1b} --vanilla --silent --no-echo > ${rdFileName}`;
        try{
            const out1 = cp.execSync(cmd1, options);
        } catch(e){
            console.log('Failed to extract .Rd file');
            return null;
        }

        // // convert the .Rd file to .html
        // const cmd2 = `${this.rPath} CMD Rdconv --type=html ${rdFileName}`;
        // let htmlContent: string = '';
        // try{
        //     htmlContent = cp.execSync(cmd2, options);
        // } catch(e){
        //     console.log('Failed to convert .Rd to .html');
        //     return null;
		// }
		
        // convert the .Rd file to .html
		const cmd3a = `"tools::Rd2HTML('${rdFileName}', Links=tools::findHTMLlinks())"`;
		const cmd3 = `${this.rPath} -e ${cmd3a} --vanilla --silent --no-echo`;
        let htmlContent: string = '';
        try{
            htmlContent = cp.execSync(cmd3, options);
        } catch(e){
            console.log('Failed to convert .Rd to .html');
            return null;
		}


		// try to remove temporary .Rd file
		try {
			fs.rmdirSync(rdFileName);
		} catch (e) {
			console.log('Failed to remove temp file. (Still working though)');
		}

		return htmlContent;
	}
}

