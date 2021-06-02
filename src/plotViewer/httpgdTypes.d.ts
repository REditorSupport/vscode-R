

import * as vscode from 'vscode';
import { HttpgdManager } from '.';

export type MaybePromise<T> = T | Promise<T>;

// type to indicate where a plotId is required
export type PlotId = string;

// supported file types for image export
export type ExportFormat = 'png' | 'jpg' | 'bmp' | 'svg';


export interface HttpgdPlot {
    // url of the connection this plot was retrieved from
    url: string;
    host: string;

    // unique ID for this plot (w.r.t. this connection/device)
    id: PlotId;

    // svg of the plot
    svg: string;
    
    // Size when computed:
    // (displayed size might vary, if % values are used)
    height: number;
    width: number;
}

export interface HttpgdState {
    // What do these mean?
    upid: number;
    hsize: number;
    active: boolean;
    // /?
    
    // Include which plots have changed?
    changedPlots?: PlotId[];
    
    // Indicate that R wants to focus a specific plot?
    focusPlot?: PlotId;
}

// Roughly combines the functionality of HttpgdApi and HttpgdConnection
export declare class IHttpgdViewerApi {
    // Constructor is called by the viewer:
    public constructor(host: string, token?: string);
    
    // api calls:
    // general state info:
    public getState(): MaybePromise<HttpgdState>;
    // get list of plot Ids:
    public getPlotIds(): MaybePromise<PlotId[]>;
    // get content of a single plot. Use sensible defaults if no height/width given:
    public getPlotContent(id: PlotId, height?: number, width?: number): MaybePromise<HttpgdPlot>;
    // get content of multiple plots:
    // Use sensible defaults if no height/width given.
    // Return all plots if no ids given.
    public getPlotContents(ids?: PlotId[], height?: number, width?: number): MaybePromise<HttpgdPlot[]>;
    
    // Export functionality could maybe also be implemented inside vscode-R?
    // Not sure which libraries produce better results...
    // User querying for format and filename is done by vscode
    public exportPlot?(id: PlotId, format: ExportFormat, outFile: string): MaybePromise<void>;
    
    // Method to supply listeners
    // The listener should be called when there is a change to the device
    // Further info (new state, plots etc.) can then be queried by the viewer
    public onConnectionChange(listener: (disconnected: boolean) => void): void;
    public onPlotsChange(listener: () => void): void;

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    // Not sure if sensible here
    public dispose?(): MaybePromise<void>;
}

// Example for possible viewer creation options:
export interface HttpgdViewerOptions {
    parent: HttpgdManager;
    token?: string;
    preserveFocus?: boolean;
    viewColumn?: vscode.ViewColumn;
    htmlRoot: string;
    stripStyles?: boolean;
    useMultirow?: boolean;
    resizeTimeoutLength?: number;
    refreshTimeoutLength?: number;
}

// Roughly combines the functionality of HttpgdNavigator and HttpgdViewer
export class IHttpgdViewer {
    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    api: IHttpgdViewerApi;

    // active plots
    plots: HttpgdPlot[];
    
    // Id of the currently viewed plot
    activePlot?: PlotId;
    
    // Size of the view area:
    viewHeight: number;
    viewWidth: number;
    
    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(options: HttpgdViewerOptions);


    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    show(preserveFocus?: boolean): void;
    
    // focus a specific plot id
    focusPlot(id: PlotId): void;
    
    // navigate through plots (supply `true` to go to end/beginning of list)
    nextPlot(last?: boolean): void;
    prevPlot(first?: boolean): void;
    
    // restore closed plots, show most recent plot etc.?
    resetPlots(): void;
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    exportPlot(id: PlotId, format?: ExportFormat, outFile?: string): void;

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    // Not sure if sensible here
    dispose?(): void;
}
