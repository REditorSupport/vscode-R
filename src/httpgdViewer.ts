

import * as vscode from 'vscode';
import { Httpgd } from './httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions, PlotId, ExportFormat } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { extensionContext } from './extension';


export function initializeHttpgd(): HttpgdManager {
    const httpgdManager = new HttpgdManager();
    const commands = {
        'r.httpgd.showIndex': (id?: string) => httpgdManager.getNewestViewer()?.focusPlot(id),
        'r.httpgd.toggleStyle': () => httpgdManager.viewers.forEach(
            (viewer) => viewer.toggleStyle()
        ),
        'r.httpgd.exportPlot': () => httpgdManager.getNewestViewer()?.exportPlot(),
        'r.httpgd.nextPlot': () => httpgdManager.getNewestViewer()?.nextPlot(),
        'r.httpgd.prevPlot': () => httpgdManager.getNewestViewer()?.prevPlot()
    };
    for(const key in commands){
        vscode.commands.registerCommand(key, commands[key]);
    }
    return httpgdManager;
}

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];
    
    viewerOptions: HttpgdViewerOptions;
    
    constructor(){
        const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
        const htmlTemplatePath = path.join(htmlRoot, 'index.ejs');
        this.viewerOptions = {
            htmlRoot: htmlRoot,
            htmlTemplatePath: htmlTemplatePath,
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Two
        };
    }

    public showViewer(urlString: string): void {
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token');
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host && viewer.token === token
        );
        if(ind >= 0){
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show();

        } else{
            const viewer = new HttpgdViewer(
                this.viewerOptions,
                host,
                token
            );
            this.viewers.unshift(viewer);
        }
    }
    
    public getNewestViewer(): HttpgdViewer | undefined {
        return this.viewers[0];
    }
}


interface EjsData {
    overwriteStyles: boolean;
    activePlot: PlotId;
    plots: HttpgdPlot[];
    largePlot: HttpgdPlot;
    asWebViewPath: (localPath: string) => string;
}


export class HttpgdViewer implements IHttpgdViewer {
    
    host: string;
    token?: string;

    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    api: Httpgd;

    // active plots
    plots: HttpgdPlot[];
    
    // remember closed plots to let user restore?
    discardedPlots: HttpgdPlot[];
    
    // Id of the currently viewed plot
    activePlot?: PlotId;
    
    stripStyles: boolean;
    
    // Size of the view area:
    height: number;
    width: number;
    
    htmlTemplate: string;
    htmlRoot: string;
    
    showOptions: { viewColumn: vscode.ViewColumn, preserveFocus?: boolean };
    webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;
    
    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(options: HttpgdViewerOptions, host: string, token?: string) {
        this.host = host;
        this.token = token;
        this.api = new Httpgd(host, token);
        this.api.onPlotsChange(() => {
            void this.refreshPlots();
        });
        this.api.onConnectionChange(() => {
            void this.refreshPlots();
        });
        this.stripStyles = !!options.stripStyles;
        this.htmlTemplate = fs.readFileSync(options.htmlTemplatePath, 'utf-8');
        this.htmlRoot = options.htmlRoot;
        this.showOptions = {
            viewColumn: options.viewColumn ?? vscode.ViewColumn.Two,
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true
        };
        this.api.start();
    }

	public async setContextValues(): Promise<void> {
		await vscode.commands.executeCommand(
            'setContext', 'r.httpgd.active', !!this.webviewPanel?.active
        );
		await vscode.commands.executeCommand(
            'setContext', 'r.httpgd.canGoBack', this.activeIndex > 0
        );
		await vscode.commands.executeCommand(
            'setContext', 'r.httpgd.canGoForward', this.activeIndex < this.plots.length - 1
        );
	}

    
    async refreshPlots(): Promise<void> {
        this.plots = await this.api.getPlotContents();
        this.activePlot = this.plots[this.plots.length - 1].id;
        this.refreshHtml();
    }
    
    refreshHtml(): void {
        if(!this.webviewPanel){
            this.webviewPanel ??= vscode.window.createWebviewPanel(
                'RPlot',
                'RPlot',
                this.showOptions,
                this.webviewOptions
            );
            this.webviewPanel.onDidDispose(() => this.webviewPanel = undefined);
            this.webviewPanel.onDidChangeViewState(() => {
                void this.setContextValues();
            });
        }
        this.webviewPanel.webview.html = this.makeHtml();
        void this.setContextValues();
    }
    
    makeHtml(): string {
        const asWebViewPath = (localPath: string) => {
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();            
        };
        const ejsData: EjsData = {
            overwriteStyles: this.stripStyles,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            asWebViewPath: asWebViewPath
        };
        const html = ejs.render(this.htmlTemplate, ejsData);
        return html;
    }
    
    get activeIndex(): number {
        return this.plots.findIndex((plt: HttpgdPlot) => plt.id === this.activePlot);
    }
    set activeIndex(ind: number) {
        if(this.plots.length === 0){
            this.activePlot = undefined;
        } else{
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }

    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    show(preserveFocus?: boolean): void {
        // pass
    }
    
    // focus a specific plot id
    focusPlot(id?: PlotId): void {
        this.activePlot = id;
        this.refreshHtml();
    }
    
    // navigate through plots (supply `true` to go to end/beginning of list)
    nextPlot(last?: boolean): void {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex+1;
        this.refreshHtml();
    }
    prevPlot(first?: boolean): void {
        this.activeIndex = first ? 0 : this.activeIndex-1;
        this.refreshHtml();
    }
    
    // restore closed plots, show most recent plot etc.?
    resetPlots(): void {
        // pass
    }
    
    toggleStyle(force?: boolean): void{
        this.stripStyles = force ?? !this.stripStyles;
        this.refreshHtml();
    }
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    exportPlot(id?: PlotId, format?: ExportFormat, outFile?: string): void {
        // pass
        void vscode.window.showInformationMessage('Export not implemented.');
    }

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    // Not sure if sensible here
    dispose?(): void;
}

// not used currently
function stripStyle(svg: string): string {
    svg = svg.replace(/<style.*?<\/style>/s, '');
    svg = svg.replace(/(<rect[^>]*?)style="[^"]*?"/, '$1');
    return svg;
}

