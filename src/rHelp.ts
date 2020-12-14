/* eslint-disable @typescript-eslint/no-inferrable-types */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { commands, window, QuickPickItem, Uri, Webview, WebviewPanel, WebviewOptions, WebviewPanelOptions, WebviewPanelOnDidChangeViewStateEvent, ViewColumn, ProgressOptions } from 'vscode';

import * as cheerio from 'cheerio';

import * as hljs from 'highlight.js';

import { config } from './util';

import * as api from './api';

export { HelpSubMenu } from './api';

import { RHelpPanel, RHelpPageProvider } from './rHelpPanel';

//// Declaration of HelpProvider used by the Help Panel
// This interface needs to be implemented by a separate class that actually provides the R help pages
export interface HelpProvider {
	// is called to get help for a request path
	// the request path is the part of the help url after http://localhost:PORT/... when using R's help
	getHelpFileFromRequestPath(requestPath: string): null|Promise<null>|HelpFile|Promise<HelpFile>;

	// called to refresh (cached) underlying package info
	refresh(): void;

	// called to e.g. close servers, delete files
	dispose?(): void;
}
export interface HelpFile {
	// content of the file
	html: string;
	// whether the html has been modified already (syntax highlighting etc.)
	isModified?: boolean;
	// original content of the file (only used if isModified===true)
	html0?: string;
	// flag indicating whether the original file content is html
	isHtml?: boolean;
	// path as used by help server. Uses '/' as separator!
	requestPath: string;
	// hash-part of the requested URL
	hash?: string;
    // if the file is a real file
	isRealFile?: boolean;
	// can be used to scroll the document to a certain position when loading
	// useful to remember scroll position when going back/forward
	scrollY?: number;
}
export interface RHelpProviderOptions {
	// path to R executable
	rPath?: string;
	// directory in which to launch R processes
	cwd?: string;
}

//// Declaration of AliasProvider used by the Help Panel
// Is called to simulate `?` in vscode command palette, e.g.:
//   When entering `? colMeans`, the help server will open `colSums.html`
//   In this case: {name: "colMeans", alias: "colSums", package: "base"}
export interface AliasProvider {
	// used to generate quickpick options
	getAllAliases(): Alias[] | null;
	// could be used to look up a name entered by the user
	getAliasesForName(name: string, pkgName?: string): Alias[] | null;
	// reload aliases, used if triggered by user
	refresh(): void;
}
export interface Alias {
	// as presented to the user
	name: string,
	// as used by the help server
	alias: string,
	// name of the package the alias is from
    package: string
}
export interface AliasProviderArgs {
	// R path, must be vanilla R
	rPath: string;
	// getAliases.R
    rScriptFile: string;
}

//// Declaration of interfaces used/implemented by the Help Panel class
// specified when creating a new help panel
export interface HelpPanelOptions {
	/* Local path of script.js, used to send messages to vs code */
	webviewScriptPath: string;
	/* Local path of theme.css, used to actually format the highlighted syntax */
	webviewStylePath: string;
}

// returned when parsing R documentation's index files
export interface IndexFileEntry extends QuickPickItem {
	href?: string
}

// implementation of the help panel, which is exported in the extensions's api
export class RHelp implements api.HelpPanel {
	// the object that actually provides help pages:
	readonly helpProvider: HelpProvider;
	readonly aliasProvider: AliasProvider;

	// the webview panel where the help is shown
	private helpPanels: RHelpPanel[] = [];

	// locations on disk, only changed on construction
	readonly webviewScriptFile: Uri; // the javascript added to help pages
	readonly webviewStyleFile: Uri; // the css file applied to help pages

	// cache parsed index files (list of installed packages, functions in packages)
	private cachedIndexFiles: Map<string, IndexFileEntry[]> = new Map<string, IndexFileEntry[]>();

	// cache modified help files (syntax highlighting etc.)
	private cachedHelpFiles: Map<string, HelpFile> = new Map<string, HelpFile>();

	private helpPanelOptions: HelpPanelOptions;

	constructor(rHelp: HelpProvider, options: HelpPanelOptions, aliasProvider: AliasProvider){
		this.helpProvider = rHelp;
		this.webviewScriptFile = Uri.file(options.webviewScriptPath);
		this.webviewStyleFile = Uri.file(options.webviewStylePath);
		this.aliasProvider = aliasProvider;
		this.helpPanelOptions = options;
	}

	// used to close files, stop servers etc.
	public dispose(): void {
		if(this.helpProvider.dispose){
			this.helpProvider.dispose();
		}
		for(const helpPanel of this.helpPanels){
			helpPanel.dispose();
		}
	}

	public makeNewHelpPanel(): RHelpPanel {
		const helpPageProvider = {
			getHelpFileFromRequestPath: (requestPath: string) => {
				return this.getHelpFileForPath(requestPath);
			}
		};
		const helpPanel = new RHelpPanel(this.helpPanelOptions, helpPageProvider);
		this.helpPanels.unshift(helpPanel);
		return helpPanel;
	}

	public getActiveHelpPanel(): RHelpPanel {
		for(const helpPanel of this.helpPanels){
			if(helpPanel.panel && helpPanel.panel.active){
				return helpPanel;
			}
		}
		return this.getNewestHelpPanel();
	}

	public getNewestHelpPanel(): RHelpPanel {
		if(this.helpPanels.length){
			return this.helpPanels[0];
		} else{
			return this.makeNewHelpPanel();
		}
	}

	// if `subMenu` is not specified, let user choose between available help functions
	public async showHelpMenu(subMenu?: api.HelpSubMenu): Promise<boolean> {

		// if not specified, ask the user which subMenu to show
		if(!subMenu){
			// list of possible submenus
			const subMenus: (QuickPickItem & {subMenu: api.HelpSubMenu})[] = [{
				label: '$(home)',
				description: 'Help Index',
				subMenu: 'doc'
			},{
				label: '$(list-unordered)',
				description: 'List help indices by package',
				subMenu: 'pkgList'
			},{
				label: '$(search)',
				description: 'Search the help system using `?`',
				subMenu: '?'
			},{
				label: '$(zoom-in)',
				description: 'Search the help system using `??`',
				subMenu: '??'
			},{
				label:'$(refresh)',
				description: 'Clear cached index files',
				subMenu: 'refresh'
			}];

			// let user choose from help functionalities
			const qp = await window.showQuickPick(subMenus, {
				matchOnDescription: true,
				placeHolder: 'Please select a help function'
			});

			if(qp){
				subMenu = qp.subMenu;
			}
		}

		// handle user selection
		if(subMenu === 'refresh'){
			return this.refresh();
		} else if(subMenu === 'doc'){
			// no further selection sensible, show index page of docs
			return this.showHelpForFunctionName('doc', 'index.html');
		} else if(subMenu === '??'){
			// free text search
			return this.searchHelpByText();
		} else if(subMenu === '?'){
			return this.searchHelpByAlias();
		} else if(subMenu === 'pkgList'){
			return this.showHelpForPackages();
		} else{
			return false;
		}
	}

	// refresh list of packages that are cached by helpProvder & aliasProvider
	public refresh(): boolean {
		this.cachedIndexFiles.clear();
		if(this.helpProvider.refresh){
			this.helpProvider.refresh();
		}
		if(this.aliasProvider.refresh){
			this.aliasProvider.refresh();
		}
		return true;
	}

	private async showHelpForPackages(){
		// get list of installed packages for the user to pick from
		let packages: IndexFileEntry[];
		try {
			packages = await this.getParsedIndexFile(`/doc/html/packages.html`);
		} catch (error) {
			// handle together with packages===undefined etc.
		}

		if(!packages || packages.length === 0){
			void window.showErrorMessage('Help provider not available!');
			return false;
		}

		const qpOptions = {
			matchOnDescription: true,
			placeHolder: 'Please select a package'
		};
		const qp = await window.showQuickPick(packages, qpOptions);
		const pkgName = (qp ? qp.label : undefined);

		if(pkgName){
			return this.showHelpForFunctions(pkgName);
		} else {
			return false;
		}
	}

	private async showHelpForFunctions(pkgName: string){

		let fncName: string;

		// parse documented functions/items and let user pick
		const functions = await this.getParsedIndexFile(`/library/${pkgName}/html/00Index.html`);
		if(functions){
			// add package index file to top of list
			functions.unshift({
				label: '$(list-unordered)',
				href: '00Index',
				description: 'Package Index'
			});

			// if there is a package doc entry, move to top and highlight with home-symbol
			if(functions.length>1 && functions[1].label === `${pkgName}-package`){
				functions[1] = {...functions[1]}; // make copy to keep cache intact
				functions[1].href ||= functions[1].label;
				functions[1].label = `$(home)`;
				[functions[0], functions[1]] = [functions[1], functions[0]];
			}

			// let user pick function/item
			const qp = await window.showQuickPick(functions, {
				matchOnDescription: true,
				placeHolder: 'Please select a documentation entry'
			});

			// prefer to use href as function name, fall back to qp.label
			if(qp){
				fncName = (qp.href || '').replace(/\.html$/, '') || qp.label;
			}
		} else{
			// if no functions/items were found, let user type
			const defaultFnc = (pkgName==='doc' ? 'index.html' : '00Index');
			fncName = await window.showInputBox({
				value: defaultFnc,
				prompt: 'Please enter the function name'
			});
		}

		if(fncName){
			return this.showHelpForFunctionName(pkgName, fncName);
		} else{
			return false;
		}
	}

	// search function, similar to typing `?? ...` in R
	public async searchHelpByText(): Promise<boolean>{
		const searchTerm = await window.showInputBox({
			value: '',
			prompt: 'Please enter a search term'
		});

		if(searchTerm === undefined){
			return false;
		} else{
			return this.showHelpForPath(`/doc/html/Search?pattern=${searchTerm}`);
		}
	}

	// search function, similar to calling `?` in R
	public async searchHelpByAlias(): Promise<boolean> {
		// getAllAliases is synchronous, but might take a while => make async and show progress
		const options: ProgressOptions = {
			location: {
				viewId: 'rHelpPages'
			},
			cancellable: false
		};
		let aliases: Alias[];
		await window.withProgress(options, async () => {
			await new Promise((resolve) => setTimeout(() => {
				aliases = this.aliasProvider.getAllAliases();
				resolve(true);
			}, 0));
		});

		if(!aliases){
			void window.showErrorMessage('Failed to get list of R functions. Make sure that `jsonlite` is installed and r.helpPanel.rpath points to a valid R executable.');
			return false;
		}
		const qpItems: (QuickPickItem & Alias)[] = aliases.map(v => Object({
			...v,
			label: v.name,
			description: `(${v.package}::${v.name})`,
		}));
		const qpOptions = {
			matchOnDescription: true,
			placeHolder: 'Please type a function name/documentation entry'
		};
		const qp = await window.showQuickPick(
			qpItems,
			qpOptions
		);
		if(qp){
			return this.showHelpForFunctionName(qp.package, qp.alias);
		} else{
			return false;
		}
	}

	// shows help for package and function name
	public showHelpForFunctionName(pkgName: string, fncName: string): Promise<boolean> {

		let helpFile: HelpFile|Promise<HelpFile>;

		if(pkgName === 'doc'){
			const requestPath = `/doc/html/${fncName}`;
			// helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
			helpFile = this.getHelpFileForPath(requestPath);
		} else{
			const requestPath = `/library/${pkgName}/html/${fncName}.html`;
			// helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
			helpFile = this.getHelpFileForPath(requestPath);
		}

		return this.showHelpFile(helpFile);
	}

	// shows help for request path as used by R's internal help server
	public showHelpForPath(requestPath: string, viewer?: string|any): boolean | Promise<boolean> {

		// get and show helpFile
		const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
		if(helpFile){
			return this.showHelpFile(helpFile, viewer);
		} else{
			console.error(`Couldn't handle path:\n${requestPath}\n`);
			return false;
		}
	}

	public async getHelpFileForPath(requestPath: string, modify: boolean = true): Promise<HelpFile>|null {
		// get helpFile from helpProvider if not cached
		if(!this.cachedHelpFiles.has(requestPath)){
			const helpFile = await this.helpProvider.getHelpFileFromRequestPath(requestPath);
			this.cachedHelpFiles.set(requestPath, helpFile);
		}


		await new Promise((resolve) => setTimeout(resolve, 1));

		// modify the helpFile (syntax highlighting etc.)
		// modifications are cached
		const helpFileCached = this.cachedHelpFiles.get(requestPath);
		if(modify){
			this.pimpMyHelp(helpFileCached);
		}

		// make deep copy to avoid messing with cache
		const helpFile = {
			...helpFileCached
		};

		return helpFile;
	}

	// shows (internal) help file object in webview
	private async showHelpFile(helpFile: HelpFile|Promise<HelpFile>, viewer?: string|any): Promise<boolean>{

		helpFile = await helpFile;
		void this.getNewestHelpPanel().showHelpFile(helpFile, undefined, undefined, viewer);

		return true;
	}


	// go back/forward in the history of the webview
	public goBack(currentScrollY = 0): void{
		this.getActiveHelpPanel().goBack(currentScrollY);
	}
	public goForward(currentScrollY = 0): void{
		this.getActiveHelpPanel().goForward(currentScrollY);
	}

	// improves the help display by applying syntax highlighting and adjusting hyperlinks:
	private pimpMyHelp(helpFile: HelpFile): HelpFile {

		if(!helpFile.isModified){
			// store original html content
			helpFile.html0 = helpFile.html;

			// check if file is html
			const re = new RegExp('<html[^\\n]*>.*</html>', 'ms');
			helpFile.isHtml = !!re.exec(helpFile.html);
			if(!helpFile.isHtml){
				helpFile.html = `<html><head></head><body><pre>${helpFile.html}</pre></body></html>`;
			}

			// parse the html string
			const $ = cheerio.load(helpFile.html);

			$('head style').remove();

			if(config().get<boolean>('helpPanel.enableSyntaxHighlighting')){
				// find all code sections, enclosed by <pre>...</pre>
				const codeSections = $('pre');

				// apply syntax highlighting to each code section:
				codeSections.each((i, section) => {
					const newChildNodes = [];
					section.children.forEach((subSection,) => {
						if(subSection.type === 'text'){
							const styledCode = hljs.highlight('r', subSection.data);
							const newChildren = cheerio.parseHTML(styledCode.value);

							for(const [, newChild] of newChildren.entries()){
								newChildNodes.push(newChild);
							}
						}
					});
					section.childNodes = newChildNodes;
				});
			}

			// flag modified body (improve performance when going back/forth between pages)
			helpFile.isModified = true;

			// convert to string
			helpFile.html = $.html();
		}

		// return the html of the modified page:
		return helpFile;
	}

	// retrieve and parse an index file
	// (either list of all packages, or documentation entries of a package)
	public async getParsedIndexFile(requestPath: string): Promise<IndexFileEntry[]> {
		// only read and parse file if not cached yet
		if(!this.cachedIndexFiles.has(requestPath)){
			const helpFile = await this.getHelpFileForPath(requestPath, false);
			if(!helpFile || !helpFile.html){
				// set missing files to null
				this.cachedIndexFiles.set(requestPath, null);
			} else{
				// parse and cache file
				const documentedItems = this.parseIndexFile(helpFile.html);
				this.cachedIndexFiles.set(requestPath, documentedItems);
			}
		}

		// return cache entry. make new array to avoid messing with the cache
		const cache = this.cachedIndexFiles.get(requestPath);
		const ret = [];
		ret.push(...cache);
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
					const fncName = elements[0].firstChild.firstChild.data || '';
					const description = elements[1].firstChild.data || '';
					ret.push({
						href: href,
						label: fncName,
						description: description
					});
				}
			});
		});

		const retSorted = ret.sort((a, b) => a.label.localeCompare(b.label));

		return retSorted;
	}

}

