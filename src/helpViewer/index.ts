/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import * as hljs from 'highlight.js';

import * as api from '../api';

import {
    config,
    getRpath,
    doWithProgress,
    DummyMemento,
    getOSConfigEntry,
    escapeHtml,
    makeWebviewCommandUriString,
    uniqueEntries,
    isFileSafe,
} from '../util';
import {HelpPanel} from './panel';
import {HelpProvider, AliasProvider} from './helpProvider';
import {HelpTreeWrapper} from './treeView';
import {PackageManager} from './packages';
import {isGuestSession, rGuestService} from '../liveShare';
import { makePreviewerList, RHelpPreviewerOptions, RLocalHelpPreviewer } from './helpPreviewer';

export type CodeClickAction = 'Ignore' | 'Copy' | 'Run';
export interface CodeClickConfig {
    'Click': CodeClickAction,
    'Ctrl+Click': CodeClickAction,
    'Shift+Click': CodeClickAction,
}
const CODE_CLICKS: (keyof CodeClickConfig)[] = ['Click', 'Ctrl+Click', 'Shift+Click'];
export const codeClickConfigDefault = {
    'Click': 'Copy',
    'Ctrl+Click': 'Run',
    'Shift+Click': 'Ignore',
};

// Initialization function that is called once when activating the extension
export async function initializeHelp(
    context: vscode.ExtensionContext,
    rExtension: api.RExtension,
): Promise<RHelp | undefined> {
    // set context value to indicate that the help related tree-view should be shown
    void vscode.commands.executeCommand('setContext', 'r.helpViewer.show', true);

    // get the "vanilla" R path from config
    const rPath = await getRpath();
    if(!rPath){
        return undefined;
    }

    // get the current working directory from vscode
    const cwd = vscode.workspace.workspaceFolders?.length
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined;

    // get the Memento for storing cached help files (or create a dummy for this session)
    const cacheConfig = config().get<'None' | 'Workspace' | 'Global'>(
        'helpPanel.cacheIndexFiles',
    );
    const persistentState =
        cacheConfig === 'Workspace'
            ? context.workspaceState
            : cacheConfig === 'Global'
                ? context.globalState
                : new DummyMemento();

    // Gather options used in r help related files
    const rHelpOptions: HelpOptions = {
        webviewScriptPath: context.asAbsolutePath('./html/help/script.js'),
        webviewStylePath: context.asAbsolutePath('./html/help/theme.css'),
        rScriptFile: context.asAbsolutePath('./R/help/getAliases.R'),
        indexTemplatePath: context.asAbsolutePath('./html/help/00Index.ejs'),
        rdToHtmlScriptFile: context.asAbsolutePath('./R/help/rdToHtml.R'),
        rPath: rPath,
        cwd: cwd,
        persistentState: persistentState,
    };

    let rHelp: RHelp | undefined = undefined;

    try {
        rHelp = new RHelp(rHelpOptions);
    } catch (e) {
        console.log('Error while launching R Help:', e);
        void vscode.window.showErrorMessage(`Help Panel not available`);
    }

    rExtension.helpPanel = rHelp;

    if (rHelp) {
        // make sure R child processes etc. are terminated when extension closes
        context.subscriptions.push(rHelp);

        // register help related commands

        context.subscriptions.push(
            vscode.commands.registerCommand('r.showHelp', () =>
                rHelp?.treeViewWrapper.helpViewProvider.rootItem.showQuickPick(),
            ),
            vscode.commands.registerCommand('r.helpPanel.back', () =>
                rHelp?.getActiveHelpPanel(false)?.goBack(),
            ),
            vscode.commands.registerCommand('r.helpPanel.forward', () =>
                rHelp?.getActiveHelpPanel(false)?.goForward(),
            ),
            vscode.commands.registerCommand('r.helpPanel.openExternal', () =>
                rHelp?.getActiveHelpPanel(false)?.openInExternalBrowser(),
            ),
            vscode.commands.registerCommand(
                'r.helpPanel.openForSelection',
                (preserveFocus: boolean = false) =>
                    rHelp?.openHelpForSelection(!!preserveFocus),
            ),
            vscode.commands.registerCommand(
                'r.helpPanel.openForPath',
                (path?: string) => {
                    if (path) {
                        void rHelp?.showHelpForPath(path);
                    }
                },
            ),
            vscode.commands.registerCommand(
                'r.helpPanel.openFileByPath',
                async (filepath: string, warn?: boolean) => {
                    if(isFileSafe(filepath)){
                        const uri = vscode.Uri.file(filepath);
                        await vscode.window.showTextDocument(uri);
                    } else if(warn){
                        await vscode.window.showWarningMessage(`The file does not exist: ${filepath}`);
                    }
                }
            )
        );

        vscode.window.registerWebviewPanelSerializer('rhelp', rHelp);
    }

    return rHelp;
}

// Internal representation of a help file
export interface HelpFile {
    // content of the file
    html: string
    // whether the html has been modified already (syntax highlighting etc.)
    isModified?: boolean
    // original content of the file (only used if isModified===true)
    html0?: string
    // flag indicating whether the original file content is html
    isHtml?: boolean
    // path as used by help server. Uses '/' as separator!
    requestPath: string
    // hash-part of the requested URL
    hash?: string
    // if the file is a real file
    isRealFile?: boolean
    // can be set to true to indicate that the file is a (virtual) 00Index.html file
    isIndex?: boolean
    // can be used to scroll the document to a certain position when loading
    // useful to remember scroll position when going back/forward
    scrollY?: number
    // used to open the file in an external browser
    url?: string
    // indicates that this is a preview generated from a .Rd file
    isPreview?: boolean;
    // the .Rd file that this is based on (if it is a preview)
    rdPath?: string;
    // if available, the .R file from which the documentation is generated
    rPaths?: string[];
    // if available, the directory of the previewed R package
    packageDir?: string;
}

// Internal representation of an "Alias"
export interface Alias {
    // main name of a help topic 
    name: string
    // one of possibly many aliases of the same help topic
    alias: string
    // name of the package the alias is from
    package: string
}

// Options to be specified when creating a new rHelp instance (used only once per session)
export interface HelpOptions {
    /* Local path of script.js, used to send messages to vs code */
    webviewScriptPath: string
    /* Local path of theme.css, used to actually format the highlighted syntax */
    webviewStylePath: string
    // path of the R executable
    rPath: string
    // directory in which to launch R processes
    cwd?: string
    // path of getAliases.R
    rScriptFile: string
    // path of the script used to convert .Rd to html
    rdToHtmlScriptFile: string
    // persistent state, either global or workspace specific
    persistentState: vscode.Memento
    // used by some helper classes:
    rHelp?: RHelp
    // path to .ejs file to be used as 00Index.html in previewed packages
    indexTemplatePath: string;
}

// The name api.HelpPanel is a bit misleading
// This class manages all R-help and R-packages related functions
export class RHelp implements api.HelpPanel, vscode.WebviewPanelSerializer<string>
{
    // Path of a vanilla R installation
    readonly rPath: string

    // If applicable, the currently opened wd.
    // Used to read the correct .Rprofile when launching R
    readonly cwd?: string

    // Provides the content of help pages:
    readonly helpProvider: HelpProvider

    // Provides a list of aliases:
    readonly aliasProvider: AliasProvider
    
    // Provides previews of local help pages:
    readonly previewProviders: RLocalHelpPreviewer[]

    // Show/Install/Remove packages:
    readonly packageManager: PackageManager

    // The tree view that shows available packages and help topics
    readonly treeViewWrapper: HelpTreeWrapper

    // the webview panel(s) where the help is shown
    public readonly helpPanels: HelpPanel[] = []

    // locations on disk, only changed on construction
    readonly webviewScriptFile: vscode.Uri // the javascript added to help pages
    readonly webviewStyleFile: vscode.Uri // the css file applied to help pages

    // cache for modified help files (syntax highlighting etc.)
    private cachedHelpFiles: Map<string, HelpFile | undefined> = new Map<
        string,
        HelpFile | undefined
    >()

    // The options used when creating this instance
    private helpPanelOptions: HelpOptions
    private helpPreviewerOptions: RHelpPreviewerOptions

    constructor(options: HelpOptions) {
        this.rPath = options.rPath;
        this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
        this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
        const pkgListener = () => {
            console.log('Restarting Help Server...');
            void this.refresh(true);
        };
        this.helpProvider = new HelpProvider({
            ...options,
            pkgListener: pkgListener,
        });
        this.aliasProvider = new AliasProvider(options);
        const previewListener = (previewer: RLocalHelpPreviewer) => {
            console.log(`Refreshing R Help preview: ${previewer.packageDir}`);
            void this.refreshPreviewer(previewer);
        };
        this.helpPreviewerOptions = {
            indexTemplatePath: options.indexTemplatePath,
            rdToHtmlScriptFile: options.rdToHtmlScriptFile,
            rPath: this.rPath,
            previewListener: previewListener
        };
        this.previewProviders = makePreviewerList(this.helpPreviewerOptions);
        this.packageManager = new PackageManager({...options, rHelp: this});
        this.treeViewWrapper = new HelpTreeWrapper(this);
        this.helpPanelOptions = options;
    }

    async deserializeWebviewPanel(
        webviewPanel: vscode.WebviewPanel,
        path: string,
    ): Promise<void> {
        const panel = this.makeNewHelpPanel(webviewPanel);
        await this.showHelpForPath(path, undefined, true, panel);
        return;
    }

    // used to close files, stop servers etc.
    public dispose(): void {
        const children = [
            this.helpProvider,
            this.aliasProvider,
            this.packageManager,
            this.treeViewWrapper,
            ...this.helpPanels,
            ...this.previewProviders
        ];
        for (const child of children) {
            if (
                child &&
                'dispose' in child &&
                typeof child.dispose === 'function'
            ) {
                try {
                    child.dispose();
                } catch (e) {}
            }
        }
    }

    // refresh cached help info
    public async refresh(refreshTreeView: boolean = false): Promise<boolean> {
        this.cachedHelpFiles.clear();
        await this.helpProvider?.refresh?.();
        await this.aliasProvider?.refresh?.();
        await this.packageManager?.refresh?.();

        // completely replace previewers
        while(this.previewProviders.length){
            this.previewProviders.pop()?.dispose();
        }
        this.previewProviders.push(...makePreviewerList(this.helpPreviewerOptions));

        // refresh helpPanels
        for (const panel of this.helpPanels) {
            await panel.refresh();
        }

        // refresh tree view
        if (refreshTreeView) {
            this.treeViewWrapper.refreshPackageRootNode();
            this.treeViewWrapper.refreshRootNode();
        }
        return true;
    }

    // refresh only a certain preview:
    public refreshPreviewer(previewer: RLocalHelpPreviewer): void {
        if(previewer.isDisposed){
            const ind = this.previewProviders.indexOf(previewer);
            if(ind >= 0){
                this.previewProviders.splice(ind, 1);
                this.treeViewWrapper.refreshRootNode();
            }
            void vscode.window.showWarningMessage(`Disposing R-Help Previewer for: ${previewer.packageDir}`);
        } else{
            for (const panel of this.helpPanels) {
                void panel.refreshPreview(previewer.packageDir);
            }
            this.treeViewWrapper.refreshPreviewNode(previewer.packageDir);
        }
    }

    // refresh cached help info only for a specific file/package
    public clearCachedFiles(re: string | RegExp): void {
        for (const path of this.cachedHelpFiles.keys()) {
            if (
                (typeof re === 'string' && path === re) ||
                (typeof re !== 'string' && re.exec(path))
            ) {
                this.cachedHelpFiles.delete(path);
            }
        }
    }

    // create a new help panel
    public makeNewHelpPanel(panel?: vscode.WebviewPanel): HelpPanel {
        const helpPanel = new HelpPanel(this.helpPanelOptions, this, panel);
        this.helpPanels.unshift(helpPanel);
        return helpPanel;
    }

    // return the active help panel
    // if no help panel is active and fallBack==true, the newest help panel is returned
    // (or a new one created)
    public getActiveHelpPanel(): HelpPanel
    public getActiveHelpPanel(fallBack?: boolean): HelpPanel | undefined
    public getActiveHelpPanel(fallBack: boolean = true): HelpPanel | undefined {
        for (const helpPanel of this.helpPanels) {
            if (helpPanel.panel && helpPanel.panel.active) {
                return helpPanel;
            }
        }
        if (fallBack) {
            return this.getNewestHelpPanel();
        }
        return undefined;
    }

    // return the newest help panel
    // if no help panel is available and createNewPanel==true, a new panel is created
    public getNewestHelpPanel(): HelpPanel
    public getNewestHelpPanel(createNewPanel: boolean): HelpPanel | undefined
    public getNewestHelpPanel(
        createNewPanel: boolean = true,
    ): HelpPanel | undefined {
        if (this.helpPanels.length) {
            return this.helpPanels[0];
        } else if (createNewPanel) {
            return this.makeNewHelpPanel();
        } else {
            return undefined;
        }
    }

    // search function, similar to typing `?? ...` in R
    public async searchHelpByText(): Promise<boolean> {
        const searchTerm = await vscode.window.showInputBox({
            value: '',
            prompt: 'Please enter a search term',
        });
        if (searchTerm !== undefined) {
            return this.showHelpForPath(
                `/doc/html/Search?pattern=${searchTerm}`,
            );
        }
        return false;
    }

    // quickly open help for selection
    public async openHelpForSelection(
        preserveFocus: boolean = false,
    ): Promise<boolean> {
        // only use if we failed to show help page:
        let errMsg = '';

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            // the text to show help for:
            let txt = '';
            if (editor.selection.isEmpty) {
                // no text selected -> find word at current cursor position
                // use regex including ":" to capture package/namespace (e.g. base::print)
                const re = /([a-zA-Z0-9._:])+/;
                const range = editor.document.getWordRangeAtPosition(
                    editor.selection.start,
                    re,
                );
                // check if the cursor is at a word (else: whitespace -> ignore)
                if (range) {
                    txt = editor.document.getText(range);
                }
            } else {
                // use selected text
                txt = editor.document.getText(editor.selection);
            }
            txt = txt.trim();
            if (txt) {
                const success = await this.openHelpByAlias(txt, preserveFocus);
                if (!success) {
                    errMsg = `Failed to open help for "${txt}"!`;
                }
            } else {
                errMsg = 'Cannot show help: No valid text selected!';
            }
        } else {
            errMsg = 'No editor active!';
        }
        if (errMsg) {
            void vscode.window.showErrorMessage(errMsg);
            return false;
        }
        return true;
    }

    // quickly open help page by alias
    public async openHelpByAlias(
        token: string = '',
        preserveFocus: boolean = false,
    ): Promise<boolean> {
        const matchingAliases = await this.getMatchingAliases(token);

        let pickedAlias: Alias | undefined;
        if (!matchingAliases?.length) {
            return false;
        } else if (matchingAliases.length === 1) {
            pickedAlias = matchingAliases[0];
        } else {
            pickedAlias = await this.pickAlias(matchingAliases);
            if (!pickedAlias) {
                // aborted by user -> return successful
                return true;
            }
        }
        if (pickedAlias) {
            return await this.showHelpForAlias(pickedAlias, preserveFocus);
        }
        return false;
    }

    public async getMatchingAliases(
        token: string,
    ): Promise<Alias[] | undefined> {
        const aliases = await this.getAllAliases(true);
        if(!aliases){
            return undefined;
        }

        const matchingAliases = aliases.filter(
            (alias) =>
                token === alias.alias ||
                token === `${alias.package}::${alias.alias}` ||
                token === `${alias.package}:::${alias.alias}`,
        );
        
        // Filter out identical aliases. This would cause noticeable delay on the full list.
        const aliasesIdentical = (a1: Alias, a2: Alias) => (
            a1.package === a2.package
            && a1.name.replace(/^dot-/, '.') === a2.name.replace(/^dot-/, '.')
        );
        const uniqueAliases = uniqueEntries(matchingAliases, aliasesIdentical);

        return uniqueAliases;
    }

    // search function, similar to calling `?` in R
    public async searchHelpByAlias(): Promise<boolean> {
        const alias = await this.pickAlias();
        if (alias) {
            return this.showHelpForAlias(alias);
        }
        return false;
    }

    // helper function to get aliases from aliasprovider
    private async getAllAliases(includePreview: boolean = false): Promise<Alias[] | undefined> {
        const aliases = await doWithProgress(
            () => this.aliasProvider.getAllAliases(),
            vscode.ProgressLocation.Window
        );
        if (!aliases) {
            void vscode.window.showErrorMessage(
                `Failed to get list of R functions. Make sure that \`jsonlite\` is installed and r.${getOSConfigEntry('rpath')} points to a valid R executable.`,
            );
            return undefined;
        }
        if(includePreview){
            const previewAliases: Alias[] = this.previewProviders.flatMap(previewer => {
                return previewer.getAliases() || [];
            });
            aliases.push(...previewAliases);
        }
        return aliases;
    }

    // let the user pick an alias from a supplied list of aliases
    // if no list supplied, get all aliases from alias provider
    private async pickAlias(
        aliases?: Alias[],
        prompt?: string,
    ): Promise<Alias | undefined> {
        prompt ||= 'Please type a function name/documentation entry';
        aliases ||= await this.getAllAliases();
        if (!aliases) {
            return undefined;
        }
        const qpItems: (vscode.QuickPickItem & Alias)[] = aliases.map((v) => {
            return {
                ...v,
                label: v.alias,
                description: `(${v.package}::${v.alias})`,
            };
        });
        const qpOptions = {
            matchOnDescription: true,
            placeHolder: prompt,
        };
        const qp = await vscode.window.showQuickPick(qpItems, qpOptions);
        return qp;
    }

    private async showHelpForAlias(
        alias: Alias,
        preserveFocus: boolean = false,
    ): Promise<boolean> {
        return this.showHelpForPath(
            `/library/${alias.package}/html/${alias.name}.html`,
            undefined,
            preserveFocus,
        );
    }

    // shows help for request path as used by R's internal help server
    public async showHelpForPath(
        requestPath: string,
        viewer?: string | any,
        preserveFocus: boolean = false,
        panel?: HelpPanel,
    ): Promise<boolean> {
        // get and show helpFile
        // const helpFile = this.helpProvider.getHelpFileFromRequestPath(requestPath);
        const helpFile = await this.getHelpFileForPath(requestPath);
        if (helpFile) {
            return this.showHelpFile(helpFile, viewer, preserveFocus, panel);
        } else {
            const msg = `Couldn't show help for path:\n${requestPath}\n`;
            void vscode.window.showErrorMessage(msg);
            return false;
        }
    }

    public async getHelpFileForPath(
        requestPath: string,
        modify: boolean = true,
        skipCache: boolean = false
    ): Promise<HelpFile | undefined> {
        // try to get a preview first
        const preview = await this.getHelpPreviewForPath(requestPath);
        if(preview){
            pimpMyHelp(preview);
            return preview;
        }

        // get helpFile from helpProvider if not cached
        if (skipCache || !this.cachedHelpFiles.has(requestPath)) {
            const helpFile = !isGuestSession
                ? await this.helpProvider.getHelpFileFromRequestPath(requestPath)
                : await rGuestService?.requestHelpContent(requestPath);
            this.cachedHelpFiles.set(requestPath, helpFile);
        }

        // modify the helpFile (syntax highlighting etc.)
        // modifications are optional and cached
        const helpFileCached = this.cachedHelpFiles.get(requestPath);
        if (!helpFileCached) {
            return undefined;
        } else if (modify && !helpFileCached.isModified) {
            pimpMyHelp(helpFileCached);
        }

        // make deep copy to avoid messing with cache
        const helpFile = {
            ...helpFileCached,
        };

        return helpFile;
    }
    
    private async getHelpPreviewForPath(requestPath: string): Promise<HelpFile | undefined> {
        for (const previewer of this.previewProviders) {
            const ret = await previewer.getHelpFileFromRequestPath(requestPath);
            if(ret){
                return ret;
            }
        }
        return undefined;
    }

    // shows (internal) help file object in webview
    private async showHelpFile(
        helpFile: HelpFile | Promise<HelpFile>,
        viewer?: string | any,
        preserveFocus: boolean = false,
        panel?: HelpPanel,
    ): Promise<boolean> {
        panel ||= this.getNewestHelpPanel();
        return await panel.showHelpFile(
            helpFile,
            undefined,
            undefined,
            viewer,
            preserveFocus,
        );
    }
}

// improves the help display by applying syntax highlighting and adjusting hyperlinks
// only contains modifications that are independent of the webview panel
// (i.e. no modified file paths, scroll position etc.)
function pimpMyHelp(helpFile: HelpFile): HelpFile {
    // Retun if the help file is already modified
    if (helpFile.isModified) {
        return helpFile;
    }

    // store original html content
    helpFile.html0 = helpFile.html;

    // Make sure the helpfile content is actually html
    const re = /^<!DOCTYPE html/;
    const re2 = new RegExp('<html[^\\n]*>.*</html>', 'ms');
    helpFile.isHtml = (!!re.exec(helpFile.html) || !!re2.exec(helpFile.html));
    if (!helpFile.isHtml) {
        const html = escapeHtml(helpFile.html);
        helpFile.html = `<html><head></head><body><pre>${html}</pre></body></html>`;
        helpFile.isModified = true;
    }
    
    // parse the html string for futher modifications
    const $ = cheerio.load(helpFile.html);

    // use .isHtml as proxy for syntax highlighting, clickable <pre> etc.
    if(helpFile.isHtml){
        // Remove style elements specified in the html itself (replaced with custom CSS)
        $('head style').remove();

        // strip tags: <code class="language-R">...
        const preCodes = $('pre>code');
        preCodes.each((_, pc) => {
            $(pc).replaceWith($(pc).html() || '');
        });

        // Split code examples at empty lines:
        const codeClickConfig = config().get<CodeClickConfig>('helpPanel.clickCodeExamples');
        const isEnabled = CODE_CLICKS.some(k => codeClickConfig?.[k] !== 'Ignore');
        if(isEnabled){
            $('body').addClass('preClickable');
            const codeSections = $('pre');
            codeSections.each((i, section) => {
                const innerHtml = $(section).html();
                if(!innerHtml){
                    return;
                }
                const newPres = innerHtml.split('\n\n').map(s => s && `<pre class=preCodeExample>${s}</pre>`);
                const newHtml = '<div class="preDiv">' + newPres.join('\n') + '</div>';
                $(section).replaceWith(newHtml);
            });
        }
        if(codeClickConfig?.Click !== 'Ignore'){
            $('body').addClass('preHoverPointer');
        }

        // Apply syntax highlighting:
        if (config().get<boolean>('helpPanel.enableSyntaxHighlighting')) {
            // find all code sections, enclosed by <pre>...</pre>
            const codeSections = $('pre');

            // apply syntax highlighting to each code section:
            codeSections.each((i, section) => {
                const styledCode = hljs.default.highlight($(section).text() || '', {
                    language: 'r',
                });
                $(section).html(styledCode.value);
            });
        }
    }

    // Highlight help preview:
    if(helpFile.isPreview){
        let rdInfo: string;
        if(helpFile.isIndex){
            rdInfo = 'local .Rd files. Might containt non-exported entries that will not be present in the installed Index';
        } else if(helpFile.rdPath && isFileSafe(helpFile.rdPath)){
            const localRdPath = vscode.workspace.asRelativePath(helpFile.rdPath);
            const rdUri = vscode.Uri.file(helpFile.rdPath);
            const cmdUri = makeWebviewCommandUriString('r.helpPanel.openFileByPath', rdUri.fsPath, true);
            rdInfo = `<a href="${cmdUri}" title="Open File">${localRdPath}</a>`;
        } else{
            rdInfo = `a local file`;
        }
        if(helpFile.rPaths?.length){
            const rHrefs = helpFile.rPaths.map(rPath => {
                const localRPath = vscode.workspace.asRelativePath(rPath);
                if(isFileSafe(rPath)){
                    const rUri = vscode.Uri.file(rPath);
                    const cmdUri = makeWebviewCommandUriString('r.helpPanel.openFileByPath', rUri.fsPath, true);
                    return `<a href="${cmdUri}" title="Open File">${localRPath}</a>`;
                } else{
                    return localRPath;
                }
            });
            rdInfo += `, based on Roxygen comments in ${rHrefs.join(', ')}`;
        }
        const infoBlock = `<div class="previewInfo"> Preview generated from ${rdInfo}. </div>`;
        $('body').prepend(infoBlock);
    }

    // replace html of the helpfile
    helpFile.html = $.html();

    // flag help file as modified
    helpFile.isModified = true;

    return helpFile;
}
