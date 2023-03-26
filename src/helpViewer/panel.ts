/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import * as cheerio from 'cheerio';

import { CodeClickConfig, HelpFile, RHelp } from '.';
import { setContext, UriIcon, config, asViewColumn } from '../util';
import { runTextInTerm } from '../rTerminal';
import { OutMessage } from './webviewMessages';

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
    isStale?: boolean; // Used to mark history entries as stale after a refresh
}

export class HelpPanel {

    private readonly rHelp: RHelp;

    // the webview panel where the help is shown
    public panel?: vscode.WebviewPanel;

    // locations on disk, only changed on construction
    readonly webviewScriptFile: vscode.Uri; // the javascript added to help pages
    readonly webviewStyleFile: vscode.Uri; // the css file applied to help pages

    // virtual locations used by webview, changed each time a new webview is created
    private webviewScriptUri?: vscode.Uri;
    private webviewStyleUri?: vscode.Uri;

    // keep track of history to go back/forward:
    private currentEntry: HistoryEntry | undefined = undefined;
    private history: HistoryEntry[] = [];
    private forwardHistory: HistoryEntry[] = [];

    // used to get scrollY position from webview:
    private scrollYCallback?: (y: number) => void;

    constructor(options: HelpPanelOptions, rHelp: RHelp, panel?: vscode.WebviewPanel) {
        this.webviewScriptFile = vscode.Uri.file(options.webviewScriptPath);
        this.webviewStyleFile = vscode.Uri.file(options.webviewStylePath);
        this.rHelp = rHelp;
        if (panel) {
            this.panel = panel;
            this.initializePanel();
        }
    }

    // used to close files, stop servers etc.
    public dispose(): void {
        if (this.panel) {
            this.panel.dispose();
        }
    }

    public async refresh(): Promise<void> {
        for (const he of [...this.history, ...this.forwardHistory]) {
            he.isStale = true;
        }
        await this.refreshCurrentEntry();
    }
    
    public async refreshPreview(packageDir: string): Promise<void> {
        if(this.currentEntry?.helpFile.packageDir === packageDir){
            await this.refreshCurrentEntry();
        }
    }
    
    private async refreshCurrentEntry(): Promise<void> {
        if(!this.currentEntry){
            return;
        }
        const newHelpFile = await this.rHelp.getHelpFileForPath(this.currentEntry.helpFile.requestPath, undefined, true);
        if(!newHelpFile){
            return;
        }
        newHelpFile.scrollY = await this.getScrollY();
        await this.showHelpFile(newHelpFile, false, undefined, undefined, true);
    }

    // retrieves the stored webview or creates a new one if the webview was closed
    private getWebview(preserveFocus: boolean = false, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Two): vscode.Webview {
        // create webview if necessary
        if (!this.panel) {
            const webViewOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
                enableScripts: true,
                enableFindWidget: true,
                enableCommandUris: true,
                retainContextWhenHidden: true // keep scroll position when not focussed
            };
            const showOptions = {
                viewColumn: viewColumn,
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
        if (!this.panel) {
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
        this.panel.webview.onDidReceiveMessage((e: OutMessage) => {
            void this.handleMessage(e);
        });

        // set context variable to show forward/backward buttons
        this.panel.onDidChangeViewState(() => {
            void this.setContextValues();
        });
    }


    public async setContextValues(): Promise<void> {
        await setContext('r.helpPanel.canOpenExternal', !!this.currentEntry?.helpFile.url);
        await setContext('r.helpPanel.active', !!this.panel?.active);
        await setContext('r.helpPanel.canGoBack', this.history.length > 0);
        await setContext('r.helpPanel.canGoForward', this.forwardHistory.length > 0);
    }

    // shows (internal) help file object in webview
    public async showHelpFile(helpFile: HelpFile | Promise<HelpFile>, updateHistory = true, currentScrollY = 0, viewer?: vscode.ViewColumn | string, preserveFocus: boolean = false): Promise<boolean> {

        viewer ||= config().get<string>('session.viewers.viewColumn.helpPanel');
        const viewColumn = asViewColumn(viewer);

        // get or create webview:
        const webview = this.getWebview(preserveFocus, viewColumn);

        // make sure helpFile is not a promise:
        helpFile = await helpFile;

        helpFile.scrollY = helpFile.scrollY || 0;

        // modify html
        helpFile = await this.pimpMyHelp(helpFile, this.webviewStyleUri, this.webviewScriptUri);

        // actually show the help page
        webview.html = helpFile.html;

        // update history to enable back/forward
        if (updateHistory) {
            if (this.currentEntry) {
                this.currentEntry.helpFile.scrollY = currentScrollY;
                this.history.push(this.currentEntry);
            }
            this.forwardHistory = [];
        }
        this.currentEntry = {
            helpFile: helpFile,
            isStale: helpFile.isPreview
        };

        await this.setContextValues();

        return true;
    }

    public async openInExternalBrowser(helpFile?: HelpFile): Promise<boolean> {
        if (!this.currentEntry) {
            return false;
        }
        if (!helpFile) {
            helpFile = this.currentEntry.helpFile;
        }
        const url = helpFile.url;
        if (!url) {
            return false;
        }
        const uri = vscode.Uri.parse(url);
        return vscode.env.openExternal(uri);
    }

    // go back/forward in the history of the webview:
    public async goBack(): Promise<void> {
        const scrollY = await this.getScrollY();
        this._goBack(scrollY);

    }
    private _goBack(currentScrollY = 0): void {
        const entry = this.history.pop();
        if (entry) {
            if (this.currentEntry) { // should always be true
                this.currentEntry.helpFile.scrollY = currentScrollY;
                this.forwardHistory.push(this.currentEntry);
            }
            void this.showHistoryEntry(entry);
        }
    }
    public async goForward(): Promise<void> {
        const scrollY = await this.getScrollY();
        this._goForward(scrollY);

    }
    private _goForward(currentScrollY = 0): void {
        const entry = this.forwardHistory.pop();
        if (entry) {
            if (this.currentEntry) { // should always be true
                this.currentEntry.helpFile.scrollY = currentScrollY;
                this.history.push(this.currentEntry);
            }
            void this.showHistoryEntry(entry);
        }
    }
    private async showHistoryEntry(entry: HistoryEntry) {
        let helpFile: HelpFile;
        if (entry.isStale) {
            // Fallback to stale helpFile.
            // Handle differently?
            const newHelpFile = await this.rHelp.getHelpFileForPath(entry.helpFile.requestPath, true, true);
            helpFile = newHelpFile || entry.helpFile;
            helpFile.scrollY = entry.helpFile.scrollY;
        } else {
            helpFile = entry.helpFile;
        }

        void this.showHelpFile(helpFile, false);
    }

    // Get current scrollY from webview
    private async getScrollY(): Promise<number> {
        this.scrollYCallback?.(0);
        const scrollYPromise = new Promise<number>((resolve, reject) => {
            const timeout = setTimeout(() => reject('GetScrollY message timed out after 1s'), 1000);
            this.scrollYCallback = (y: number) => {
                clearTimeout(timeout);
                this.scrollYCallback = undefined;
                resolve(y);
            };
        });
        void this.panel?.webview.postMessage({ command: 'getScrollY' });
        return scrollYPromise;
    }

    // handle message produced by javascript inside the help page
    private async handleMessage(msg: OutMessage) {
        if (msg.message === 'linkClicked') {
            // handle hyperlinks clicked in the webview
            // normal navigation does not work in webviews (even on localhost)
            const href: string = msg.href || '';
            const currentScrollY: number = Number(msg.scrollY) || 0;
            console.log('Link clicked: ' + href);

            // remove first to path entries (if these are webview internal stuff):
            const uri = vscode.Uri.parse(href);
            const parts = uri.path.split('/');
            if (parts[0] !== 'library' && parts[0] !== 'doc') {
                parts.shift();
            }
            if (parts[0] !== 'library' && parts[0] !== 'doc') {
                parts.shift();
            }

            // actual request path as used by R:
            const requestPath = parts.join('/');

            // retrieve helpfile for path:
            const helpFile = await this.rHelp.getHelpFileForPath(requestPath);

            // if successful, show helpfile:
            if (helpFile) {
                if (uri.fragment) {
                    helpFile.hash = '#' + uri.fragment;
                } else {
                    helpFile.scrollY = 0;
                }
                if (uri.path.endsWith('.pdf')) {
                    void this.openInExternalBrowser(helpFile);
                } else if (uri.path.endsWith('.R')) {
                    const doc = await vscode.workspace.openTextDocument({
                        language: 'r',
                        content: helpFile.html0
                    });
                    void vscode.window.showTextDocument(doc);
                } else {
                    void this.showHelpFile(helpFile, true, currentScrollY);
                }
            } else{
                void vscode.window.showWarningMessage(`Did not find help page for path ${requestPath}`);
            }
        } else if (msg.message === 'mouseClick') {
            // use the additional mouse buttons to go forward/backwards
            const currentScrollY = Number(msg.scrollY) || 0;
            const button: number = Number(msg.button) || 0;
            if (button === 3) {
                this._goBack(currentScrollY);
            } else if (button === 4) {
                this._goForward(currentScrollY);
            }
        } else if (msg.message === 'codeClicked') {
            if (!msg.code) {
                return;
            }
            // Process modifiers:
            const isCtrlClick = msg.modifiers.ctrlKey || msg.modifiers.metaKey;
            const isShiftClick = msg.modifiers.shiftKey;
            const isNormalClick = !isCtrlClick && !isShiftClick;

            // Check wheter to copy or run the code (or both or none)
            const codeClickConfig = config().get<CodeClickConfig>('helpPanel.clickCodeExamples');
            const runCode = (
                isCtrlClick && codeClickConfig?.['Ctrl+Click'] === 'Run'
                || isShiftClick && codeClickConfig?.['Shift+Click'] === 'Run'
                || isNormalClick && codeClickConfig?.['Click'] === 'Run'
            );
            const copyCode = (
                isCtrlClick && codeClickConfig?.['Ctrl+Click'] === 'Copy'
                || isShiftClick && codeClickConfig?.['Shift+Click'] === 'Copy'
                || isNormalClick && codeClickConfig?.['Click'] === 'Copy'
            );

            // Execute action:
            if (copyCode) {
                void vscode.env.clipboard.writeText(msg.code);
                void vscode.window.showInformationMessage('Copied code example to clipboard.');
            }
            if (runCode) {
                void runTextInTerm(msg.code);
            }
        } else if (msg.message === 'getScrollY') {
            this.scrollYCallback?.(msg.scrollY || 0);
        } else {
            console.log('Unknown message:', msg);
        }
    }

    // improves the help display by applying syntax highlighting and adjusting hyperlinks:
    private async pimpMyHelp(helpFile: HelpFile, styleUri?: vscode.Uri | string, scriptUri?: vscode.Uri | string): Promise<HelpFile> {

        // get requestpath of helpfile
        const relPath = helpFile.requestPath + (helpFile.hash || '');

        // parse the html string
        const $ = cheerio.load(helpFile.html);

        // set relPath attribute. Used by js inside the page to adjust hyperlinks
        // scroll to top (=0) or last viewed position (if the page is from history)
        $('body').attr('relpath', relPath);
        $('body').attr('scrollyto', `${helpFile.scrollY ?? -1}`);

        if (helpFile.url) {
            // replace katex js/css urls with http://localhost:<port>/ origin
            // and remove others.
            const url = new URL(helpFile.url);

            for (const elem of $('link')) {
                const obj = $(elem);
                const linkUrl = obj.attr('href');
                if (linkUrl) {
                    if (linkUrl.includes('katex')) {
                        const newUrl = new URL(linkUrl, url.origin);
                        const newUri = await vscode.env.asExternalUri(vscode.Uri.parse(newUrl.toString()));
                        obj.attr('href', newUri.toString(true));
                    } else {
                        obj.remove();
                    }
                }
            }

            for (const elem of $('script')) {
                const obj = $(elem);
                const scriptUrl = obj.attr('src');
                if (scriptUrl) {
                    if (scriptUrl.includes('katex')) {
                        const newUrl = new URL(scriptUrl, url.origin);
                        const newUri = await vscode.env.asExternalUri(vscode.Uri.parse(newUrl.toString()));
                        obj.attr('src', newUri.toString(true));
                    } else {
                        obj.remove();
                    }
                }
            }
        }

        if (styleUri) {
            $('body').append(`\n<link rel="stylesheet" href="${styleUri.toString(true)}"></link>`);
        }
        if (scriptUri) {
            $('body').append(`\n<script src=${scriptUri.toString(true)}></script>`);
        }


        // convert to string
        helpFile.html = $.html();

        // return the html of the modified page:
        return helpFile;
    }

}
