

import * as vscode from 'vscode';

// type to indicate where a plotId is required
export type PlotId = string | number;

// supported file types for image export
export type ExportFormat = 'png' | 'jpg' | 'bmp' | 'svg';


export interface HttpgdPlot {
    // url of the connection this plot was retrieved from
    url: string;

    // unique ID for this plot (w.r.t. this connection/device)
    id: PlotId;

    // svg of the plot
    svg: string;
    
    // Size when computed:
    // (displayed size might vary, if % values are used)
    heigth: number;
    width: number;
}

export interface HttpgdState {
    // What do these mean?
    upid: number;
    hsize: number;
    active: boolean;
    // /?
    
    // Include which plots have changed?
    changedPlots: PlotId[];
    
    // Indicate that R wants to focus a specific plot?
    focusPlot?: PlotId;
}

// Example for possible api creation otions:
export interface HttpgdApiOptions {
    useWebsocket: boolean;
    // ...
}

// Roughly combines the functionality of HttpgdApi and HttpgdConnection
export class HttpgdApiAndOrConnection {
    // http api urls
    http: {
        base: string;
        svg: string;
        state: string;
        clear: string;
        remove: string;
        plots: string;
    }
    
    // ws api url:
    ws: string;
    
    // token info
    useToken: boolean;
    token?: string;
    
    // Constructor is called by the viewer:
    public constructor(options: HttpgdApiOptions, host: string, token?: string);
    
    // api calls:
    // general state info:
    public getState(): HttpgdState;
    // get list of plot Ids:
    public getPlotIds(): PlotId[];
    // get content of a single plot. Use sensible defaults if no heigth/width given:
    public getPlotContent(id: PlotId, height?: number, width?: number): HttpgdPlot;
    // get content of multiple plots:
    // Use sensible defaults if no heigth/width given.
    // Return all plots if no ids given.
    public getPlotContents(ids?: PlotId[], heigth?: number, width?: number): HttpgdPlot[];
    
    // Export functionality could maybe also be implemented inside vscode-R?
    // Not sure which libraries produce better results...
    // User querying for format and filename is done by vscode
    public exportPlot(id: PlotId, format: ExportFormat, outFile: string): void;
    
    // Method to supply a listener
    // The listener should be called when there is a change to the device
    // Further info (new state, plots etc.) can then be queried by the viewer
    public onChange(listener: () => void): void;
    listeners: (() => void)[];
    
    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    // Not sure if sensible here
    public dispose?(): void;
}

// Example for possible viewer creation options:
export interface HttpgdViewerOptions extends HttpgdApiOptions {
    preserveFocus: boolean;
}

// Roughly combines the functionality of HttpgdNavigator and HttpgdViewer
export class HttpgdViewer {
    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webview?: vscode.Webview;

    // Api that provides plot contents etc.
    api: HttpgdApiAndOrConnection;

    // active plots
    plots: HttpgdPlot[];
    
    // remember closed plots to let user restore?
    discardedPlots: HttpgdPlot[];
    
    // Id of the currently viewed plot
    activePlot: PlotId;
    
    // Size of the view area:
    height: number;
    width: number;
    
    // constructor called by the session watcher if a corresponding function was called in R
    // creates a new api instance itself
    constructor(options: HttpgdViewerOptions, host: string, token?: string);


    // Methods to interact with the webview
    // Can e.g. be called by vscode commands + menu items:

    // Called to create a new webview if the user closed the old one:
    show(preserveFocus?: boolean): void;
    
    // focus a specific plot id
    focusPlot(id: string): void;
    
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


// Maybe a class like this is useful to interact with multiple devices/sessions?
export class HttpgdManager {
    viewers: HttpgdViewer[];
    
    // Cann be called to either reactivate an existing viewer or create a new one
    public showViewer(host: string, token?: string): void;
}

