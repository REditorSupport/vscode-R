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
    getRPathConfigEntry,
    escapeHtml,
} from '../util';
import {HelpPanel} from './panel';
import {HelpProvider, AliasProvider} from './helpProvider';
import {HelpTreeWrapper} from './treeView';
import {PackageManager} from './packages';
import {isGuestSession, rGuestService} from '../liveShare';

// Initialization function that is called once when activating the extension
export async function initializeHelp(
    context: vscode.ExtensionContext,
    rExtension: api.RExtension,
): Promise<RHelp | undefined> {
    // set context value to indicate that the help related tree-view should be shown
    void vscode.commands.executeCommand('setContext', 'r.helpViewer.show', true);

    // get the "vanilla" R path from config
    const rPath = await getRpath(false);

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
        webviewScriptPath: context.asAbsolutePath('/html/help/script.js'),
        webviewStylePath: context.asAbsolutePath('/html/help/theme.css'),
        rScriptFile: context.asAbsolutePath('R/help/getAliases.R'),
        rPath: rPath,
        cwd: cwd,
        persistentState: persistentState,
    };

    let rHelp: RHelp | undefined = undefined;

    try {
        rHelp = new RHelp(rHelpOptions);
    } catch (e) {
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
    // can be used to scroll the document to a certain position when loading
    // useful to remember scroll position when going back/forward
    scrollY?: number
    // used to open the file in an external browser
    url?: string
}

// Internal representation of an "Alias"
export interface Alias {
    // name of a help topic as presented to the user
    name: string
    // name of a help topic as used by the help server
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
    // persistent state, either global or workspace specific
    persistentState: vscode.Memento
    // used by some helper classes:
    rHelp?: RHelp
}

// The name api.HelpPanel is a bit misleading
// This class manages all R-help and R-packages related functions
export class RHelp
    implements api.HelpPanel, vscode.WebviewPanelSerializer<string>
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

    constructor(options: HelpOptions) {
        this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
        this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
        const pkgListener = () => {
            void console.log('Restarting Help Server...');
            void this.refresh(true);
        };
        this.helpProvider = new HelpProvider({
            ...options,
            pkgListener: pkgListener,
        });
        this.aliasProvider = new AliasProvider(options);
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
        if (refreshTreeView) {
            this.treeViewWrapper.refreshPackageRootNode();
        }
        return true;
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
        const aliases = await this.getAllAliases();

        const matchingAliases = aliases?.filter(
            (alias) =>
                token === alias.name ||
                token === `${alias.package}::${alias.name}` ||
                token === `${alias.package}:::${alias.name}`,
        );

        return matchingAliases;
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
    private async getAllAliases(): Promise<Alias[] | undefined> {
        const aliases = await doWithProgress(() =>
            this.aliasProvider.getAllAliases(),
        );
        if (!aliases) {
            void vscode.window.showErrorMessage(
                `Failed to get list of R functions. Make sure that \`jsonlite\` is installed and r.${getRPathConfigEntry()} points to a valid R executable.`,
            );
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
                label: v.name,
                description: `(${v.package}::${v.name})`,
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
            `/library/${alias.package}/html/${alias.alias}.html`,
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
    ): Promise<HelpFile | undefined> {
        // get helpFile from helpProvider if not cached
        if (!this.cachedHelpFiles.has(requestPath)) {
            const helpFile = !isGuestSession
                ? await this.helpProvider.getHelpFileFromRequestPath(
                      requestPath,
                  )
                : await rGuestService.requestHelpContent(requestPath);
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
    const re = new RegExp('<html[^\\n]*>.*</html>', 'ms');
    helpFile.isHtml = !!re.exec(helpFile.html);
    if (!helpFile.isHtml) {
        const html = escapeHtml(helpFile.html);
        helpFile.html = `<html><head></head><body><pre>${html}</pre></body></html>`;
    }

    // parse the html string
    const $ = cheerio.load(helpFile.html);

    // Remove style elements specified in the html itself (replaced with custom CSS)
    $('head style').remove();

    // Apply syntax highlighting:
    if (config().get<boolean>('helpPanel.enableSyntaxHighlighting')) {
        // find all code sections, enclosed by <pre>...</pre>
        const codeSections = $('pre');

        // apply syntax highlighting to each code section:
        codeSections.each((i, section) => {
            const styledCode = hljs.highlight($(section).text() || '', {
                language: 'r',
            });
            $(section).html(styledCode.value);
        });
    }

    // replace html of the helpfile
    helpFile.html = $.html();

    // flag help file as modified
    helpFile.isModified = true;

    return helpFile;
}
