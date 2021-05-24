/* eslint-disable @typescript-eslint/no-explicit-any */


import * as vscode from 'vscode';
import { Httpgd } from './httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions, PlotId, ExportFormat, HttpgdState } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { config, setContext } from '../util';

import { extensionContext } from '../extension';

import { FocusPlotMessage, InMessage, OutMessage, ToggleStyleMessage, ToggleMultirowMessage, UpdatePlotMessage, HidePlotMessage, AddPlotMessage } from './webviewMessages';


const commands = [
    'showViewers',
    'openUrl',
    'openExternal',
    'showIndex',
    'toggleStyle',
    'toggleMultirow',
    'exportPlot',
    'nextPlot',
    'prevPlot',
    'lastPlot',
    'firstPlot',
    'hidePlot',
    'closePlot',
    'resetPlots',
    'zoomIn',
    'zoomOut'
] as const;

type CommandName = typeof commands[number];

export function initializeHttpgd(): HttpgdManager {
    const httpgdManager = new HttpgdManager();
    for(const cmd of commands){
        const fullCommand = `r.plot.${cmd}`;
        const cb = httpgdManager.getCommandHandler(cmd);
        vscode.commands.registerCommand(fullCommand, cb);
    }
    return httpgdManager;
}

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];
    
    viewerOptions: HttpgdViewerOptions;
    
    recentlyActiveViewers: HttpgdViewer[] = [];
    
    constructor(){
        const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Two
        };
    }

    public showViewer(urlString: string): void {
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token') || undefined;
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host
        );
        if(ind >= 0){
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show();
        } else{
            const conf = config();
            const colorTheme = conf.get('plot.defaults.colorTheme', 'vscode');
            const smallPlotLayout = conf.get('plot.defaults.plotPreviewLayout', 'multirow');
            this.viewerOptions.stripStyles = (colorTheme === 'vscode');
            this.viewerOptions.useMultirow = (smallPlotLayout === 'multirow');
            this.viewerOptions.refreshTimeoutLength = conf.get('plot.timing.refreshInterval', 10);
            this.viewerOptions.resizeTimeoutLength = conf.get('plot.timing.resizeInterval', 100);
            this.viewerOptions.token = token;
            const viewer = new HttpgdViewer(host, this.viewerOptions);
            this.viewers.unshift(viewer);
        }
    }
    
    public registerActiveViewer(viewer: HttpgdViewer): void {
        const ind = this.recentlyActiveViewers.indexOf(viewer);
        if(ind){
            this.recentlyActiveViewers.splice(ind, 1);
        }
        this.recentlyActiveViewers.unshift(viewer);
    }
    
    public getRecentViewer(): HttpgdViewer | undefined {
        return this.recentlyActiveViewers.find((viewer) => !!viewer.webviewPanel);
    }
    
    public getNewestViewer(): HttpgdViewer | undefined {
        return this.viewers[0];
    }
    
    public getCommandHandler(command: CommandName): (...args: any[]) => void {
        return (...args: any[]) => {
            this.handleCommand(command, ...args);
        };
    }
    
    public async openUrl(): Promise<void> {
        const clipText = await vscode.env.clipboard.readText();
        const val0 = clipText.trim().split(/[\n ]/)[0];
        const options: vscode.InputBoxOptions = {
            value: val0,
            prompt: 'Please enter the httpgd url'
        };
        const urlString = await vscode.window.showInputBox(options);
        if(urlString){
            this.showViewer(urlString);
        }
    }
    
    // generic command handler
    public handleCommand(command: CommandName, hostOrWebviewUri?: string | vscode.Uri, ...args: any[]): void {
        // the number and type of arguments given to a command can vary, depending on where it was called from:
        // - calling from the title bar menu provides two arguments, the first of which identifies the webview
        // - calling from the command palette provides no arguments
        // - calling from a command uri provides a flexible number/type of arguments
        // below  is an attempt to handle these different combinations efficiently and (somewhat) robustly
        // 

        if(command === 'showViewers'){
            this.viewers.forEach(viewer => {
                viewer.show(true);
            });
            return;
        } else if(command === 'openUrl'){
            void this.openUrl();
            return;
        }

        // Identify the correct viewer
        let viewer: HttpgdViewer | undefined;
        if(typeof hostOrWebviewUri === 'string'){
            const host = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.host === host);
        } else if(hostOrWebviewUri instanceof vscode.Uri){
            const uri = hostOrWebviewUri;
            viewer = this.viewers.find((viewer) => viewer.getPanelPath() === uri.path);
        } else {
            viewer = this.getRecentViewer();
        }

        // Abort if no viewer identified
        if(!viewer){
            return;
        }
        
        // Get possible arguments for commands:
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');
        
        // Call corresponding method, possibly with an argument:
        switch(command) {
            case 'showIndex': {
                void viewer.focusPlot(stringArg);
                break;
            } case 'nextPlot': {
                viewer.nextPlot(boolArg);
                break;
            } case 'prevPlot': {
                viewer.prevPlot(boolArg);
                break;
            } case 'lastPlot': {
                viewer.nextPlot(true);
                break;
            } case 'firstPlot': {
                viewer.prevPlot(true);
                break;
            } case 'resetPlots': {
                viewer.resetPlots();
                break;
            } case 'toggleStyle': {
                void viewer.toggleStyle(boolArg);
                break;
            } case 'toggleMultirow': {
                void viewer.toggleMultirow(boolArg);
                break;
            } case 'closePlot': {
                void viewer.closePlot(stringArg);
                break;
            } case 'hidePlot': {
                void viewer.hidePlot(stringArg);
                break;
            } case 'exportPlot': {
                void viewer.exportPlot(stringArg);
                break;
            } case 'zoomIn': {
                void viewer.zoomIn();
                break;
            } case 'zoomOut': {
                void viewer.zoomOut();
                break;
            } case 'openExternal': {
                void viewer.openExternal();
                break;
            } default: {
                break;
            }
        }
    }
}


interface EjsData {
    overwriteStyles: boolean;
    useMultirow: boolean;
    activePlot?: PlotId;
    plots: HttpgdPlot[];
    largePlot: HttpgdPlot;
    host: string;
    asLocalPath: (relPath: string) => string;
    asWebViewPath: (localPath: string) => string;
    makeCommandUri: (command: string, ...args: any[]) => string;
    
    // only used to render an individual smallPlot div:
    plot?: HttpgdPlot;
}

interface ShowOptions {
    viewColumn: vscode.ViewColumn,
    preserveFocus?: boolean    
}

export class HttpgdViewer implements IHttpgdViewer {
    
    readonly parent: HttpgdManager;

    readonly host: string;
    readonly token?: string;

    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    readonly api: Httpgd;

    // active plots
    plots: HttpgdPlot[] = [];
    state?: HttpgdState;
    
    // Id of the currently viewed plot
    activePlot?: PlotId;
    
    // Ids of plots that are not shown, but not closed inside httpgd
    hiddenPlots: PlotId[] = [];
    
    readonly defaultStripStyles: boolean = true;
    stripStyles: boolean;
    
    readonly defaultUseMultiRow: boolean = true;
    useMultirow: boolean;
    
    // Size of the view area:
    viewHeight: number;
    viewWidth: number;
    
    // Size of the shown plot (as computed):
    plotHeight: number;
    plotWidth: number;
    
    readonly scale0: number = 1;
    scale: number = this.scale0;
    
    resizeTimeout?: NodeJS.Timeout;
    readonly resizeTimeoutLength: number = 1300;
    
    refreshTimeout?: NodeJS.Timeout;
    readonly refreshTimeoutLength: number = 10;
    
    readonly htmlTemplate: string;
    readonly smallPlotTemplate: string;
    readonly htmlRoot: string;
    
    readonly showOptions: ShowOptions;
    readonly webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;

    // Computed properties:

    // Get/set active plot by index instead of id:
    protected get activeIndex(): number {
        return this.getIndex(this.activePlot);
    }
    protected set activeIndex(ind: number) {
        if(this.plots.length === 0){
            this.activePlot = undefined;
        } else{
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }
    
    // Get scaled view size:
    protected get scaledViewHeight(): number {
        return this.viewHeight * this.scale;
    }
    protected get scaledViewWidth(): number {
        return this.viewWidth * this.scale;
    }

    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(host: string, options: HttpgdViewerOptions) {
        this.host = host;
        this.token = options.token;
        this.parent = options.parent;
        this.api = new Httpgd(this.host, this.token);
        this.api.onPlotsChange(() => {
            this.checkStateDelayed();
        });
        this.api.onConnectionChange(() => {
            this.checkStateDelayed();
        });
        this.htmlRoot = options.htmlRoot;
        this.htmlTemplate = fs.readFileSync(path.join(this.htmlRoot, 'index.ejs'), 'utf-8');
        this.smallPlotTemplate = fs.readFileSync(path.join(this.htmlRoot, 'smallPlot.ejs'), 'utf-8');
        this.showOptions = {
            viewColumn: options.viewColumn ?? vscode.ViewColumn.Two,
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true
        };
        this.defaultStripStyles = options.stripStyles ?? this.defaultStripStyles;
        this.stripStyles = this.defaultStripStyles;
        this.defaultUseMultiRow = options.useMultirow ?? this.defaultUseMultiRow;
        this.useMultirow = this.defaultUseMultiRow;
        this.resizeTimeoutLength = options.refreshTimeoutLength ?? this.resizeTimeoutLength;
        this.refreshTimeoutLength = options.refreshTimeoutLength ?? this.refreshTimeoutLength;
        this.api.start();
        void this.checkState();
    }


    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    public show(preserveFocus?: boolean): void {
        preserveFocus ??= this.showOptions.preserveFocus;
        if(!this.webviewPanel){
            const showOptions = {
                ...this.showOptions,
                preserveFocus: preserveFocus
            };
            this.webviewPanel = this.makeNewWebview(showOptions);
            this.refreshHtml();
        } else{
            this.webviewPanel.reveal(undefined, preserveFocus);
        }
        this.parent.registerActiveViewer(this);
    }
    
    public openExternal(): void {
        let urlString = `http://${this.host}/live`;
        if(this.token){
            urlString += `?token=${this.token}`;
        }
        const uri = vscode.Uri.parse(urlString);
        void vscode.env.openExternal(uri);
    }
    
    // focus a specific plot id
    public async focusPlot(id?: PlotId): Promise<void> {
        this.activePlot = id;
        const plt = this.plots[this.activeIndex];
        if(plt.height !== this.viewHeight * this.scale || plt.width !== this.viewHeight * this.scale){
            await this.refreshPlots();
        } else{
            this._focusPlot();
        }
    }
    protected _focusPlot(plotId?: PlotId): void {
        plotId ??= this.activePlot;
        const msg: FocusPlotMessage = {
            message: 'focusPlot',
            plotId: plotId
        };
        this.postWebviewMessage(msg);
        void this.setContextValues();
    }
    
    // navigate through plots (supply `true` to go to end/beginning of list)
    public nextPlot(last?: boolean): void {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex+1;
        this._focusPlot();
    }
    public prevPlot(first?: boolean): void {
        this.activeIndex = first ? 0 : this.activeIndex-1;
        this._focusPlot();
    }
    
    // restore closed plots, reset zoom, redraw html
    public resetPlots(): void {
        this.hiddenPlots = [];
        this.scale = this.scale0;
        void this.refreshPlots(true, true);
    }
    
    public hidePlot(id?: PlotId): void {
        id ??= this.activePlot;
        if(!id){ return; }
        const tmpIndex = this.activeIndex;
        this.hiddenPlots.push(id);
        this.plots = this.plots.filter((plt) => !this.hiddenPlots.includes(plt.id));
        if(id === this.activePlot){
            this.activeIndex = tmpIndex;
            this._focusPlot();
        }
        this._hidePlot(id);
    }
    protected _hidePlot(id: PlotId): void {
        const msg: HidePlotMessage = {
            message: 'hidePlot',
            plotId: id
        };
        this.postWebviewMessage(msg);
    }
    
    public async closePlot(id?: PlotId): Promise<void> {
        id ??= this.activePlot;
        if(id){
            this.hidePlot(id);
            await this.api.closePlot(id);
        }
    }
    
    public toggleStyle(force?: boolean): void{
        this.stripStyles = force ?? !this.stripStyles;
        const msg: ToggleStyleMessage = {
            message: 'toggleStyle',
            useOverwrites: this.stripStyles
        };
        this.postWebviewMessage(msg);
    }
    
    public toggleMultirow(force?: boolean): void{
        this.useMultirow = force ?? !this.useMultirow;
        const msg: ToggleMultirowMessage = {
            message: 'toggleMultirow',
            useMultirow: this.useMultirow
        };
        this.postWebviewMessage(msg);
    }
    
    public zoomIn(): void {
        if(this.scale > 0){
            this.scale -= 0.1;
            void this.resizePlot();
        }
    }

    public zoomOut(): void {
        this.scale += 0.1;
        void this.resizePlot();
    }


	public async setContextValues(mightBeInBackground: boolean = false): Promise<void> {
        if(this.webviewPanel?.active){
            this.parent.registerActiveViewer(this);
            await setContext('r.plot.active', true);
            await setContext('r.plot.canGoBack', this.activeIndex > 0);
            await setContext('r.plot.canGoForward', this.activeIndex < this.plots.length - 1);
        } else if (!mightBeInBackground){
            await setContext('r.plot.active', false);
        }
	}
    
    public getPanelPath(): string | undefined {
        if(!this.webviewPanel) {
            return undefined;
        }
        const dummyUri = this.webviewPanel.webview.asWebviewUri(vscode.Uri.file(''));
        const m = /^[^.]*/.exec(dummyUri.authority);
        const webviewId = m[0] || '';
        return `webview-panel/webview-${webviewId}`;
    }

    // internal functions
    // 

    // use a delay to avoid refreshing while a plot is incrementally drawn
    protected checkStateDelayed(): void {
        clearTimeout(this.refreshTimeout);
        if(this.refreshTimeoutLength <= 0){
            void this.checkState();
            this.refreshTimeout = undefined;
        } else {
            this.refreshTimeout = setTimeout(() => {
                void this.checkState();
            }, this.refreshTimeoutLength);
        }
    }
    protected async checkState(): Promise<void> {
        const oldUpid = this.state?.upid;
        this.state = await this.api.getState();
        if(this.state.upid !== oldUpid){
            await this.refreshPlots();
        }
    }
    
    protected getIndex(id: PlotId): number {
        return this.plots.findIndex((plt: HttpgdPlot) => plt.id === id);
    }

    protected handleResize(height: number, width: number, userTriggered: boolean = false): void {
        this.viewHeight = height;
        this.viewWidth = width;
        if(userTriggered || this.resizeTimeoutLength === 0){
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = undefined;
            void this.resizePlot();
        } else if(!this.resizeTimeout){
            this.resizeTimeout = setTimeout(() => {
                void this.resizePlot();
                this.resizeTimeout = undefined;
            }, this.resizeTimeoutLength);
        }
    }
    
    protected async resizePlot(id?: PlotId): Promise<void> {
        id ??= this.activePlot;
        if(!id){ return; }
        const height = this.scaledViewHeight;
        const width = this.scaledViewWidth;
        const plt = await this.getPlotContent(id, height, width);
        this.plotWidth = plt.width;
        this.plotHeight = plt.height;
        this.updatePlot(plt);
    }
    
    protected async refreshPlots(redraw: boolean = false, force: boolean = false): Promise<void> {
        const nPlots = this.plots.length;
        const oldPlotIds = this.plots.map(plt => plt.id);
        let plotIds = await this.api.getPlotIds();
        plotIds = plotIds.filter((id) => !this.hiddenPlots.includes(id));
        const newPlots = plotIds.map(async (id) => {
            const plot = this.plots.find((plt) => plt.id === id);
            if(force || !plot || id === this.activePlot){
                return await this.getPlotContent(id, this.scaledViewHeight, this.scaledViewWidth);
            } else{
                return plot;
            }
        });
        this.plots = await Promise.all(newPlots);
        if(this.plots.length !== nPlots){
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        if(redraw || !this.webviewPanel){
            this.refreshHtml();
        } else{
            for(const plt of this.plots){
                if(oldPlotIds.includes(plt.id)){
                    this.updatePlot(plt);
                } else{
                    this.addPlot(plt);
                }
            }
            this._focusPlot();
        }
    }
    
    protected updatePlot(plt: HttpgdPlot): void {
        const msg: UpdatePlotMessage = {
            message: 'updatePlot',
            plotId: plt.id,
            svg: plt.svg
        };
        this.postWebviewMessage(msg);
    }
    
    protected addPlot(plt: HttpgdPlot): void {
        const ejsData = this.makeEjsData();
        ejsData.plot = plt;
        const html = ejs.render(this.smallPlotTemplate, ejsData);
        const msg: AddPlotMessage = {
            message: 'addPlot',
            html: html
        };
        this.postWebviewMessage(msg);
        void this.setContextValues();
    }

    protected async getPlotContent(id: PlotId, height?: number, width?: number): Promise<HttpgdPlot> {
        height ||= this.scaledViewHeight;
        width ||= this.scaledViewWidth;
        const plt = await this.api.getPlotContent(id, height, width);
        stripSize(plt);
        makeIdsUnique(plt, this.state?.upid || 0);
        this.viewHeight ??= plt.height;
        this.viewWidth ??= plt.width;
        return plt;
    }

    
    // functions for initial or re-drawing of html:
    
    protected refreshHtml(): void {
        this.webviewPanel ??= this.makeNewWebview();
        this.webviewPanel.webview.html = '';
        this.webviewPanel.webview.html = this.makeHtml();
        void this.setContextValues(true);
    }

    protected makeHtml(): string {
        const ejsData = this.makeEjsData();
        const html = ejs.render(this.htmlTemplate, ejsData);
        return html;
    }
    
    protected makeEjsData(): EjsData {
        const asLocalPath = (relPath: string) => {
            if(!this.webviewPanel){
                return relPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, relPath));
            return localUri.fsPath;
        };
        const asWebViewPath = (localPath: string) => {
            if(!this.webviewPanel){
                return localPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();            
        };
        const makeCommandUri = (command: string, ...args: any[]) => {
            const argString = encodeURIComponent(JSON.stringify(args));
            return `command:${command}?${argString}`;
        };
        const ejsData: EjsData = {
            overwriteStyles: this.stripStyles,
            useMultirow: this.useMultirow,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            host: this.host,
            asLocalPath: asLocalPath,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeCommandUri
        };
        return ejsData;
    }
    
    protected makeNewWebview(showOptions?: ShowOptions): vscode.WebviewPanel {
        const webviewPanel = vscode.window.createWebviewPanel(
            'RPlot',
            'R Plot',
            showOptions || this.showOptions,
            this.webviewOptions
        );
        webviewPanel.onDidDispose(() => this.webviewPanel = undefined);
        webviewPanel.onDidChangeViewState(() => {
            void this.setContextValues();
        });
        webviewPanel.webview.onDidReceiveMessage((e: OutMessage) => {
            this.handleWebviewMessage(e);
        });
        return webviewPanel;
    }
    
    protected handleWebviewMessage(msg: OutMessage): void {
        if(msg.message === 'log'){
            console.log(msg.body);
        } else if(msg.message === 'resize'){
            const height = msg.height;
            const width = msg.width;
            const userTriggered = msg.userTriggered;
            void this.handleResize(height, width, userTriggered);
        }
    }
    
    protected postWebviewMessage(msg: InMessage): void {
        this.webviewPanel?.webview.postMessage(msg);
    }
    
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    public async exportPlot(id?: PlotId, format?: ExportFormat, outFile?: string): Promise<void> {
        // make sure id is valid or return:
        id ||= this.activePlot || this.plots[this.plots.length-1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if(!plot){
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        // make sure format is valid or return:
        if(!format){
            const formats: ExportFormat[] = ['svg'];
            const options: vscode.QuickPickOptions = {
                placeHolder: 'Please choose a file format'
            };
            format = await vscode.window.showQuickPick(formats, options) as ExportFormat | undefined;
            if(!format){
                return;
            }
        }
        // make sure outFile is valid or return:
        if(!outFile){
            const options: vscode.SaveDialogOptions = {};
            const outUri = await vscode.window.showSaveDialog(options);
            outFile = outUri?.fsPath;
            if(!outFile){
                return;
            }
        }
        // actually export plot:
        if(format === 'svg'){
            // do export
            fs.writeFileSync(outFile, plot.svg);
            // const uri = vscode.Uri.file(outFile);
            // await vscode.workspace.openTextDocument(uri);
            // void vscode.window.showTextDocument(uri);
        } else{
            void vscode.window.showWarningMessage('Format not implemented');
        }
    }

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    public dispose(): void {
        this.api.dispose();
    }
}

// helper function to handle argument lists that might contain (useless) extra arguments
function findItemOfType(arr: any[], type: 'string'): string | undefined;
function findItemOfType(arr: any[], type: 'boolean'): boolean | undefined;
function findItemOfType(arr: any[], type: 'number'): number | undefined;
function findItemOfType<T = unknown>(arr: any[], type: string): T {
    const item = arr.find((elm) => typeof elm === type) as T;
    return item;
}


function stripSize(plt: HttpgdPlot): void {
    const re = /<(svg.*)width="([^"]*)" height="([^"]*)"(.*)>/;
    const m = re.exec(plt.svg);
    if(!plt.width || isNaN(plt.width)){
        plt.width = Number(m[2]);
    }
    if(!plt.height || isNaN(plt.height)){
        plt.height = Number(m[3]);
    }
    plt.svg = plt.svg.replace(re, '<$1 preserveAspectRatio="none" $4>');
}

function makeIdsUnique(plt: HttpgdPlot, upid: number): void {
    const re = /<clipPath id="(c[0-9]+)">/g;
    const ids: string[] = [];
    let svg = plt.svg;
    let m: RegExpExecArray;
    do {
        m = re.exec(svg);
        if(m){
            ids.push(m[1]);
        }
    } while(m);
    for(const id of ids){
        const newId = `$${upid}_${plt.id}_${plt.height}_${plt.width}_${id}`;
        const re1 = new RegExp(`<clipPath id="${id}">`);
        const replacement1 = `<clipPath id="${newId}">`;
        const re2 = new RegExp(`clip-path='url\\(#${id}\\)'`, 'g');
        const replacement2 = `clip-path='url(#${newId})'`;
        svg = svg.replace(re1, replacement1);
        svg = svg.replace(re2, replacement2);
    }
    plt.svg = svg;
    return;
}
