
import * as vscode from 'vscode';
import { Httpgd } from 'httpgd';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

import { asViewColumn, config, setContext, UriIcon, makeWebviewCommandUriString } from '../util';
import { extensionContext } from '../extension';
import { FocusPlotMessage, InMessage, OutMessage, ToggleStyleMessage, UpdatePlotMessage, HidePlotMessage, AddPlotMessage, PreviewPlotLayout, PreviewPlotLayoutMessage, ToggleFullWindowMessage } from './webviewMessages';
import { HttpgdIdResponse, HttpgdPlotId, HttpgdRendererId } from 'httpgd/lib/types';
import { autoShareBrowser, isHost, shareServer } from '../liveShare';
import { PlotViewer } from './types';

export class HttpgdManager {
    viewers: HttpgdViewer[] = [];
    viewerOptions: HttpgdViewerOptions;
    recentlyActiveViewers: HttpgdViewer[] = [];

    constructor() {
        const htmlRoot = extensionContext.asAbsolutePath('dist/webviews/httpgd');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            preserveFocus: true
        };
    }

    public async showViewer(urlString: string): Promise<void> {
        const url = new URL(urlString);
        const host = url.host;
        const token = url.searchParams.get('token') || undefined;
        const ind = this.viewers.findIndex(
            (viewer) => viewer.host === host
        );
        if (ind >= 0) {
            const viewer = this.viewers.splice(ind, 1)[0];
            this.viewers.unshift(viewer);
            viewer.show();
        } else {
            const conf = config();
            const colorTheme = conf.get('plot.defaults.colorTheme', 'vscode');
            this.viewerOptions.stripStyles = (colorTheme === 'vscode');
            this.viewerOptions.previewPlotLayout = conf.get<PreviewPlotLayout>('plot.defaults.plotPreviewLayout', 'multirow');
            this.viewerOptions.refreshTimeoutLength = conf.get('plot.timing.refreshInterval', 10);
            this.viewerOptions.resizeTimeoutLength = conf.get('plot.timing.resizeInterval', 100);
            this.viewerOptions.fullWindow = conf.get('plot.defaults.fullWindowMode', false);
            this.viewerOptions.token = token;
            const viewer = new HttpgdViewer(host, this.viewerOptions);
            if (isHost() && autoShareBrowser) {
                const disposable = await shareServer(url, 'httpgd');
                viewer.webviewPanel?.onDidDispose(() => void disposable.dispose());
            }
            this.viewers.unshift(viewer);
        }
    }

    public registerActiveViewer(viewer: HttpgdViewer): void {
        const ind = this.recentlyActiveViewers.indexOf(viewer);
        if (ind >= 0) {
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

    public async openUrl(): Promise<void> {
        const clipText = await vscode.env.clipboard.readText();
        const val0 = clipText.trim().split(/[\n ]/)[0];
        const options: vscode.InputBoxOptions = {
            value: val0,
            prompt: 'Please enter the httpgd url'
        };
        const urlString = await vscode.window.showInputBox(options);
        if (urlString) {
            await this.showViewer(urlString);
        }
    }
}

interface EjsData {
    overwriteStyles: boolean;
    previewPlotLayout: PreviewPlotLayout;
    activePlot?: HttpgdPlotId;
    plots: HttpgdPlot<string>[];
    largePlot: HttpgdPlot<string>;
    host: string;
    asLocalPath: (relPath: string) => string;
    asWebViewPath: (localPath: string) => string;
    makeCommandUri: (command: string, ...args: unknown[]) => string;
    overwriteCssPath: string;
    plot?: HttpgdPlot<string>;
}

interface ShowOptions {
    viewColumn: vscode.ViewColumn,
    preserveFocus?: boolean
}

export class HttpgdViewer implements IHttpgdViewer, PlotViewer {
    readonly id: string;
    readonly parent: HttpgdManager;
    readonly host: string;
    readonly token?: string;
    webviewPanel?: vscode.WebviewPanel;
    readonly api: Httpgd;
    plots: HttpgdPlot<string>[] = [];
    activePlot?: HttpgdPlotId;
    hiddenPlots: HttpgdPlotId[] = [];
    readonly defaultStripStyles: boolean = true;
    stripStyles: boolean;
    readonly defaultPreviewPlotLayout: PreviewPlotLayout = 'multirow';
    previewPlotLayout: PreviewPlotLayout;
    readonly defaultFullWindow: boolean = false;
    fullWindow: boolean;
    customOverwriteCssPath?: string;
    viewHeight: number = 600;
    viewWidth: number = 800;
    plotHeight: number = 600;
    plotWidth: number = 800;
    readonly zoom0: number = 1;
    zoom: number = this.zoom0;
    protected resizeTimeout?: NodeJS.Timeout;
    readonly resizeTimeoutLength: number = 1300;
    protected refreshTimeout?: NodeJS.Timeout;
    readonly refreshTimeoutLength: number = 10;
    private lastExportUri?: vscode.Uri;
    readonly htmlTemplate: string;
    readonly smallPlotTemplate: string;
    readonly htmlRoot: string;
    readonly showOptions: ShowOptions;
    readonly webviewOptions: vscode.WebviewPanelOptions & vscode.WebviewOptions;

    protected get activeIndex(): number {
        if(!this.activePlot){
            return -1;
        }
        return this.getIndex(this.activePlot);
    }
    protected set activeIndex(ind: number) {
        if (this.plots.length === 0) {
            this.activePlot = undefined;
        } else {
            ind = Math.max(ind, 0);
            ind = Math.min(ind, this.plots.length - 1);
            this.activePlot = this.plots[ind].id;
        }
    }

    constructor(host: string, options: HttpgdViewerOptions) {
        this.host = host;
        this.id = host;
        this.token = options.token;
        this.parent = options.parent;

        this.api = new Httpgd(this.host, this.token, true);
        this.api.onPlotsChanged((newState) => {
            void this.refreshPlotsDelayed(newState.plots);
        });
        const conf = config();
        this.customOverwriteCssPath = conf.get('plot.customStyleOverwrites', '');
        const localResourceRoots = (
            this.customOverwriteCssPath ?
                [extensionContext.extensionUri, vscode.Uri.file(path.dirname(this.customOverwriteCssPath))] :
                undefined
        );
        this.htmlRoot = options.htmlRoot;
        this.htmlTemplate = fs.readFileSync(path.join(this.htmlRoot, 'index.ejs'), 'utf-8');
        this.smallPlotTemplate = fs.readFileSync(path.join(this.htmlRoot, 'smallPlot.ejs'), 'utf-8');
        this.showOptions = {
            viewColumn: options.viewColumn ?? asViewColumn(conf.get<string>('session.viewers.viewColumn.plot'), vscode.ViewColumn.Two),
            preserveFocus: !!options.preserveFocus
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localResourceRoots
        };
        this.stripStyles = options.stripStyles ?? this.defaultStripStyles;
        this.previewPlotLayout = options.previewPlotLayout ?? this.defaultPreviewPlotLayout;
        this.fullWindow = options.fullWindow ?? this.defaultFullWindow;
        this.resizeTimeoutLength = options.refreshTimeoutLength ?? this.resizeTimeoutLength;
        this.refreshTimeoutLength = options.refreshTimeoutLength ?? this.refreshTimeoutLength;
        void this.api.connect();
    }

    public handleCommand(command: string, ...args: unknown[]): void | Promise<void> {
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');

        switch (command) {
            case 'showIndex': return this.focusPlot(stringArg);
            case 'nextPlot': return this.nextPlot(boolArg);
            case 'prevPlot': return this.prevPlot(boolArg);
            case 'lastPlot': return this.nextPlot(true);
            case 'firstPlot': return this.prevPlot(true);
            case 'resetPlots': return this.resetPlots();
            case 'toggleStyle': return this.toggleStyle(boolArg);
            case 'togglePreviewPlots': return this.togglePreviewPlots(stringArg as PreviewPlotLayout);
            case 'closePlot': return this.closePlot(stringArg);
            case 'hidePlot': return this.hidePlot(stringArg);
            case 'exportPlot': return this.exportPlot(stringArg);
            case 'zoomIn': return this.zoomIn();
            case 'zoomOut': return this.zoomOut();
            case 'openExternal': return this.openExternal();
            case 'toggleFullWindow': return this.toggleFullWindow();
        }
    }

    public show(preserveFocus?: boolean): void {
        preserveFocus ??= this.showOptions.preserveFocus;
        if (!this.webviewPanel) {
            const showOptions = {
                ...this.showOptions,
                preserveFocus: preserveFocus
            };
            this.webviewPanel = this.makeNewWebview(showOptions);
            this.refreshHtml();
        } else {
            this.webviewPanel.reveal(undefined, preserveFocus);
        }
        this.parent.registerActiveViewer(this);
    }

    public openExternal(): void {
        let urlString = `http://${this.host}/live`;
        if (this.token) {
            urlString += `?token=${this.token}`;
        }
        const uri = vscode.Uri.parse(urlString);
        void vscode.env.openExternal(uri);
    }

    public async focusPlot(id?: HttpgdPlotId): Promise<void> {
        this.activePlot = id || this.activePlot;
        const plt = this.plots[this.activeIndex];
        if (plt && (plt.height !== this.viewHeight || plt.width !== this.viewHeight || plt.zoom !== this.zoom)) {
            await this.refreshPlots(this.api.getPlots());
        } else {
            this._focusPlot();
        }
    }
    protected _focusPlot(plotId?: HttpgdPlotId): void {
        plotId ??= this.activePlot;
        if(!plotId){
            return;
        }
        const msg: FocusPlotMessage = {
            message: 'focusPlot',
            plotId: plotId
        };
        this.postWebviewMessage(msg);
        void this.setContextValues();
    }

    public async nextPlot(last?: boolean): Promise<void> {
        this.activeIndex = last ? this.plots.length - 1 : this.activeIndex + 1;
        await this.focusPlot();
    }
    public async prevPlot(first?: boolean): Promise<void> {
        this.activeIndex = first ? 0 : this.activeIndex - 1;
        await this.focusPlot();
    }

    public resetPlots(): void {
        this.hiddenPlots = [];
        this.zoom = this.zoom0;
        void this.refreshPlots(this.api.getPlots(), true, true);
    }

    public hidePlot(id?: HttpgdPlotId): void {
        id ??= this.activePlot;
        if (!id) { return; }
        const tmpIndex = this.activeIndex;
        this.hiddenPlots.push(id);
        this.plots = this.plots.filter((plt) => !this.hiddenPlots.includes(plt.id));
        if (id === this.activePlot) {
            this.activeIndex = tmpIndex;
            this._focusPlot();
        }
        this._hidePlot(id);
    }
    protected _hidePlot(id: HttpgdPlotId): void {
        const msg: HidePlotMessage = {
            message: 'hidePlot',
            plotId: id
        };
        this.postWebviewMessage(msg);
    }

    public async closePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (id) {
            this.hidePlot(id);
            await this.api.removePlot({ id: id });
        }
    }

    public toggleStyle(force?: boolean): void {
        this.stripStyles = force ?? !this.stripStyles;
        const msg: ToggleStyleMessage = {
            message: 'toggleStyle',
            useOverwrites: this.stripStyles
        };
        this.postWebviewMessage(msg);
    }

    public toggleFullWindow(force?: boolean): void {
        this.fullWindow = force ?? !this.fullWindow;
        const msg: ToggleFullWindowMessage = {
            message: 'toggleFullWindow',
            useFullWindow: this.fullWindow
        };
        this.postWebviewMessage(msg);
    }

    public togglePreviewPlots(force?: PreviewPlotLayout): void {
        if (force) {
            this.previewPlotLayout = force;
        } else if (this.previewPlotLayout === 'multirow') {
            this.previewPlotLayout = 'scroll';
        } else if (this.previewPlotLayout === 'scroll') {
            this.previewPlotLayout = 'hidden';
        } else if (this.previewPlotLayout === 'hidden') {
            this.previewPlotLayout = 'multirow';
        }
        const msg: PreviewPlotLayoutMessage = {
            message: 'togglePreviewPlotLayout',
            style: this.previewPlotLayout
        };
        this.postWebviewMessage(msg);
    }

    public zoomOut(): void {
        if (this.zoom > 0.1) {
            this.zoom -= 0.1;
            void this.resizePlot();
        }
    }

    public zoomIn(): void {
        this.zoom += 0.1;
        void this.resizePlot();
    }

    public async setContextValues(mightBeInBackground: boolean = false): Promise<void> {
        if (this.webviewPanel?.active) {
            this.parent.registerActiveViewer(this);
            await setContext('r.plot.active', true);
            await setContext('r.plot.canGoBack', this.activeIndex > 0);
            await setContext('r.plot.canGoForward', this.activeIndex < this.plots.length - 1);
        } else if (!mightBeInBackground) {
            await setContext('r.plot.active', false);
        }
    }

    public getPanelPath(): string | undefined {
        if (!this.webviewPanel) {
            return undefined;
        }
        const dummyUri = this.webviewPanel.webview.asWebviewUri(vscode.Uri.file(''));
        const m = /^[^.]*/.exec(dummyUri.authority);
        const webviewId = m?.[0] || '';
        return `webview-panel/webview-${webviewId}`;
    }

    protected getIndex(id: HttpgdPlotId): number {
        return this.plots.findIndex((plt: HttpgdPlot<string>) => plt.id === id);
    }

    protected handleResize(height: number, width: number, userTriggered: boolean = false): void {
        this.viewHeight = height;
        this.viewWidth = width;
        if (userTriggered || this.resizeTimeoutLength === 0) {
            if(this.resizeTimeout){
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = undefined;
            void this.resizePlot();
        } else if (!this.resizeTimeout) {
            this.resizeTimeout = setTimeout(() => {
                void this.resizePlot().then(() =>
                    this.resizeTimeout = undefined
                );
            }, this.resizeTimeoutLength);
        }
    }

    protected async resizePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (!id) { return; }
        const plt = await this.getPlotContent(id, this.viewWidth, this.viewHeight, this.zoom);
        this.plotWidth = plt.width;
        this.plotHeight = plt.height;
        this.updatePlot(plt);
    }

    protected async refreshPlotsDelayed(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        if(this.refreshTimeoutLength === 0){
            await this.refreshPlots(plotsIdResponse, redraw, force);
        } else{
            clearTimeout(this.refreshTimeout);
            this.refreshTimeout = setTimeout(() => {
                void this.refreshPlots(plotsIdResponse, redraw, force).then(() =>
                    this.refreshTimeout = undefined
                );
            }, this.refreshTimeoutLength);
        }
    }

    protected async refreshPlots(plotsIdResponse: HttpgdIdResponse[], redraw: boolean = false, force: boolean = false): Promise<void> {
        const nPlots = this.plots.length;
        let plotIds = plotsIdResponse.map((x) => x.id);
        plotIds = plotIds.filter((id) => !this.hiddenPlots.includes(id));
        const newPlotPromises = plotIds.map(async (id) => {
            const plot = this.plots.find((plt) => plt.id === id);
            if (force || !plot || id === this.activePlot) {
                return await this.getPlotContent(id, this.viewWidth, this.viewHeight, this.zoom);
            } else {
                return plot;
            }
        });
        const newPlots = await Promise.all(newPlotPromises);
        const oldPlotIds = this.plots.map(plt => plt.id);
        this.plots = newPlots;
        if (this.plots.length !== nPlots) {
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        if (redraw || !this.webviewPanel) {
            this.refreshHtml();
        } else {
            for (const plt of this.plots) {
                if (oldPlotIds.includes(plt.id)) {
                    this.updatePlot(plt);
                } else {
                    this.addPlot(plt);
                }
            }
            this._focusPlot();
        }
    }

    protected updatePlot(plt: HttpgdPlot<string>): void {
        const msg: UpdatePlotMessage = {
            message: 'updatePlot',
            plotId: plt.id,
            svg: plt.data
        };
        this.postWebviewMessage(msg);
    }

    protected addPlot(plt: HttpgdPlot<string>): void {
        const ejsData = this.makeEjsData();
        ejsData.plot = plt;
        const html = ejs.render(this.smallPlotTemplate, ejsData);
        const msg: AddPlotMessage = {
            message: 'addPlot',
            html: html
        };
        this.postWebviewMessage(msg);
        void this.focusPlot(plt.id);
        void this.setContextValues();
    }

    protected async getPlotContent(id: HttpgdPlotId, width: number, height: number, zoom: number): Promise<HttpgdPlot<string>> {
        const args = {
            id: id,
            height: height,
            width: width,
            zoom: zoom,
            renderer: 'svgp'
        };
        const plotContent = await this.api.getPlot(args);
        const svg = await plotContent?.text() || '';
        const plt: HttpgdPlot<string> = {
            id: id,
            data: svg,
            height: height,
            width: width,
            zoom: zoom,
        };
        this.viewHeight = plt.height;
        this.viewWidth = plt.width;
        return plt;
    }

    protected refreshHtml(): void {
        this.webviewPanel ??= this.makeNewWebview();
        this.webviewPanel.webview.html = '';
        this.webviewPanel.webview.html = this.makeHtml();
        this.toggleFullWindow(this.fullWindow);
        void this.setContextValues(true);
    }

    protected makeHtml(): string {
        const ejsData = this.makeEjsData();
        return ejs.render(this.htmlTemplate, ejsData);
    }

    protected makeEjsData(): EjsData {
        const asLocalPath = (relPath: string) => {
            if (!this.webviewPanel) {
                return relPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, relPath));
            return localUri.fsPath;
        };
        const asWebViewPath = (localPath: string) => {
            if (!this.webviewPanel) {
                return localPath;
            }
            const localUri = vscode.Uri.file(path.join(this.htmlRoot, localPath));
            const webViewUri = this.webviewPanel.webview.asWebviewUri(localUri);
            return webViewUri.toString();
        };
        let overwriteCssPath = '';
        if (this.customOverwriteCssPath) {
            const uri = vscode.Uri.file(this.customOverwriteCssPath);
            overwriteCssPath = this.webviewPanel?.webview.asWebviewUri(uri).toString() || '';
        } else {
            overwriteCssPath = asWebViewPath('styleOverwrites.css');
        }
        return {
            overwriteStyles: this.stripStyles,
            previewPlotLayout: this.previewPlotLayout,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            host: this.host,
            asLocalPath: asLocalPath,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeWebviewCommandUriString,
            overwriteCssPath: overwriteCssPath
        };
    }

    protected makeNewWebview(showOptions?: ShowOptions): vscode.WebviewPanel {
        const webviewPanel = vscode.window.createWebviewPanel(
            'RPlot',
            'R Plot',
            showOptions || this.showOptions,
            this.webviewOptions
        );
        webviewPanel.iconPath = new UriIcon('graph');
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
        if (msg.message === 'log') {
            console.log(msg.body);
        } else if (msg.message === 'resize') {
            void this.handleResize(msg.height, msg.width, msg.userTriggered);
        }
    }

    protected postWebviewMessage(msg: InMessage): void {
        void this.webviewPanel?.webview.postMessage(msg);
    }

    public async exportPlot(id?: HttpgdPlotId, rendererId?: HttpgdRendererId, outFile?: string): Promise<void> {
        id ||= this.activePlot || this.plots[this.plots.length - 1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if (!plot) {
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        if (!rendererId) {
            const renderers = this.api.getRenderers();
            const qpItems  = renderers.map(renderer => ({
                label: renderer.name,
                detail: renderer.descr,
                id: renderer.id
            }));
            const qpPick = await vscode.window.showQuickPick(qpItems, { placeHolder: 'Please choose a file format' });
            rendererId = qpPick?.id;
            if(!rendererId){
                return;
            }
        }
        if (!outFile) {
            const options: vscode.SaveDialogOptions = {};
            const renderer = this.api.getRenderers().find(r => r.id === rendererId);
            const ext = renderer?.ext.replace(/^\./, '');
            if(this.lastExportUri){
                const noExtPath = this.lastExportUri.fsPath.replace(/\.[^.]*$/, '');
                options.defaultUri = vscode.Uri.file(noExtPath + (ext ? `.${ext}` : ''));
            } else {
                const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if(defaultFolder) {options.defaultUri = vscode.Uri.file(path.join(defaultFolder, 'plot' + (ext ? `.${ext}` : '')));}
            }
            if(ext && renderer?.name) {options.filters = { [renderer.name]: [ext], ['All']: ['*'] };}
            const outUri = await vscode.window.showSaveDialog(options);
            if(outUri){
                this.lastExportUri = outUri;
                outFile = outUri.fsPath;
            } else {return;}
        }
        const plt = await this.api.getPlot({ id: this.activePlot, renderer: rendererId }) as { body: NodeJS.ReadableStream };
        const dest = fs.createWriteStream(outFile);
        dest.on('error', (err) => void vscode.window.showErrorMessage(`Export failed: ${err.message}`));
        dest.on('close', () => void vscode.window.showInformationMessage(`Export done: ${outFile || ''}`));
        plt.body.pipe(dest);
    }

    public dispose(): void {
        this.api.disconnect();
    }
}

function findItemOfType(arr: unknown[], type: 'string'): string | undefined;
function findItemOfType(arr: unknown[], type: 'boolean'): boolean | undefined;
function findItemOfType(arr: unknown[], type: 'number'): number | undefined;
function findItemOfType<T = unknown>(arr: unknown[], type: string): T {
    const item = arr.find((elm) => typeof elm === type) as T;
    return item;
}
