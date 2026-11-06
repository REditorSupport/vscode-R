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
    private renderRevision = 0;
    private pendingNavigation?: number;

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
        if (this.currentEntry?.helpFile.packageDir === packageDir) {
            await this.refreshCurrentEntry();
        }
    }

    private async refreshCurrentEntry(): Promise<void> {
        const panel = this.panel;
        const entry = this.currentEntry;
        if (!panel || !entry) {
            return;
        }
        if (this.pendingNavigation !== undefined) {
            // A refresh belongs to the displayed page, not the destination a
            // user is currently opening. Retain staleness for later history use.
            entry.isStale = true;
            return;
        }
        const revision = ++this.renderRevision;
        const isCurrent = () =>
            this.panel === panel &&
            this.currentEntry === entry &&
            this.renderRevision === revision &&
            this.pendingNavigation === undefined;
        const newHelpFile = await this.rHelp.getHelpFileForPath(
            entry.helpFile.requestPath,
            undefined,
            true,
        );
        if (!newHelpFile || !isCurrent()) {
            return;
        }
        const scrollY = await this.getScrollY();
        if (!isCurrent()) {
            return;
        }
        const prepared = await this.prepareHelpFile({ ...newHelpFile, scrollY }, isCurrent);
        if (!prepared || !isCurrent()) {
            return;
        }
        panel.reveal(undefined, true);
        if (!isCurrent()) {
            return;
        }
        this.publishHelpFile(prepared, panel.webview);
        await this.setContextValues();
    }

    // retrieves the stored webview or creates a new one if the webview was closed
    private getWebview(
        preserveFocus: boolean = false,
        viewColumn: vscode.ViewColumn = vscode.ViewColumn.Two,
    ): vscode.Webview {
        // create webview if necessary
        if (!this.panel) {
            const webViewOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
                enableScripts: true,
                enableFindWidget: true,
                enableCommandUris: true,
                retainContextWhenHidden: true, // keep scroll position when not focussed
            };
            const showOptions = {
                viewColumn: viewColumn,
                preserveFocus: preserveFocus,
            };
            this.panel = vscode.window.createWebviewPanel(
                'rhelp',
                'R Help',
                showOptions,
                webViewOptions,
            );
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
            this.scrollYCallback?.(0);
            this.renderRevision++;
            this.pendingNavigation = undefined;
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
    public showHelpFile(
        helpFile: HelpFile | Promise<HelpFile>,
        updateHistory = true,
        currentScrollY = 0,
        viewer?: vscode.ViewColumn | string,
        preserveFocus: boolean = false,
    ): Promise<boolean> {
        return this.navigateToHelpFile(
            () => Promise.resolve(helpFile),
            updateHistory,
            currentScrollY,
            viewer,
            preserveFocus,
        );
    }

    private beginNavigation(): number {
        const revision = ++this.renderRevision;
        this.pendingNavigation = revision;
        this.scrollYCallback?.(0);
        return revision;
    }

    private endNavigation(revision: number): void {
        if (this.pendingNavigation === revision) {
            this.pendingNavigation = undefined;
        }
    }

    private async navigateToHelpFile(
        load: () => Promise<HelpFile | undefined>,
        updateHistory = true,
        currentScrollY = 0,
        viewer?: vscode.ViewColumn | string,
        preserveFocus = false,
        missingPath?: string,
    ): Promise<boolean> {
        viewer ||= config().get<string>('session.viewers.viewColumn.helpPanel');
        const viewColumn = asViewColumn(viewer);

        // get or create webview:
        const webview = this.getWebview(preserveFocus, viewColumn);
        const revision = this.beginNavigation();
        const isCurrent = () =>
            this.panel?.webview === webview &&
            this.renderRevision === revision &&
            this.pendingNavigation === revision;
        const previous = this.currentEntry;
        const history = this.history.slice();
        const forward = this.forwardHistory.slice();
        try {
            const helpFile = await load();
            if (!isCurrent()) {
                return false;
            }
            if (!helpFile) {
                if (missingPath) {
                    void vscode.window.showWarningMessage(
                        `Did not find help page for path ${missingPath}`,
                    );
                }
                return false;
            }
            const prepared = await this.prepareHelpFile(helpFile, isCurrent);
            if (!prepared || !isCurrent()) {
                return false;
            }
            if (updateHistory && previous) {
                history.push(this.historyEntryWithScroll(previous, currentScrollY));
            }
            this.publishHelpFile(prepared, webview, history, updateHistory ? [] : forward);
            this.endNavigation(revision);
            await this.setContextValues();
            return true;
        } finally {
            this.endNavigation(revision);
        }
    }

    private async prepareHelpFile(
        helpFile: HelpFile,
        isCurrent: () => boolean,
    ): Promise<HelpFile | undefined> {
        if (!isCurrent()) {
            return undefined;
        }
        // Rendering modifies HTML and scroll state. Keep committed history and
        // cached files intact if this asynchronous preparation is superseded.
        const prepared = await this.pimpMyHelp(
            { ...helpFile, scrollY: helpFile.scrollY || 0 },
            this.webviewStyleUri,
            this.webviewScriptUri,
        );
        return isCurrent() ? prepared : undefined;
    }

    private historyEntryWithScroll(entry: HistoryEntry, scrollY: number): HistoryEntry {
        return { ...entry, helpFile: { ...entry.helpFile, scrollY } };
    }

    private publishHelpFile(
        helpFile: HelpFile,
        webview: vscode.Webview,
        history = this.history,
        forward = this.forwardHistory,
    ): void {
        // Publishing and history changes form one synchronous transaction. A
        // failed/cancelled preparation has not consumed either history stack.
        webview.html = helpFile.html;
        this.history = history;
        this.forwardHistory = forward;
        this.currentEntry = {
            helpFile: helpFile,
            isStale: helpFile.isPreview,
        };
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
        await this.navigateHistory('back');
    }
    private async _goBack(currentScrollY = 0): Promise<void> {
        await this.navigateHistory('back', currentScrollY);
    }
    public async goForward(): Promise<void> {
        await this.navigateHistory('forward');
    }
    private async _goForward(currentScrollY = 0): Promise<void> {
        await this.navigateHistory('forward', currentScrollY);
    }
    private async navigateHistory(
        direction: 'back' | 'forward',
        currentScrollY?: number,
    ): Promise<void> {
        const panel = this.panel;
        const previous = this.currentEntry;
        const history = this.history.slice();
        const forward = this.forwardHistory.slice();
        const entry = (direction === 'back' ? history : forward).at(-1);
        if (!panel || !previous || !entry) {
            return;
        }
        const revision = this.beginNavigation();
        const isCurrent = () =>
            this.panel === panel &&
            this.currentEntry === previous &&
            this.renderRevision === revision &&
            this.pendingNavigation === revision;
        try {
            const scrollY = currentScrollY ?? (await this.getScrollY());
            if (!isCurrent()) {
                return;
            }
            const file = entry.isStale
                ? (await this.rHelp.getHelpFileForPath(entry.helpFile.requestPath, true, true)) ||
                  entry.helpFile
                : entry.helpFile;
            if (!isCurrent()) {
                return;
            }
            const prepared = await this.prepareHelpFile(
                { ...file, scrollY: entry.helpFile.scrollY },
                isCurrent,
            );
            if (!prepared || !isCurrent()) {
                return;
            }
            const departing = this.historyEntryWithScroll(previous, scrollY);
            if (direction === 'back') {
                history.pop();
                forward.push(departing);
            } else {
                forward.pop();
                history.push(departing);
            }
            this.publishHelpFile(prepared, panel.webview, history, forward);
            this.endNavigation(revision);
            await this.setContextValues();
        } finally {
            this.endNavigation(revision);
        }
    }

    // Get current scrollY from webview
    private async getScrollY(): Promise<number> {
        if (!this.panel) {
            return 0;
        }
        this.scrollYCallback?.(0);
        let finish!: (y: number) => void;
        const scrollYPromise = new Promise<number>((resolve) => {
            let settled = false;
            // Hidden or replaced webview documents may not acknowledge messages.
            // Losing a scroll position must not disable Back, Forward or Refresh.
            const timeout = setTimeout(() => finish(0), 1000);
            finish = (y: number) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (this.scrollYCallback === finish) {
                    this.scrollYCallback = undefined;
                }
                resolve(y);
            };
            this.scrollYCallback = finish;
        });
        void this.panel.webview.postMessage({ command: 'getScrollY' }).then(
            (delivered) => {
                if (!delivered) {
                    finish(0);
                }
            },
            () => finish(0),
        );
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

            const load = async (): Promise<HelpFile | undefined> => {
                const helpFile = await this.rHelp.getHelpFileForPath(requestPath);
                if (!helpFile) {
                    return undefined;
                }
                return uri.fragment
                    ? { ...helpFile, hash: '#' + uri.fragment }
                    : { ...helpFile, scrollY: 0 };
            };
            if (!uri.path.endsWith('.pdf') && !uri.path.endsWith('.R')) {
                // Claim navigation before fetching as well as preparing HTML.
                await this.navigateToHelpFile(
                    load,
                    true,
                    currentScrollY,
                    undefined,
                    false,
                    requestPath,
                );
                return;
            }
            const helpFile = await load();

            // if successful, show helpfile:
            if (helpFile) {
                if (uri.path.endsWith('.pdf')) {
                    void this.openInExternalBrowser(helpFile);
                } else if (uri.path.endsWith('.R')) {
                    const doc = await vscode.workspace.openTextDocument({
                        language: 'r',
                        content: helpFile.html0,
                    });
                    void vscode.window.showTextDocument(doc);
                }
            } else {
                void vscode.window.showWarningMessage(
                    `Did not find help page for path ${requestPath}`,
                );
            }
        } else if (msg.message === 'mouseClick') {
            // use the additional mouse buttons to go forward/backwards
            const currentScrollY = Number(msg.scrollY) || 0;
            const button: number = Number(msg.button) || 0;
            if (button === 3) {
                await this._goBack(currentScrollY);
            } else if (button === 4) {
                await this._goForward(currentScrollY);
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
            const runCode =
                (isCtrlClick && codeClickConfig?.['Ctrl+Click'] === 'Run') ||
                (isShiftClick && codeClickConfig?.['Shift+Click'] === 'Run') ||
                (isNormalClick && codeClickConfig?.['Click'] === 'Run');
            const copyCode =
                (isCtrlClick && codeClickConfig?.['Ctrl+Click'] === 'Copy') ||
                (isShiftClick && codeClickConfig?.['Shift+Click'] === 'Copy') ||
                (isNormalClick && codeClickConfig?.['Click'] === 'Copy');

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
    private async pimpMyHelp(
        helpFile: HelpFile,
        styleUri?: vscode.Uri | string,
        scriptUri?: vscode.Uri | string,
    ): Promise<HelpFile> {
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
                        const newUri = await vscode.env.asExternalUri(
                            vscode.Uri.parse(newUrl.toString()),
                        );
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
                        const newUri = await vscode.env.asExternalUri(
                            vscode.Uri.parse(newUrl.toString()),
                        );
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
