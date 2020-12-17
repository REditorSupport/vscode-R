/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { env, commands, window, QuickPickItem, Uri, Webview, WebviewPanel, WebviewOptions, WebviewPanelOptions, WebviewPanelOnDidChangeViewStateEvent, ViewColumn, workspace } from 'vscode';

import * as vscode from 'vscode';

import { HelpFile } from './rHelp';

import * as cheerio from 'cheerio';

//// Declaration of interfaces used/implemented by the Help Panel class
// specified when creating a new help panel
export interface HelpPanelOptions {
	/* Local path of script.js, used to send messages to vs code */
	webviewScriptPath: string;
	/* Local path of theme.css, used to actually format the highlighted syntax */
	webviewStylePath: string;
}

// internal interface used to store history of help panel
interface HistoryEntry {
	helpFile: HelpFile;
}

// provides modified help pages for paths
export interface RHelpPageProvider {
	// is called to get help for a request path
    // the request path is the part of the help url after http://localhost:PORT/... when using R's help
    // Returned help files are already modified with e.g. syntax highlighting!
	getHelpFileFromRequestPath(requestPath: string): null|Promise<null>|HelpFile|Promise<HelpFile>;
}

export class HelpPanel {

    private readonly helpProvider: RHelpPageProvider;

	// the webview panel where the help is shown
	public panel?: WebviewPanel;
	private viewColumn?: ViewColumn = ViewColumn.Two;

	// locations on disk, only changed on construction
	readonly webviewScriptFile: Uri; // the javascript added to help pages
	readonly webviewStyleFile: Uri; // the css file applied to help pages

	// virtual locations used by webview, changed each time a new webview is created
	private webviewScriptUri?: Uri;
    private webviewStyleUri?: Uri;

	// keep track of history to go back/forward:
	private currentEntry: HistoryEntry|null = null;
	private history: HistoryEntry[] = [];
	private forwardHistory: HistoryEntry[] = [];

	constructor(options: HelpPanelOptions, helpPageProvider: RHelpPageProvider){
		this.webviewScriptFile = Uri.file(options.webviewScriptPath);
        this.webviewStyleFile = Uri.file(options.webviewStylePath);
        this.helpProvider = helpPageProvider;
	}

	// used to close files, stop servers etc.
	public dispose(): void {
		if(this.panel){
			this.panel.dispose();
		}
    }

	// retrieves the stored webview or creates a new one if the webview was closed
	private getWebview(): Webview {
		// create webview if necessary
		if(!this.panel){
			const webViewOptions: WebviewOptions & WebviewPanelOptions = {
				enableScripts: true,
				enableFindWidget: true
			};
			this.panel = window.createWebviewPanel('rhelp', 'R Help', this.viewColumn, webViewOptions);

			// virtual uris used to access local files
			this.webviewScriptUri = this.panel.webview.asWebviewUri(this.webviewScriptFile);
			this.webviewStyleUri = this.panel.webview.asWebviewUri(this.webviewStyleFile);

			// called e.g. when the webview panel is closed by the user
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.webviewScriptUri = undefined;
				this.webviewStyleUri = undefined;
				void commands.executeCommand('setContext', 'r.helpPanel.active', false);
			});

			// sent by javascript added to the help pages, e.g. when a link or mouse button is clicked
			this.panel.webview.onDidReceiveMessage((e: any) => {
				void this.handleMessage(e);
			});

			// set context variable to show forward/backward buttons
			this.panel.onDidChangeViewState((e: WebviewPanelOnDidChangeViewStateEvent) => {
				void commands.executeCommand('setContext', 'r.helpPanel.active', e.webviewPanel.active);
			});

		}

		this.panel.reveal();

		return this.panel.webview;
    }

	// shows (internal) help file object in webview
	public async showHelpFile(helpFile: HelpFile|Promise<HelpFile>, updateHistory = true, currentScrollY = 0, viewer?: string|any): Promise<boolean>{

		// update this.viewColumn if a valid viewer argument was supplied
		if(typeof viewer === 'string'){
			this.viewColumn = ViewColumn[String(viewer)];
		}

		// get or create webview:
		const webview = this.getWebview();

		// make sure helpFile is not a promise:
		helpFile = await helpFile;

		helpFile.scrollY = helpFile.scrollY || 0;

		// modify html
		helpFile = this.pimpMyHelp(helpFile, this.webviewStyleUri, this.webviewScriptUri);

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

		return true;
	}

	public async openInExternalBrowser(helpFile?: HelpFile): Promise<boolean> {
		if(!this.currentEntry){
			return false;
		}
		if(!helpFile){
			helpFile = this.currentEntry.helpFile;
		}
		const url = helpFile.url;
		if(!url){
			return false;
		}
		const uri = Uri.parse(url);
		const externalUri = await env.asExternalUri(uri);
		return env.openExternal(externalUri);
	}

	// go back/forward in the history of the webview:
	public goBack(currentScrollY = 0): void{
		const entry = this.history.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.forwardHistory.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	public goForward(currentScrollY = 0): void{
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
		void this.showHelpFile(helpFile, false);
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
			const uri = Uri.parse(href);
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
				if(uri.path.endsWith('.pdf')){
					void this.openInExternalBrowser(helpFile);
				} else if(uri.path.endsWith('.R')){
					const doc = await vscode.workspace.openTextDocument({
						language: 'r',
						content: helpFile.html0
					});
					void window.showTextDocument(doc);
				} else{
					void this.showHelpFile(helpFile, true, currentScrollY);
				}
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
			console.log(`Message (text): ${msg.text}`);
		} else{
			console.log('Unknown message:', msg);
		}
	}

	// improves the help display by applying syntax highlighting and adjusting hyperlinks:
	private pimpMyHelp(helpFile: HelpFile, styleUri?: Uri|string, scriptUri?: Uri|string): HelpFile {

		// get requestpath of helpfile
		const relPath = helpFile.requestPath + (helpFile.hash || '');

		// parse the html string
		const $ = cheerio.load(helpFile.html);

		// set relPath attribute. Used by js inside the page to adjust hyperlinks
		// scroll to top (=0) or last viewed position (if the page is from history)
		$('body').attr('relpath', relPath);
		$('body').attr('scrollyto', `${helpFile.scrollY ?? -1}`);

        if(styleUri){
            $('body').append(`\n<link rel="stylesheet" href="${styleUri}"></link>`);
        }
        if(scriptUri){
            $('body').append(`\n<script src=${scriptUri}></script>`);
        }


		// convert to string
		helpFile.html = $.html();

		// return the html of the modified page:
		return helpFile;
	}

}

