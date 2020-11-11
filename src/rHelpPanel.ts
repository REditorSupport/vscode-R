
import * as vscode from 'vscode';


import * as cheerio from 'cheerio';

import * as hljs from 'highlight.js';




// This interface needs to be implemented by a separate class that actually provides the R help pages
export interface HelpProvider {
	// is called to get help for a request path
	// the request path is the part of the help url after http://localhost:PORT/... when using R's help
	getHelpFileFromRequestPath(requestPath: string, options?: RHelpProviderOptions): null|HelpFile|Promise<HelpFile>;

	// optional functions to get help for doc file or functions from packages
	getHelpFileForDoc?(fncName: string): null|HelpFile|Promise<HelpFile>;
	getHelpFileForFunction?(pkgName: string, fncName: string): null|HelpFile|Promise<HelpFile>;

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
    // if the file is a real file
	isRealFile?: boolean;
	// can be used to scroll the document to a certain position when loading
	// useful to remember scroll position when going back/forward
	scrollY?: number;
}

// currently dummy
export interface RHelpProviderOptions {}


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



	constructor(rHelp: HelpProvider, options: HelpPanelOptions){
		this.helpProvider = rHelp;
		console.log(options.webviewScriptPath);
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
		const defaultPkg = 'doc';
		const pkgName = await vscode.window.showInputBox({
			value: defaultPkg,
			prompt: 'Please enter the package name'
		});
		if(!pkgName){
			return false;
		}
		const defaultFnc = (pkgName==='doc' ? 'index.html' : '00Index');
		let fncName = await vscode.window.showInputBox({
			value: defaultFnc,
			prompt: 'Please enter the function name'
		});
		if(!fncName){
			return false;
		}
		// changes e.g. ".vsc.print" to "dot-vsc.print"
		fncName = fncName.replace(/^\./, 'dot-');

		console.log(`pkg: ${pkgName} - fnc: ${fncName}`);
		this.showHelpForFunctionName(fncName, pkgName);
		return true;
	}

	// shows help for package and function name
	public showHelpForFunctionName(fncName: string, pkgName: string){
		let helpFile: HelpFile|Promise<HelpFile>;

		if(pkgName === 'doc'){
			if(this.helpProvider.getHelpFileForDoc){
				helpFile = this.helpProvider.getHelpFileForDoc(fncName);
			} else{
				const requestPath = `doc/html/${fncName}`;
				helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
			}
		} else{
			if(this.helpProvider.getHelpFileForFunction){
				helpFile = this.helpProvider.getHelpFileForFunction(pkgName, fncName);
			} else{
				const requestPath = `library/${pkgName}/html/${fncName}.html`;
				helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
			}
		}

		this.showHelpFile(helpFile);
	}

	// shows help for request path as used by R's internal help server
	public showHelpForPath(requestPath: string){

		console.log(requestPath);

		const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);

		if(helpFile){
			this.showHelpFile(helpFile);
		} else{
			console.error(`Couldnt handle path:\n${requestPath}\n`);
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
			this.panel = vscode.window.createWebviewPanel('rhelp', 'R Help', vscode.ViewColumn.Two, webViewOptions);

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
		}

		return this.panel.webview;
	}

	// go back/forward in the history of the webview:
	private goBack(currentScrollY: number = 0){
		const entry = this.history.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.forwardHistory.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	private goForward(currentScrollY: number = 0){
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
	private handleMessage(msg: any){
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

			if(parts.length >= 4 && parts[2] === 'help'){
				parts[2] = 'html';
				parts[3] += '.html';
			}

			// actual request path as used by R:
			const requestPath = parts.join('/');

			// retrieve helpfile for path:
			const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);

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
		const parts = helpFile.requestPath.split('/');
		parts.pop(); // remove filename
		const relPath = parts.join('/');

		// parse the html string
		const $ = cheerio.load(helpFile.html);

		if(!helpFile.isModified){
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

			// append stylesheet and javascript file
			$('body').append(`\n<link rel="stylesheet" href="${this.webviewStyleUri}"></link>`);
			$('body').append(`\n<script src=${this.webviewScriptUri}></script>`);

			// flag modified body (improve performance when going back/forth between pages)
			helpFile.isModified = true;
		}

		// set relPath attribute. Used by js inside the page to adjust hyperlinks
		// scroll to top (=0) or last viewed position (if the page is from history)
		$('body').attr('relpath', relPath);
		$('body').attr('scrollyto', `${helpFile.scrollY || 0}`);



		// convert to string
		helpFile.html = $.html();

		// return the html of the modified page:
		return helpFile;
	}
}

