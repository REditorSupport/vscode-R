

import { Httpgd } from 'httpgd';
import { HttpgdPlotId } from 'httpgd/lib/types';
import * as vscode from 'vscode';
import { HttpgdManager } from '.';
import { PreviewPlotLayout } from './webviewMessages';

export type MaybePromise<T> = T | Promise<T>;

export interface HttpgdPlot<T> {

    // unique ID for this plot (w.r.t. this connection/device)
    id: HttpgdPlotId;

    // data of the plot
    data: T;
    
    // Size
    height: number;
    width: number;
    zoom: number;
}

// Example for possible viewer creation options:
export interface HttpgdViewerOptions {
    parent: HttpgdManager;
    token?: string;
    preserveFocus?: boolean;
    viewColumn?: vscode.ViewColumn;
    htmlRoot: string;
    stripStyles?: boolean;
    fullWindow?: boolean;
    previewPlotLayout?: PreviewPlotLayout,
    resizeTimeoutLength?: number;
    refreshTimeoutLength?: number;
}

// Roughly combines the functionality of HttpgdNavigator and HttpgdViewer
export class IHttpgdViewer {
    // Actual webview where the plot viewer is shown
    // Will have to be created anew, if the user closes it and the plot changes
    webviewPanel?: vscode.WebviewPanel;

    // Api that provides plot contents etc.
    api: Httpgd;

    // active plots
    plots: HttpgdPlot<string>[];
    
    // Id of the currently viewed plot
    activePlot?: HttpgdPlotId;
    
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
    focusPlot(id: HttpgdPlotId): void;
    
    // navigate through plots (supply `true` to go to end/beginning of list)
    nextPlot(last?: boolean): void;
    prevPlot(first?: boolean): void;
    
    // restore closed plots, show most recent plot etc.?
    resetPlots(): void;
    
    // export plot
    // if no format supplied, show a quickpick menu etc.
    // if no filename supplied, show selector window
    exportPlot(id: HttpgdPlotId, format?: string, outFile?: string): void;

    // Dispose-function to clean up when vscode closes
    // E.g. to close connections etc., notify R, ...
    // Not sure if sensible here
    dispose?(): void;
}
