
import * as vscode from 'vscode';

import * as jsdom from 'jsdom';

import * as hljs from 'highlight.js';




// This interface needs to be implemented by  separate class that actually provides the R help pages
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
}

// currently dummy
export interface RHelpProviderOptions {}


// internal interface used to store history of help panel
interface HistoryEntry {
	helpFile: HelpFile;
	scrollStatus?: number; // currently a dummy
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
		const pkgName = await vscode.window.showInputBox({
			value: 'utils',
			prompt: 'Please enter the package name'
		});
		if(!pkgName){
			return false;
		}
		let fncName = await vscode.window.showInputBox({
			value: 'help',
			prompt: 'Please enter the function name'
		});
		if(!fncName){
			return false;
		}
		// changes e.g. ".vsc.print" to "dot-vsc.print"
		fncName = fncName.replace(/^\./, 'dot-');
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
	private async showHelpFile(helpFile: HelpFile|Promise<HelpFile>, updateHistory: boolean = true): Promise<void>{

		// get or create webview:
		const webview = this.getWebview();

		// make sure helpFile is not a promise:
		helpFile = await helpFile;

		let html: string = helpFile.html;

		if(!helpFile.isModified){
			// remove filename
			const parts = helpFile.requestPath.split('/');
			parts.pop();
			const relPath = parts.join('/');

			// modify html
			html = pimpMyHelp(helpFile.html, relPath);

			// add custom stylesheet and javascript
			html += `\n<link rel="stylesheet" href="${this.webviewStyleUri}"></link>`;
			html += `\n<script src=${this.webviewScriptUri}></script>`;

			// store modified version
			helpFile.html = html;
			helpFile.isModified = true;
		}

		// actually show the hel page
		webview.html = html;

		// update history to enable back/forward
		if(updateHistory){
			if(this.currentEntry){
				this.history.push(this.currentEntry);
			}
			this.forwardHistory = [];
		}
		this.currentEntry = {
			scrollStatus: 0,
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
	private goBack(){
		const entry = this.history.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.forwardHistory.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	private goForward(){
		const entry = this.forwardHistory.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
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
			console.log('Link clicked: ' + href);

			console.log('changes....');

			// remove first to path entries (if these are webview internal stuff):
			const uri = vscode.Uri.parse(href);
			const parts = uri.path.split('/');
			if(parts[0] !== 'library' && parts[0] !== 'docs'){
				console.log('shift...');
				parts.shift();
			}
			if(parts[0] !== 'library' && parts[0] !== 'docs'){
				console.log('shift...');
				parts.shift();
			}

			// actual request path as used by R:
			const requestPath = parts.join('/');

			// retrieve helpfile for path:
			const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);

			// if successful, show helpfile:
			if(helpFile){
				this.showHelpFile(helpFile);
			}
		} else if(msg.message === 'mouseClick'){
			// use the additional mouse buttons to go forward/backwards
			const button: number = msg.button || 0;
			if(button === 3){
				this.goBack();
			} else if(button === 4){
				this.goForward();
			}
		} else if(msg.message === 'text'){
			// used for logging/debugging
			console.log('Message (text): ' + msg.text);
		} else{
			console.log('Unknown message:', msg);
		}
	}
}



// improves the help display by applying syntax highlighting and adjusting hyperlinks:
function pimpMyHelp(html: string, relPath: string = ''): string {

	// parse the html string
	const dom = new jsdom.JSDOM(html);

	// find all code sections (indicated by 'pre' tags)
	const codeSections = dom.window.document.body.getElementsByTagName('pre');

	// check length here, to be sure it doesn't change during the loop:
	const nSec = codeSections.length; 

	// apply syntax highlighting to each code section:
	for(let i=0; i<nSec; i++){
		const section = codeSections[i].textContent || '';
		const highlightedHtml = hljs.highlight('r', section);
		codeSections[i].innerHTML = highlightedHtml.value;
	}

	// adjust hyperlinks to be relative to the specified path:
	if(relPath){
		relPath = relPath.replace(/\\/g, '/'); // in case relPath is a windows path
		const links = dom.window.document.getElementsByTagName('a');
		const nLinks = links.length;

		// adjust each hyperlink to be relative to the specified relPath
		// is very costly for many links!
		for(let i=0; i<nLinks; i++){
			let href = links[i].getAttribute('href');
			if(href){
				const uri = vscode.Uri.parse(href);
				if(!uri.authority){
					href = [relPath, href].join('/');
				}
				links[i].setAttribute('href', href);
			}
		}
	}

	// return the html of the modified page:
	return dom.serialize();
}
