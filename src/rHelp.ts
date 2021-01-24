/* eslint-disable @typescript-eslint/no-explicit-any */

import * as path from 'path';
import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import * as hljs from 'highlight.js';

import * as api from './api';

import { config, getRpath, doWithProgress } from './util';
import { HelpPanel } from './rHelpPanel';
import { HelpProvider, AliasProvider } from './rHelpProvider';
import { HelpTreeWrapper } from './rHelpTree';
import { PackageManager } from './rHelpPackages';




class DummyMemento implements vscode.Memento {
	items = new Map<string, any>()
	public get<T>(key: string, defaultValue?: T): T | undefined {
		if(this.items.has(key)){
			return <T>this.items.get(key);
		} else{
			return defaultValue;
		}
	}
	// eslint-disable-next-line @typescript-eslint/require-await
	public async update(key: string, value: any): Promise<void> {
		this.items.set(key, value);
	}
}

export async function initializeHelp(context: vscode.ExtensionContext, rExtension: api.RExtension): Promise<RHelp|undefined> {

	void vscode.commands.executeCommand('setContext', 'r.helpViewer.show', true);

    // get the "vanilla" R path from config
    const rPath = await getRpath(true, 'helpPanel.rpath');

	const cwd = (
		vscode.workspace.workspaceFolders?.length ?
		vscode.workspace.workspaceFolders[0].uri.fsPath :
		undefined
	);

	// get the Memento for storing cached help files (or create a dummy for this session)
	const cacheConfig = config().get<'None'|'Workspace'|'Global'>('helpPanel.cacheIndexFiles');
	const state = (
		cacheConfig === 'Workspace' ? context.workspaceState :
		cacheConfig === 'Global' ? context.globalState :
		new DummyMemento()
	);

    const rHelpOptions: HelpOptions = {
        webviewScriptPath: path.join(context.extensionPath, path.normalize('/html/script.js')),
        webviewStylePath: path.join(context.extensionPath, path.normalize('/html/theme.css')),
        rPath: rPath,
        cwd: cwd,
		rScriptFile: context.asAbsolutePath('R/getAliases.R'),
		persistentState: state
    };

	let rHelp: RHelp | undefined = undefined;

    try{
		rHelp = new RHelp(rHelpOptions);
    } catch(e) {
        void vscode.window.showErrorMessage(`Help Panel not available`);
    }

    rExtension.helpPanel = rHelp;

	if(rHelp){
		context.subscriptions.push(rHelp);

		context.subscriptions.push(
			// commands.registerCommand('r.showHelp', (subMenu?: api.HelpSubMenu) => rHelp.showHelpMenu(subMenu)),
			vscode.commands.registerCommand('r.showHelp', () => rHelp?.treeViewWrapper.helpViewProvider.rootItem.showQuickPick()),
			vscode.commands.registerCommand('r.helpPanel.back', () => rHelp?.goBack()),
			vscode.commands.registerCommand('r.helpPanel.forward', () => rHelp?.goForward()),
			vscode.commands.registerCommand('r.helpPanel.openExternal', () => rHelp?.openExternal()),
			vscode.commands.registerCommand('r.helpPanel.openForSelection', () => rHelp?.openHelpForSelection())
		);
	}

	return rHelp;
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
	// used to open the file in an external browser
	url?: string;
}

export interface Alias {
	// as presented to the user
	name: string,
	// as used by the help server
	alias: string,
	// name of the package the alias is from
    package: string
}

export interface CranPackage {
	name: string;
	url: string;
	description: string;
	date?: string;
}

//// Declaration of interfaces used/implemented by the Help Panel class
// specified when creating a new help panel
export interface HelpOptions {
	/* Local path of script.js, used to send messages to vs code */
	webviewScriptPath: string;
	/* Local path of theme.css, used to actually format the highlighted syntax */
	webviewStylePath: string;
	// path of the R executable
    rPath: string;
	// directory in which to launch R processes
	cwd?: string;
	// path of getAliases.R
	rScriptFile: string;
	// persistent state, either global or workspace specific
	persistentState: vscode.Memento;
	// used by some helper classes:
	rHelp?: RHelp;
}

// returned when parsing R documentation's index files
export interface IndexFileEntry extends vscode.QuickPickItem {
	href?: string
}



// implementation of the help panel, which is exported in the extensions's api
export class RHelp implements api.HelpPanel {

	readonly rPath: string;
	readonly cwd?: string;

	// the object that actually provides help pages:
	readonly helpProvider: HelpProvider;
	readonly aliasProvider: AliasProvider;
	readonly packageManager: PackageManager;
	readonly treeViewWrapper: HelpTreeWrapper;

	// the webview panel where the help is shown
	private readonly helpPanels: HelpPanel[] = [];

	// locations on disk, only changed on construction
	readonly webviewScriptFile: vscode.Uri; // the javascript added to help pages
	readonly webviewStyleFile: vscode.Uri; // the css file applied to help pages


	// cache modified help files (syntax highlighting etc.)
	private cachedHelpFiles: Map<string, HelpFile | null> = new Map<string, HelpFile | null>();

	private helpPanelOptions: HelpOptions;

	constructor(options: HelpOptions){
		this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
		this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
		this.helpProvider = new HelpProvider(options);
		this.aliasProvider = new AliasProvider(options);
		this.packageManager = new PackageManager({...options, rHelp: this});
		this.treeViewWrapper = new HelpTreeWrapper(this);
		this.helpPanelOptions = options;
	}

	// used to close files, stop servers etc.
	public dispose(): void {
		const children = [
			this.helpProvider,
			this.aliasProvider,
			this.packageManager,
			this.treeViewWrapper,
			...this.helpPanels
		];
		for(const child of children){
			if(child && 'dispose' in child && typeof child.dispose === 'function'){
				try{
					child.dispose();
				} catch(e) {}
			}
		}
	}

	// refresh list of packages that are cached by helpProvder & aliasProvider
	public refresh(): boolean {
		this.cachedHelpFiles.clear();
		if(this.helpProvider.refresh){
			this.helpProvider.refresh();
		}
		if(this.aliasProvider.refresh){
			this.aliasProvider.refresh();
		}
		if(this.packageManager.refresh){
			this.packageManager.refresh();
		}
		return true;
	}

	public makeNewHelpPanel(): HelpPanel {
		const helpPageProvider = {
			getHelpFileFromRequestPath: (requestPath: string) => {
				return this.getHelpFileForPath(requestPath);
			}
		};
		const helpPanel = new HelpPanel(this.helpPanelOptions, helpPageProvider);
		this.helpPanels.unshift(helpPanel);
		return helpPanel;
	}

	public getActiveHelpPanel(fallBack: boolean = true): HelpPanel | undefined {
		for(const helpPanel of this.helpPanels){
			if(helpPanel.panel && helpPanel.panel.active){
				return helpPanel;
			}
		}
		if(fallBack){
			return this.getNewestHelpPanel();
		}
		return undefined;
	}

	public getNewestHelpPanel(): HelpPanel {
		if(this.helpPanels.length){
			return this.helpPanels[0];
		} else{
			return this.makeNewHelpPanel();
		}
	}

	public openExternal(): void {
		const panel = this.getActiveHelpPanel(false);
		void panel?.openInExternalBrowser();
	}

	// go back/forward in the history of the webview
	public goBack(): void{
		this.getActiveHelpPanel(false)?.goBack();
	}
	public goForward(): void{
		this.getActiveHelpPanel(false)?.goForward();
	}

	// if `subMenu` is not specified, let user choose between available help functions
	public showHelpMenu(): void  {
		void this.treeViewWrapper.helpViewProvider.rootItem.showQuickPick();
	}

	public clearCachedFiles(re: string|RegExp): void {
		for(const path of this.cachedHelpFiles.keys()){
			if(
				(typeof re === 'string' && path === re)
				|| typeof re !== 'string' && re.exec(path)
			){
				this.cachedHelpFiles.delete(path);
			}
		}
	}


	// search function, similar to typing `?? ...` in R
	public async searchHelpByText(): Promise<boolean>{
		const searchTerm = await vscode.window.showInputBox({
			value: '',
			prompt: 'Please enter a search term'
		});
		if(searchTerm !== undefined){
			return this.showHelpForPath(`/doc/html/Search?pattern=${searchTerm}`);
		}
		return false;
	}
	
	// quickly open help for selection
	public async openHelpForSelection(): Promise<boolean> {
		// only use if we failed to show help page:
		let errMsg: string;

		const editor = vscode.window.activeTextEditor;
		if (editor) {
			// the text to show help for:
			let txt = '';
			if (editor.selection.isEmpty) {
				// no text selected -> find word at current cursor position
				// use regex including ":" to capture package/namespace (e.g. base::print)
				const re = /([a-zA-Z0-9._:])+/;
				const range = editor.document.getWordRangeAtPosition(editor.selection.start, re);
				// check if the cursor is at a word (else: whitespace -> ignore)
				if(range){
					txt = editor.document.getText(range);
				}
			} else {
				// use selected text
				txt = editor.document.getText(editor.selection);
			}
			txt = txt.trim();
			if(txt){
				const success = await this.openHelpByAlias(txt);
				if(!success){
					errMsg = `Failed to open help for "${txt}"!`;
				}
			} else{
				errMsg = 'Cannot show help: No valid text selected!';
			}
		} else{
			errMsg = 'No editor active!';
		}
		if(errMsg){
			void vscode.window.showErrorMessage(errMsg);
			return false;
		}
		return true;
	}

	// quickly open help page by alias
	public async openHelpByAlias(token: string = ''): Promise<boolean> {
		const aliases = await this.getAllAliases();
		if(!aliases){
			return false;
		}

		const matchingAliases = aliases.filter(alias => (
			token === alias.name
			|| token === `${alias.package}::${alias.name}`
			|| token === `${alias.package}:::${alias.name}`
		));

		let pickedAlias: Alias | undefined;
		if(matchingAliases.length === 0){
			pickedAlias = undefined;
		} else if(matchingAliases.length === 1){
			pickedAlias = matchingAliases[0];
		} else{
			pickedAlias = await this.pickAlias(matchingAliases);
		}
		if(pickedAlias){
			return await this.showHelpForAlias(pickedAlias);
		}
		return false;
	}

	// search function, similar to calling `?` in R
	public async searchHelpByAlias(): Promise<boolean> {
		const alias = await this.pickAlias();
		if(alias){
			return this.showHelpForAlias(alias);
		}
		return false;
	}

	// helper function to get aliases from aliasprovider
	private async getAllAliases(): Promise<Alias[] | null | undefined> {
		const aliases = await doWithProgress(() => this.aliasProvider.getAllAliases());
		if(!aliases){
			void vscode.window.showErrorMessage('Failed to get list of R functions. Make sure that `jsonlite` is installed and r.helpPanel.rpath points to a valid R executable.');
		}
		return aliases;
	}

	// let the user pick an alias from a supplied list of aliases
	// if no list supplied, get all aliases from alias provider
	private async pickAlias(aliases?: Alias[], prompt?: string): Promise<Alias | undefined>{
		prompt ||= 'Please type a function name/documentation entry';
		aliases ||= await this.getAllAliases();
		if(!aliases){
			return undefined;
		}
		const qpItems: (vscode.QuickPickItem & Alias)[] = aliases.map(v => {
			return {
				...v,
				label: v.name,
				description: `(${v.package}::${v.name})`,
			};
		});
		const qpOptions = {
			matchOnDescription: true,
			placeHolder: prompt
		};
		const qp = await vscode.window.showQuickPick(
			qpItems,
			qpOptions
		);
		return qp;
	}

	private async showHelpForAlias(alias: Alias): Promise<boolean> {
		return this.showHelpForPath(`/library/${alias.package}/html/${alias.alias}.html`);
	}

	// shows help for request path as used by R's internal help server
	public async showHelpForPath(requestPath: string, viewer?: string|any): Promise<boolean> {

		// get and show helpFile
		// const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
		const helpFile = await this.getHelpFileForPath(requestPath);
		if(helpFile){
			return this.showHelpFile(helpFile, viewer);
		} else{
			const msg = `Couldn't show help for path:\n${requestPath}\n`;
			void vscode.window.showErrorMessage(msg);
			return false;
		}
	}

	public async getHelpFileForPath(requestPath: string, modify: boolean = true): Promise<HelpFile | null> {
		// get helpFile from helpProvider if not cached
		if(!this.cachedHelpFiles.has(requestPath)){
			const helpFile = await this.helpProvider.getHelpFileFromRequestPath(requestPath);
			this.cachedHelpFiles.set(requestPath, helpFile);
		}

		// modify the helpFile (syntax highlighting etc.)
		// modifications are optional and cached
		const helpFileCached = this.cachedHelpFiles.get(requestPath);
		if(!helpFileCached){
			return null;
		} else if(modify && !helpFileCached.isModified){
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
		return await this.getNewestHelpPanel().showHelpFile(helpFile, undefined, undefined, viewer);
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
				const html = escapeHtml(helpFile.html);
				helpFile.html = `<html><head></head><body><pre>${html}</pre></body></html>`;
			}

			// parse the html string
			const $ = cheerio.load(helpFile.html);

			$('head style').remove();

			if(config().get<boolean>('helpPanel.enableSyntaxHighlighting')){
				// find all code sections, enclosed by <pre>...</pre>
				const codeSections = $('pre');

				// apply syntax highlighting to each code section:
				codeSections.each((i, section) => {
					const styledCode = hljs.highlight('r', $(section).text() || '');
					$(section).html(styledCode.value);
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
}


function escapeHtml(source: string) {
	const entityMap = new Map<string, string>(Object.entries({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		'\'': '&#39;',
		'/': '&#x2F;'
	}));
    return String(source).replace(/[&<>"'/]/g, (s: string) => entityMap.get(s));
}
