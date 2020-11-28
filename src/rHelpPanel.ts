
import * as vscode from 'vscode';


import * as cheerio from 'cheerio';

import * as hljs from 'highlight.js';
import { config } from './util';



interface AdditionalInfo {
	href?: string,
	pkgName?: string
}
interface DocumentedItem extends vscode.QuickPickItem, AdditionalInfo {}

// This interface needs to be implemented by a separate class that actually provides the R help pages
export interface HelpProvider {
	// is called to get help for a request path
	// the request path is the part of the help url after http://localhost:PORT/... when using R's help
	getHelpFileFromRequestPath(requestPath: string): null|Promise<null>|HelpFile|Promise<HelpFile>;

	// called to refresh (cached) underlying package info
	refresh?(): void;

	// called to e.g. close servers, delete files
	dispose?(): void;
}

export interface HelpFile {
	// content of the file
	html: string;
	// whether the html has been modified already (syntax highlighting etc.)
	isModified?: boolean;
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

// currently dummy
export interface RHelpProviderOptions {
	// path to R executable
	rPath?: string;
	// directory in which to launch R processes
	cwd?: string;
}


// internal interface used to store history of help panel
interface HistoryEntry {
	helpFile: HelpFile;
}


// specified when creating a new help panel
export interface HelpPanelOptions {
	/* Local path of script.js, used to send messages to vs code */
	webviewScriptPath: string;
	/* Local path of theme.css, used to actually format the highlighted syntax */
	webviewStylePath: string;
}

export class HelpPanel {
	// the object that actually provides help pages:
	readonly helpProvider: HelpProvider;

	// the webview panel where the help is shown
	private panel?: vscode.WebviewPanel;
	private viewColumn?: vscode.ViewColumn = vscode.ViewColumn.Two;

	// locations on disk, only changed on construction
	readonly webviewScriptFile: vscode.Uri; // the javascript added to help pages
	readonly webviewStyleFile: vscode.Uri; // the css file applied to help pages

	// virtual locations used by webview, changed each time a new webview is created
	private webviewScriptUri?: vscode.Uri;
	private webviewStyleUri?: vscode.Uri;
	
	// keep track of history to go back/forward:
	private currentEntry: HistoryEntry|null = null;
	private history: HistoryEntry[] = [];
	private forwardHistory: HistoryEntry[] = [];

	// cache parsed index files (list of installed packages, functions in packages)
	private cachedIndexFiles: Map<string, DocumentedItem[]> = new Map();


	constructor(rHelp: HelpProvider, options: HelpPanelOptions){
		this.helpProvider = rHelp;
		this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
		this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
	}

	// used to close files etc.
	public dispose(){
		if(this.helpProvider.dispose){
			this.helpProvider.dispose();
		}
		if(this.panel){
			this.panel.dispose();
		}
	}

	// prompts user for a package and function name to show:
	public async showHelpForInput(){
		// get list of installed packages for the user to pick from
		let packages: DocumentedItem[];
		try {
			packages = await this.getParsedIndexFile(`/doc/html/packages.html`);
		} catch (error) {}

		if(!packages){
			vscode.window.showErrorMessage('Help provider not available!');
			return false;
		}

		let pkgName: string = undefined;

		if(packages && packages.length>0){
			// add "meta" entries to top of list
			packages.unshift({
				label: '$(home)',
				description: 'Help Index',
				pkgName: 'doc'
			},{
				label: '$(search)',
				description: 'Search the help system using `??`',
				pkgName: '??'
			},{
				label:'$(refresh)',
				description: 'Clear cached index files',
				pkgName: '__refresh'
			});

			// let user choose from found packages
			const qp = await vscode.window.showQuickPick(packages, {
				matchOnDescription: true,
				placeHolder: 'Please select a package'
			});

			// if user chose something, fill pkgName from qp info
			// qp.pkgName is prefered (without .html), fallback is (mandatory) qp.label
			if(qp){
				pkgName = (qp.pkgName || '').replace(/\.html$/, '') || qp.label;
			}
		} else{
			// no packages found -> let user type
			const defaultPkg = 'doc';
			pkgName = await vscode.window.showInputBox({
				value: defaultPkg,
				prompt: 'Please enter the package name'
			});
		}

		if(!pkgName){
			// happens e.g. if the user pressed ESC 
			return false;
		} else if(pkgName === '__refresh'){
			// reload list of packages and prompt again
			if(this.helpProvider.refresh){
				this.helpProvider.refresh();
			}
			this.cachedIndexFiles.clear();
			return this.showHelpForInput();
		}

		let fncName: string = undefined;

		if(pkgName === 'doc'){
			// no further selection sensible, show index page of docs
			fncName = 'index.html';
		} else if(pkgName === '??'){
			// free text search
			return this.searchHelp();
		} else{
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
					functions[1] = {...functions[1]};
					functions[1].href ||= functions[1].label;
					functions[1].label = `$(home)`;
					[functions[0], functions[1]] = [functions[1], functions[0]];
				}

				// let user pick function/item
				const qp = await vscode.window.showQuickPick(functions, {
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
				fncName = await vscode.window.showInputBox({
					value: defaultFnc,
					prompt: 'Please enter the function name'
				});
			}
		}

		if(!fncName){
			// happens e.g. if the user pressed ESC
			return false;
		} else{
			// changes e.g. ".vsc.print" to "dot-vsc.print"
			fncName = fncName.replace(/^\./, 'dot-');
			this.showHelpForFunctionName(fncName, pkgName);
		}
		return true;
	}

	// search function, similar to typing `?? ...` in R
	public async searchHelp(){
		const searchTerm = await vscode.window.showInputBox({
			value: '',
			prompt: 'Please enter a search term'
		});

		if(searchTerm === undefined){
			return false;
		}

		const requestPath = `/doc/html/Search?pattern=${searchTerm}`;
		this.showHelpForPath(requestPath);
		return true;
	}

	// shows help for package and function name
	public showHelpForFunctionName(fncName: string, pkgName: string){

		let helpFile: HelpFile|Promise<HelpFile>;

		if(pkgName === 'doc'){
			const requestPath = `/doc/html/${fncName}`;
			helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
		} else{
			const requestPath = `/library/${pkgName}/html/${fncName}.html`;
			helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
		}

		this.showHelpFile(helpFile);
	}

	// shows help for request path as used by R's internal help server
	public showHelpForPath(requestPath: string, viewer?: string|any){

		if(typeof viewer === 'string'){
			this.viewColumn = vscode.ViewColumn[String(viewer)];
		}
		const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);

		if(helpFile){
			this.showHelpFile(helpFile);
		} else{
			console.error(`Couldn't handle path:\n${requestPath}\n`);
		}
	}

	// shows (internal) help file object in webview
	private async showHelpFile(helpFile: HelpFile|Promise<HelpFile>, updateHistory: boolean = true, currentScrollY: number = 0): Promise<void>{

		// get or create webview:
		const webview = this.getWebview();

		// make sure helpFile is not a promise:
		helpFile = await helpFile;

		helpFile.scrollY = helpFile.scrollY || 0;

		// modify html
		helpFile = this.pimpMyHelp(helpFile);

		// actually show the hel page
		webview.html = helpFile.html;

		// update history to enable back/forward
		if(updateHistory){
			if(this.currentEntry){
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.history.push(this.currentEntry);
			}
			this.forwardHistory = [];
		}
		this.currentEntry = {
			helpFile: helpFile
		};
	}

	// retrieves the stored webview or creates a new one if the webview was closed
	private getWebview(): vscode.Webview {
		// create webview if necessary
		if(!this.panel){
			const webViewOptions: vscode.WebviewOptions = {
				enableScripts: true,
			};
			this.panel = vscode.window.createWebviewPanel('rhelp', 'R Help', this.viewColumn, webViewOptions);

			// virtual uris used to access local files
			this.webviewScriptUri = this.panel.webview.asWebviewUri(this.webviewScriptFile);
			this.webviewStyleUri = this.panel.webview.asWebviewUri(this.webviewStyleFile);

			// called e.g. when the webview panel is closed by the user
			this.panel.onDidDispose((e: void) => {
				this.panel = undefined;
				this.webviewScriptUri = undefined;
				this.webviewStyleUri = undefined;
			});

			// sent by javascript added to the help pages, e.g. when a link or mouse button is clicked
			this.panel.webview.onDidReceiveMessage((e: any) => {
				this.handleMessage(e);
			});

			// set context variable to show forward/backward buttons
			this.panel.onDidChangeViewState((e: vscode.WebviewPanelOnDidChangeViewStateEvent) => {
				vscode.commands.executeCommand('setContext', 'r.helpPanel.active', e.webviewPanel.active);
			});

		}

		this.panel.reveal();

		return this.panel.webview;
	}

	// go back/forward in the history of the webview:
	public goBack(currentScrollY: number = 0){
		const entry = this.history.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.forwardHistory.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	public goForward(currentScrollY: number = 0){
		const entry = this.forwardHistory.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.history.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	private showHistoryEntry(entry: HistoryEntry){
		const helpFile = entry.helpFile;
		this.showHelpFile(helpFile, false);
	}

	// handle message produced by javascript inside the help page
	private async handleMessage(msg: any){
		if(msg.message === 'linkClicked'){
			// handle hyperlinks clicked in the webview
			// normal navigation does not work in webviews (even on localhost)
			const href: string = msg.href || '';
			const currentScrollY: number = Number(msg.scrollY) || 0;
			console.log('Link clicked: ' + href);

			// remove first to path entries (if these are webview internal stuff):
			const uri = vscode.Uri.parse(href);
			const parts = uri.path.split('/');
			if(parts[0] !== 'library' && parts[0] !== 'doc'){
				parts.shift();
			}
			if(parts[0] !== 'library' && parts[0] !== 'doc'){
				parts.shift();
			}

			// actual request path as used by R:
			const requestPath = parts.join('/');

			// retrieve helpfile for path:
			const helpFile = await this.helpProvider.getHelpFileFromRequestPath(requestPath);

			if(uri.fragment){
				helpFile.hash = '#' + uri.fragment;
			} else{
				helpFile.scrollY = 0;
			}

			// if successful, show helpfile:
			if(helpFile){
				this.showHelpFile(helpFile, true, currentScrollY);
			}
		} else if(msg.message === 'mouseClick'){
			// use the additional mouse buttons to go forward/backwards
			const currentScrollY = Number(msg.scrollY) || 0;
			const button: number = msg.button || 0;
			if(button === 3){
				this.goBack(currentScrollY);
			} else if(button === 4){
				this.goForward(currentScrollY);
			}
		} else if(msg.message === 'text'){
			// used for logging/debugging
			console.log('Message (text): ' + msg.text);
		} else{
			console.log('Unknown message:', msg);
		}
	}


	// improves the help display by applying syntax highlighting and adjusting hyperlinks:
	private pimpMyHelp(helpFile: HelpFile): HelpFile {

		// get requestpath of helpfile
		const relPath = helpFile.requestPath + (helpFile.hash || '');

		// check if file is html
		const re = new RegExp('<html[^\n]*>.*</html>', 'ms');
		if(!helpFile.html.match(re)){
			helpFile.html = `<html><head></head><body><pre>${helpFile.html}</pre></body></html>`;
		}

		// parse the html string
		const $ = cheerio.load(helpFile.html);

		if(!helpFile.isModified){

			if(config().get<boolean>('helpPanel.enableSyntaxHighlighting')){
				// find all code sections, enclosed by <pre>...</pre>
				const codeSections = $('pre');

				// apply syntax highlighting to each code section:
				codeSections.each((i, section) => {
					const newChildNodes = [];
					section.children.forEach((subSection, j) => {
						if(subSection.type === 'text'){
							const styledCode = hljs.highlight('r', subSection.data);
							const newChildren = cheerio.parseHTML(styledCode.value);

							for(const [i, newChild] of newChildren.entries()){
								newChildNodes.push(newChild);
							}
						}
					});
					section.childNodes = newChildNodes;
				});
			}

			// append stylesheet and javascript file
			$('body').append(`\n<link rel="stylesheet" href="${this.webviewStyleUri}"></link>`);
			$('body').append(`\n<script src=${this.webviewScriptUri}></script>`);

			// flag modified body (improve performance when going back/forth between pages)
			helpFile.isModified = true;
		}

		// set relPath attribute. Used by js inside the page to adjust hyperlinks
		// scroll to top (=0) or last viewed position (if the page is from history)
		$('body').attr('relpath', relPath);
		$('body').attr('scrollyto', `${helpFile.scrollY ?? -1}`);



		// convert to string
		helpFile.html = $.html();

		// return the html of the modified page:
		return helpFile;
	}

	// retrieve and parse an index file
	// (either list of all packages, or documentation entries of a package)
	private async getParsedIndexFile(requestPath: string): Promise<DocumentedItem[]> {
		// only read and parse file if not cached yet
		if(!this.cachedIndexFiles.has(requestPath)){
			const helpFile = await this.helpProvider.getHelpFileFromRequestPath(requestPath);
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

	private parseIndexFile(html: string): DocumentedItem[] {

		const $ = cheerio.load(html);

		const tables = $('table');

		const ret: DocumentedItem[] = [];

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

		return ret;
	}

}

