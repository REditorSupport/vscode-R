/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import * as cheerio from 'cheerio';

import { HelpFile, RHelp } from '.';
import { setContext, UriIcon, config } from '../util';

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

export class HelpPanel {

    private readonly rHelp: RHelp;

	// the webview panel where the help is shown
	public panel?: vscode.WebviewPanel;
	private viewColumn: vscode.ViewColumn = vscode.ViewColumn.Two;

	// locations on disk, only changed on construction
	readonly webviewScriptFile: vscode.Uri; // the javascript added to help pages
	readonly webviewStyleFile: vscode.Uri; // the css file applied to help pages

	// virtual locations used by webview, changed each time a new webview is created
	private webviewScriptUri?: vscode.Uri;
    private webviewStyleUri?: vscode.Uri;

	// keep track of history to go back/forward:
	private currentEntry: HistoryEntry|undefined = undefined;
	private history: HistoryEntry[] = [];
	private forwardHistory: HistoryEntry[] = [];

	constructor(options: HelpPanelOptions, rHelp: RHelp, panel?: vscode.WebviewPanel){
		this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
        this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
        this.rHelp = rHelp;
		if(panel){
			this.panel = panel;
			this.initializePanel();
		}
	}

	// used to close files, stop servers etc.
	public dispose(): void {
		if(this.panel){
			this.panel.dispose();
		}
    }

	// retrieves the stored webview or creates a new one if the webview was closed
	private getWebview(preserveFocus: boolean = false): vscode.Webview {
		// create webview if necessary
		if(!this.panel){
			const webViewOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
				enableScripts: true,
				enableFindWidget: true,
				retainContextWhenHidden: true // keep scroll position when not focussed
			};
			const showOptions = {
				viewColumn: this.viewColumn,
				preserveFocus: preserveFocus
			};
			this.panel = vscode.window.createWebviewPanel('rhelp', 'R Help', showOptions, webViewOptions);
			this.initializePanel();
		}

		this.panel.reveal(undefined, preserveFocus);
		void this.setContextValues();

		return this.panel.webview;
    }

	private initializePanel(): void {
		if(!this.panel){
			return;
		}
		this.panel.iconPath = new UriIcon('help');
		// virtual uris used to access local files
		this.webviewScriptUri = this.panel.webview.asWebviewUri(this.webviewScriptFile);
		this.webviewStyleUri = this.panel.webview.asWebviewUri(this.webviewStyleFile);

		// called e.g. when the webview panel is closed by the user
		this.panel.onDidDispose(() => {
			this.panel = undefined;
			this.history = [];
			this.forwardHistory = [];
			this.currentEntry = undefined;
			this.webviewScriptUri = undefined;
			this.webviewStyleUri = undefined;
			void this.setContextValues();
		});

		// sent by javascript added to the help pages, e.g. when a link or mouse button is clicked
		this.panel.webview.onDidReceiveMessage((e: {[key: string]: any}) => {
			void this.handleMessage(e);
		});

		// set context variable to show forward/backward buttons
		this.panel.onDidChangeViewState(() => {
			void this.setContextValues();
		});
	}


	public async setContextValues(): Promise<void> {
		await setContext('r.helpPanel.active', !!this.panel?.active);
		await setContext('r.helpPanel.canGoBack', this.history.length > 0);
		await setContext('r.helpPanel.canGoForward', this.forwardHistory.length > 0);
	}

	// shows (internal) help file object in webview
	public async showHelpFile(helpFile: HelpFile | Promise<HelpFile>, updateHistory = true, currentScrollY = 0, viewer?: vscode.ViewColumn | string, preserveFocus: boolean = false): Promise<boolean>{
		if (viewer === undefined) {
			viewer = config().get<string>('session.viewers.viewColumn.helpPanel');
		}

		// update this.viewColumn if a valid viewer argument was supplied
		if (typeof viewer === 'string'){
			this.viewColumn = <vscode.ViewColumn>vscode.ViewColumn[String(viewer)];
		}

		// get or create webview:
		const webview = this.getWebview(preserveFocus);

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

		await this.setContextValues();

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
		const uri = vscode.Uri.parse(url);
		return vscode.env.openExternal(uri);
	}

	// go back/forward in the history of the webview:
	public goBack(): void {
		void this.panel?.webview.postMessage({command: 'goBack'});
	}
	private _goBack(currentScrollY = 0): void{
		const entry = this.history.pop();
		if(entry){
			if(this.currentEntry){ // should always be true
				this.currentEntry.helpFile.scrollY = currentScrollY;
				this.forwardHistory.push(this.currentEntry);
			}
			this.showHistoryEntry(entry);
		}
	}
	public goForward(): void {
		void this.panel?.webview.postMessage({command: 'goForward'});
	}
	private _goForward(currentScrollY = 0): void{
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
	private async handleMessage(msg: {[key: string]: any}){
		if('message' in msg && msg.message === 'linkClicked'){
			// handle hyperlinks clicked in the webview
			// normal navigation does not work in webviews (even on localhost)
			const href: string = <string>msg.href || '';
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
			const helpFile = await this.rHelp.getHelpFileForPath(requestPath);

			// if successful, show helpfile:
			if(helpFile){
				if(uri.fragment){
					helpFile.hash = '#' + uri.fragment;
				} else{
					helpFile.scrollY = 0;
				}
				if(uri.path.endsWith('.pdf')){
					void this.openInExternalBrowser(helpFile);
				} else if(uri.path.endsWith('.R')){
					const doc = await vscode.workspace.openTextDocument({
						language: 'r',
						content: helpFile.html0
					});
					void vscode.window.showTextDocument(doc);
				} else{
					void this.showHelpFile(helpFile, true, currentScrollY);
				}
			}
		} else if(msg.message === 'mouseClick'){
			// use the additional mouse buttons to go forward/backwards
			const currentScrollY = Number(msg.scrollY) || 0;
			const button: number = Number(msg.button) || 0;
			if(button === 3){
				this._goBack(currentScrollY);
			} else if(button === 4){
				this._goForward(currentScrollY);
			}
		} else if(msg.message === 'text'){
			// used for logging/debugging
			console.log(`Message (text): ${String(msg.text)}`);
		} else{
			console.log('Unknown message:', msg);
		}
	}

	// improves the help display by applying syntax highlighting and adjusting hyperlinks:
	private pimpMyHelp(helpFile: HelpFile, styleUri?: vscode.Uri|string, scriptUri?: vscode.Uri|string): HelpFile {

		// get requestpath of helpfile
		const relPath = helpFile.requestPath + (helpFile.hash || '');

		// parse the html string
		const $ = cheerio.load(helpFile.html);

		// set relPath attribute. Used by js inside the page to adjust hyperlinks
		// scroll to top (=0) or last viewed position (if the page is from history)
		$('body').attr('relpath', relPath);
		$('body').attr('scrollyto', `${helpFile.scrollY ?? -1}`);

        if(styleUri){
            $('body').append(`\n<link rel="stylesheet" href="${styleUri.toString()}"></link>`);
        }
        if(scriptUri){
            $('body').append(`\n<script src=${scriptUri.toString()}></script>`);
        }


		// convert to string
		helpFile.html = $.html();

		// return the html of the modified page:
		return helpFile;
	}

}
