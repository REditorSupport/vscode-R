

import * as vscode from 'vscode';
import { Httpgd } from './httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions, PlotId, ExportFormat } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { extensionContext } from './extension';

export function httpgdViewer(urlString: string): void {
    
    const url = new URL(urlString);

    const host = url.host;
    const token = url.searchParams.get('token');

    const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
    const htmlTemplatePath = path.join(htmlRoot, 'index.ejs');
    
    const viewerOptions = {
        htmlRoot: htmlRoot,
        htmlTemplatePath: htmlTemplatePath,
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.Two
    };
    
    const viewer = new HttpgdViewer(viewerOptions, host, token);

    vscode.commands.registerCommand('r.httpgd.showIndex', (id?: string) => {
        viewer.focusPlot(id);
    });
}


interface EjsData {
    overwriteStyles: boolean;
    activePlot: PlotId;
    plots: HttpgdPlot[];
    largePlot: HttpgdPlot;
    asWebViewPath: (localPath: string) => string;
}


export class HttpgdViewer implements IHttpgdViewer {
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
        }
        this.webviewPanel.webview.html = this.makeHtml();
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
    }
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    exportPlot(id: PlotId, format?: ExportFormat, outFile?: string): void {
        // pass
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

