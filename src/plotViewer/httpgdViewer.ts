import * as vscode from 'vscode';
import { HttpgdIdResponse, HttpgdPlotId, HttpgdRendererId } from './httpgdClient';
import { HttpgdDevices } from './httpgdDevices';
import { PlotLifecycle } from './plotLifecycle';
import { PlotViewerRegistry } from './plotViewerRegistry';
import { HttpgdPlot, IHttpgdViewer, HttpgdViewerOptions } from './httpgdTypes';
import * as path from 'path';
import * as fs from 'fs';
import ejs from 'ejs';
import { randomUUID } from 'crypto';
import {
    isViewerSessionSource,
    viewerSessionStyle,
    ViewerSessionContext,
    ViewerSessionSource,
} from '../viewerSession';
import {
    getViewerSessionContext,
    onDidChangeSessionConnection,
    resolvePlotSession,
} from '../session';
import { sessionProcessIdentity } from '../sessionIdentity';

import { asViewColumn, config, setContext, UriIcon, makeWebviewCommandUriString } from '../util';
import { extensionContext } from '../extension';
import {
    FocusPlotMessage,
    InMessage,
    OutMessage,
    ToggleStyleMessage,
    UpdatePlotMessage,
    HidePlotMessage,
    AddPlotMessage,
    PreviewPlotLayout,
    PreviewPlotLayoutMessage,
    ToggleFullWindowMessage,
} from './webviewMessages';
import { PlotViewer } from './types';

interface HttpgdConnection {
    url: string;
    source?: ViewerSessionSource;
}

function isHttpgdConnection(value: unknown): value is HttpgdConnection {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const connection = value as Partial<HttpgdConnection>;
    try {
        return (
            typeof connection.url === 'string' &&
            ['http:', 'https:'].includes(new URL(connection.url).protocol) &&
            (connection.source === undefined || isViewerSessionSource(connection.source))
        );
    } catch {
        return false;
    }
}

export class HttpgdManager {
    private viewerStore: PlotViewerRegistry<HttpgdViewer>;
    viewerOptions: HttpgdViewerOptions;
    get viewers(): HttpgdViewer[] {
        return this.viewerStore.values().reverse();
    }

    get recentlyActiveViewers(): readonly HttpgdViewer[] {
        return this.viewerStore.recentlyActive;
    }
    private savedConnections: Promise<HttpgdConnection[]> = Promise.resolve([]);
    private secretKey: string | undefined;
    private disposed = false;
    private connectionWrites: Promise<void> = Promise.resolve();

    getViewers(): HttpgdViewer[] {
        return this.viewers;
    }

    dispose(): void {
        this.disposed = true;
        this.viewerStore.dispose();
    }

    initialize(): void {
        this.secretKey = extensionContext.workspaceState.get<string>('r.plot.httpgdConnectionsKey');
        if (this.secretKey) {
            // URLs contain device tokens, so keep them in SecretStorage.
            this.savedConnections = Promise.resolve(extensionContext.secrets.get(this.secretKey))
                .then((value) => {
                    const connections: unknown = value === undefined ? [] : JSON.parse(value);
                    if (!Array.isArray(connections)) {
                        throw new Error('Invalid saved httpgd connections');
                    }
                    const saved = connections.filter(isHttpgdConnection);
                    if (!this.disposed) {
                        for (const connection of saved) {
                            this.viewerStore.lifecycle.observe(connection.source);
                        }
                    }
                    return saved;
                })
                .catch(() => {
                    // Parse errors can contain token-bearing JSON. Expose only
                    // a fixed message and keep the load rejected so a later save
                    // cannot overwrite unread credentials with an empty list.
                    throw new Error('Could not load saved httpgd plot connections.');
                });
            void this.savedConnections.catch((error: Error) => {
                void vscode.window.showErrorMessage(error.message);
            });
        }
    }

    private hasExited(source?: ViewerSessionSource): boolean {
        return this.viewerStore.lifecycle.hasExited(source);
    }

    public registerViewer(viewer: HttpgdViewer): void {
        this.viewerStore.register(viewer, viewer.connection.source);
    }

    async restoreConnection(source: ViewerSessionSource): Promise<HttpgdViewer | undefined> {
        if (this.disposed || this.hasExited(source)) {
            return undefined;
        }
        const key = sessionProcessIdentity(source);
        const matches = (owner?: ViewerSessionSource) =>
            owner && sessionProcessIdentity(owner) === key;
        const existing = () =>
            [...this.recentlyActiveViewers, ...this.viewers].find(
                (viewer) => !viewer.isDisposed && matches(viewer.connection.source),
            );
        const connections = await this.savedConnections.catch((error: unknown) => {
            if (existing()) {
                return [];
            }
            throw error;
        });
        for (const connection of connections.filter((saved) => matches(saved.source))) {
            await this.showViewer(connection.url, source, true, true);
        }
        return existing();
    }

    saveConnections(): Promise<void> {
        this.connectionWrites = this.connectionWrites
            .then(() => this.writeConnections())
            .catch((error) =>
                console.warn('[Plot Viewer] Could not save httpgd connections', error),
            );
        return this.connectionWrites;
    }

    private async writeConnections(): Promise<void> {
        const connections = new Map(
            (await this.savedConnections)
                .filter((connection) => !this.hasExited(connection.source))
                .map((connection) => [new URL(connection.url).origin, connection]),
        );
        for (const viewer of this.viewers) {
            // Extension shutdown disposes clients before its queued save runs.
            // Only confirmed process exits invalidate restoration credentials.
            for (const connection of viewer.connections) {
                if (!this.hasExited(connection.source)) {
                    connections.set(new URL(connection.url).origin, connection);
                }
            }
        }
        this.savedConnections = Promise.resolve([...connections.values()]);
        if (!connections.size) {
            if (this.secretKey) {
                await extensionContext.secrets.delete(this.secretKey);
                await extensionContext.workspaceState.update(
                    'r.plot.httpgdConnectionsKey',
                    undefined,
                );
                this.secretKey = undefined;
            }
            return;
        }
        this.secretKey ??= `r.plot.httpgd.${randomUUID()}`;
        await extensionContext.secrets.store(
            this.secretKey,
            JSON.stringify([...connections.values()]),
        );
        await extensionContext.workspaceState.update('r.plot.httpgdConnectionsKey', this.secretKey);
    }

    constructor(lifecycle?: PlotLifecycle) {
        this.viewerStore = new PlotViewerRegistry(() => {
            void this.saveConnections();
        }, lifecycle);
        const htmlRoot = extensionContext.asAbsolutePath('dist/webviews/httpgd');
        this.viewerOptions = {
            parent: this,
            htmlRoot: htmlRoot,
            preserveFocus: true,
        };
    }

    public async showViewer(
        urlString: string,
        source?: ViewerSessionSource,
        onlyIfMissing = false,
        restoring = false,
    ): Promise<void> {
        await Promise.resolve();
        if (this.disposed || this.hasExited(source)) {
            return;
        }
        const url = new URL(urlString);
        const token = url.searchParams.get('token') || undefined;
        const shared = this.viewerStore.forSession(source);
        const existing = this.viewers.find((viewer) => viewer.api.connection(url.origin));
        // Check after the async boundary: a new device may have attached while
        // restoration was pending. Never replace its credentials with saved ones.
        if (onlyIfMissing && existing) {
            return;
        }
        if (existing) {
            const viewer = existing;
            const owner = viewer.connection.source;
            const sameSession =
                !source ||
                !owner ||
                sessionProcessIdentity(source) === sessionProcessIdentity(owner);
            if (
                !viewer.isDisposed &&
                sameSession &&
                (!shared || shared === viewer) &&
                (viewer.api.connection(url.origin)?.token === token ||
                    viewer.connections.length > 1)
            ) {
                viewer.bindSession(source);
                this.registerViewer(viewer);
                if (viewer.isDisposed) {
                    return;
                }
                if (viewer.api.connection(url.origin)?.token !== token) {
                    viewer.addDevice(url.origin, token, restoring);
                }
                if (!restoring) {
                    viewer.show();
                }
                if (!onlyIfMissing) {
                    await this.saveConnections();
                }
                return;
            }
            // A restarted process can reuse both its port and token. Retire
            // disposed or differently owned connections as well as stale credentials.
            if (!viewer.isDisposed && viewer.connections.length > 1) {
                viewer.api.removeDevice(url.origin);
            } else {
                this.viewerStore.remove(viewer);
                viewer.dispose();
            }
        }
        if (shared && !shared.isDisposed) {
            shared.addDevice(url.origin, token, restoring);
            if (!onlyIfMissing) {
                await this.saveConnections();
            }
            return;
        }
        const conf = config();
        const colorTheme = conf.get('plot.defaults.colorTheme', 'vscode');
        this.viewerOptions.stripStyles = colorTheme === 'vscode';
        this.viewerOptions.previewPlotLayout = conf.get<PreviewPlotLayout>(
            'plot.defaults.plotPreviewLayout',
            'multirow',
        );
        this.viewerOptions.refreshTimeoutLength = conf.get('plot.timing.refreshInterval', 10);
        this.viewerOptions.resizeTimeoutLength = conf.get('plot.timing.resizeInterval', 100);
        this.viewerOptions.fullWindow = conf.get('plot.defaults.fullWindowMode', false);
        this.viewerOptions.token = token;
        this.viewerOptions.source = source;
        this.viewerOptions.restoring = restoring;
        const viewer = new HttpgdViewer(url.origin, this.viewerOptions);
        this.registerViewer(viewer);
        if (viewer.isDisposed) {
            return;
        }
        if (!onlyIfMissing) {
            await this.saveConnections();
        }
    }

    public registerActiveViewer(viewer: HttpgdViewer): void {
        if (this.disposed || viewer.isDisposed) {
            return;
        }
        this.viewerStore.markActive(viewer);
    }

    public getRecentViewer(): HttpgdViewer | undefined {
        return this.recentlyActiveViewers.find((viewer) => !!viewer.webviewPanel);
    }

    public async openUrl(): Promise<void> {
        const clipText = await vscode.env.clipboard.readText();
        const val0 = clipText.trim().split(/[\n ]/)[0];
        const options: vscode.InputBoxOptions = {
            value: val0,
            prompt: 'Please enter the httpgd url',
        };
        const urlString = await vscode.window.showInputBox(options);
        if (urlString) {
            await this.showViewer(urlString);
        }
    }
}

interface EjsData {
    plotHeight: number;
    sessionHtml: string;
    sessionStyle: string;
    codicons: string;
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
    viewColumn: vscode.ViewColumn;
    preserveFocus?: boolean;
}

interface PlotRefresh {
    plots: HttpgdIdResponse[];
    redraw: boolean;
    force: boolean;
    restoring: boolean;
    changed?: ReadonlySet<string>;
}

export class HttpgdViewer implements IHttpgdViewer, PlotViewer {
    readonly id: string;
    readonly parent: HttpgdManager;
    readonly host: string;
    readonly origin: string;
    readonly token?: string;
    webviewPanel?: vscode.WebviewPanel;
    readonly api: HttpgdDevices;
    private disposed = false;
    private source?: ViewerSessionSource;
    private sessionContext?: ViewerSessionContext;
    private sessionConnectionSubscription?: vscode.Disposable;
    private sessionDisconnected = false;
    private restoring: boolean;
    private pendingRefresh?: PlotRefresh;
    private refreshTask?: Promise<void>;
    private requestGeneration = 0;
    private changedPlots = new Set<string>();
    private stalePlots = new Set<string>();
    private failedPlots = new Set<string>();
    private pendingReveal = false;

    get isDisposed(): boolean {
        return this.disposed;
    }

    get connection(): HttpgdConnection {
        return this.connections[0];
    }

    get connections(): HttpgdConnection[] {
        return this.api.connections.map(({ origin, token }) => {
            const url = new URL(origin);
            if (token) {
                url.searchParams.set('token', token);
            }
            return { url: url.toString(), source: this.source };
        });
    }

    public addDevice(origin: string, token?: string, restoring = false): void {
        void this.api
            .addDevice(origin, token, restoring)
            .catch((err) => this.reportRefreshError(err));
    }
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
        if (!this.activePlot) {
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
        const url = new URL(host.includes('://') ? host : `http://${host}`);
        this.host = url.host;
        this.origin = url.origin;
        // A device's port can be reused while this session still owns other
        // devices. Panel command identity must outlive any individual origin.
        this.id = `httpgd:${randomUUID()}`;
        this.token = options.token;
        this.restoring = options.restoring ?? false;
        this.parent = options.parent;

        this.api = new HttpgdDevices(this.origin, this.token, this.restoring);
        this.api.onPlotsChanged((plots, restoring, changed) => {
            void this.refreshPlotsDelayed(plots, false, false, restoring, changed).catch((err) => {
                this.reportRefreshError(err);
            });
        });
        const conf = config();
        this.customOverwriteCssPath = conf.get('plot.customStyleOverwrites', '');
        const localResourceRoots = this.customOverwriteCssPath
            ? [
                  extensionContext.extensionUri,
                  vscode.Uri.file(path.dirname(this.customOverwriteCssPath)),
              ]
            : undefined;
        this.htmlRoot = options.htmlRoot;
        this.htmlTemplate = fs.readFileSync(path.join(this.htmlRoot, 'index.ejs'), 'utf-8');
        this.smallPlotTemplate = fs.readFileSync(
            path.join(this.htmlRoot, 'smallPlot.ejs'),
            'utf-8',
        );
        this.showOptions = {
            viewColumn:
                options.viewColumn ??
                asViewColumn(
                    conf.get<string>('session.viewers.viewColumn.plot'),
                    vscode.ViewColumn.Two,
                ),
            preserveFocus: !!options.preserveFocus,
        };
        this.webviewOptions = {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: localResourceRoots,
        };
        this.stripStyles = options.stripStyles ?? this.defaultStripStyles;
        this.previewPlotLayout = options.previewPlotLayout ?? this.defaultPreviewPlotLayout;
        this.fullWindow = options.fullWindow ?? this.defaultFullWindow;
        this.resizeTimeoutLength = options.resizeTimeoutLength ?? this.resizeTimeoutLength;
        this.refreshTimeoutLength = options.refreshTimeoutLength ?? this.refreshTimeoutLength;
        this.bindSession(options.source);
        this.connect();
    }

    private get canRefresh(): boolean {
        return !this.disposed && !this.sessionDisconnected && !this.sessionContext?.hasExited;
    }

    private connect(): void {
        if (!this.canRefresh) {
            return;
        }
        void this.api.connect().catch((err) => {
            if (this.canRefresh && !(err instanceof Error && err.name === 'AbortError')) {
                void vscode.window.showErrorMessage(`httpgd connection failed: ${String(err)}`);
            }
        });
    }

    public handleCommand(command: string, ...args: unknown[]): void | Promise<void> {
        const stringArg = findItemOfType(args, 'string');
        const boolArg = findItemOfType(args, 'boolean');

        switch (command) {
            case 'showIndex':
                return this.focusPlot(stringArg);
            case 'nextPlot':
                return this.nextPlot(boolArg);
            case 'prevPlot':
                return this.prevPlot(boolArg);
            case 'lastPlot':
                return this.nextPlot(true);
            case 'firstPlot':
                return this.prevPlot(true);
            case 'resetPlots':
                return this.resetPlots();
            case 'toggleStyle':
                return this.toggleStyle(boolArg);
            case 'togglePreviewPlots':
                return this.togglePreviewPlots(stringArg as PreviewPlotLayout);
            case 'closePlot':
                return this.closePlot(stringArg);
            case 'hidePlot':
                return this.hidePlot(stringArg);
            case 'exportPlot':
                return this.exportPlot(stringArg);
            case 'zoomIn':
                return this.zoomIn();
            case 'zoomOut':
                return this.zoomOut();
            case 'openExternal':
                return this.openExternal();
            case 'toggleFullWindow':
                return this.toggleFullWindow();
        }
    }

    public bindSession(source?: ViewerSessionSource): void {
        if (!source || this.source) {
            return;
        }
        this.source = {
            sessionId: source.sessionId,
            host: source.host,
            pid: source.pid,
            rVer: source.rVer,
            processExited: source.processExited,
        };
        source = this.source;
        this.sessionContext = getViewerSessionContext(source.sessionId, source);
        this.sessionConnectionSubscription = onDidChangeSessionConnection((event) => {
            if (event.session.sessionId !== source.sessionId || this.disposed) {
                return;
            }
            const connected = Boolean(resolvePlotSession(source));
            if (!connected && !this.sessionDisconnected) {
                this.sessionDisconnected = true;
                this.stopRequests();
            } else if (connected && this.sessionDisconnected) {
                this.sessionDisconnected = false;
                // The first snapshot after reconnect is not a new plot.
                this.restoring = true;
                this.connect();
            }
        });
        if (this.webviewPanel) {
            this.sessionContext?.attach(this.webviewPanel);
            this.refreshHtml();
        }
    }

    public show(preserveFocus?: boolean): void {
        if (this.disposed) {
            return;
        }
        this.restoring = false;
        preserveFocus ??= this.showOptions.preserveFocus;
        if (!this.webviewPanel) {
            const showOptions = {
                ...this.showOptions,
                preserveFocus: preserveFocus,
            };
            this.webviewPanel = this.makeNewWebview(showOptions);
            this.refreshHtml();
        } else {
            this.webviewPanel.reveal(undefined, preserveFocus);
        }
        this.parent.registerActiveViewer(this);
    }

    public openExternal(): void {
        const connection = this.api.plotConnection(this.activePlot);
        const url = new URL('/live', connection.origin);
        if (connection.token) {
            url.searchParams.set('token', connection.token);
        }
        // Uri.parse decodes query escapes, including delimiters within a token.
        // Preserve URLSearchParams' encoding when handing the URL to VS Code.
        const uri = vscode.Uri.from({
            scheme: url.protocol.slice(0, -1),
            authority: url.host,
            path: url.pathname,
            query: url.search.slice(1),
        });
        void vscode.env.openExternal(uri);
    }

    public async focusPlot(id?: HttpgdPlotId): Promise<void> {
        this.activePlot = id || this.activePlot;
        const plt = this.plots[this.activeIndex];
        if (
            plt &&
            this.canRefresh &&
            (plt.height !== this.viewHeight ||
                plt.width !== this.viewWidth ||
                plt.zoom !== this.zoom)
        ) {
            await this.refreshPlots(this.api.getPlots());
        } else {
            this._focusPlot();
        }
    }
    protected _focusPlot(plotId?: HttpgdPlotId): void {
        plotId ??= this.activePlot;
        if (!plotId) {
            return;
        }
        const msg: FocusPlotMessage = {
            message: 'focusPlot',
            plotId: plotId,
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
        void this.refreshPlots(this.api.getPlots(), true, true).catch((err) =>
            this.reportRefreshError(err),
        );
    }

    public hidePlot(id?: HttpgdPlotId): void {
        id ??= this.activePlot;
        if (!id) {
            return;
        }
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
            plotId: id,
        };
        this.postWebviewMessage(msg);
    }

    public async closePlot(id?: HttpgdPlotId): Promise<void> {
        id ??= this.activePlot;
        if (id) {
            this.hidePlot(id);
            if (this.canRefresh) {
                await this.api.removePlot({ id: id });
            }
        }
    }

    public toggleStyle(force?: boolean): void {
        this.stripStyles = force ?? !this.stripStyles;
        const msg: ToggleStyleMessage = {
            message: 'toggleStyle',
            useOverwrites: this.stripStyles,
        };
        this.postWebviewMessage(msg);
    }

    public toggleFullWindow(force?: boolean): void {
        this.fullWindow = force ?? !this.fullWindow;
        const msg: ToggleFullWindowMessage = {
            message: 'toggleFullWindow',
            useFullWindow: this.fullWindow,
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
            style: this.previewPlotLayout,
        };
        this.postWebviewMessage(msg);
    }

    public zoomOut(): void {
        if (this.zoom > 0.1) {
            this.zoom -= 0.1;
            void this.resizePlot().catch((err) => this.reportRefreshError(err));
        }
    }

    public zoomIn(): void {
        this.zoom += 0.1;
        void this.resizePlot().catch((err) => this.reportRefreshError(err));
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

    public get isActive(): boolean {
        return this.webviewPanel?.active ?? false;
    }

    protected getIndex(id: HttpgdPlotId): number {
        return this.plots.findIndex((plt: HttpgdPlot<string>) => plt.id === id);
    }

    protected handleResize(height: number, width: number, userTriggered: boolean = false): void {
        // Keep viewport changes while disconnected for the reconnect snapshot.
        this.viewHeight = height;
        this.viewWidth = width;
        if (!this.canRefresh) {
            return;
        }
        if (userTriggered || this.resizeTimeoutLength === 0) {
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = undefined;
            void this.resizePlot().catch((err) => this.reportRefreshError(err));
        } else if (!this.resizeTimeout) {
            this.resizeTimeout = setTimeout(() => {
                void this.resizePlot()
                    .catch((err) => this.reportRefreshError(err))
                    .then(() => (this.resizeTimeout = undefined));
            }, this.resizeTimeoutLength);
        }
    }

    private reportRefreshError(err: unknown): void {
        if (this.canRefresh && !(err instanceof Error && err.name === 'AbortError')) {
            void vscode.window.showErrorMessage(`Plot refresh failed: ${String(err)}`);
        }
    }

    protected async resizePlot(id?: HttpgdPlotId): Promise<void> {
        if (!this.canRefresh) {
            return;
        }
        id ??= this.activePlot;
        if (!id) {
            return;
        }
        const generation = this.requestGeneration;
        const plt = await this.getPlotContent(id, this.viewWidth, this.viewHeight, this.zoom);
        if (!this.canRefresh || generation !== this.requestGeneration) {
            return;
        }
        const index = this.getIndex(id);
        if (index >= 0) {
            this.plots[index] = plt;
        }
        this.updatePlot(plt);
    }

    protected async refreshPlotsDelayed(
        plotsIdResponse: HttpgdIdResponse[],
        redraw: boolean = false,
        force: boolean = false,
        restoring = this.restoring,
        changed?: ReadonlySet<string>,
    ): Promise<void> {
        if (!this.canRefresh) {
            return;
        }
        if (this.refreshTimeoutLength === 0) {
            await this.refreshPlots(plotsIdResponse, redraw, force, restoring, changed);
        } else {
            for (const id of changed ?? []) {
                this.changedPlots.add(id);
            }
            this.pendingReveal ||= !restoring;
            clearTimeout(this.refreshTimeout);
            this.refreshTimeout = setTimeout(() => {
                const changedPlots = changed ? this.changedPlots : undefined;
                const restoring = !this.pendingReveal;
                this.changedPlots = new Set();
                this.pendingReveal = false;
                this.refreshTimeout = undefined;
                void this.refreshPlots(
                    plotsIdResponse,
                    redraw,
                    force,
                    restoring,
                    changedPlots,
                ).catch((err) => {
                    this.reportRefreshError(err);
                });
            }, this.refreshTimeoutLength);
        }
    }

    protected refreshPlots(
        plotsIdResponse: HttpgdIdResponse[],
        redraw: boolean = false,
        force: boolean = false,
        restoring = this.restoring,
        changed?: ReadonlySet<string>,
    ): Promise<void> {
        const pending = this.pendingRefresh;
        this.pendingRefresh = {
            plots: plotsIdResponse,
            redraw: redraw || !!pending?.redraw,
            force: force || !!pending?.force,
            restoring: restoring && (pending?.restoring ?? true),
            changed: pending
                ? changed && pending.changed
                    ? new Set([...pending.changed, ...changed])
                    : undefined
                : changed,
        };
        this.refreshTask ??= Promise.resolve()
            .then(async () => {
                while (this.pendingRefresh) {
                    const request = this.pendingRefresh;
                    this.pendingRefresh = undefined;
                    try {
                        await this.applyPlotRefresh(request);
                    } catch (error) {
                        // Keep newer device notifications even when an older render fails.
                        this.reportRefreshError(error);
                    }
                }
            })
            .then(() => {
                this.refreshTask = undefined;
                const pending = this.pendingRefresh;
                if (pending) {
                    return this.refreshPlots(
                        pending.plots,
                        pending.redraw,
                        pending.force,
                        pending.restoring,
                        pending.changed,
                    );
                }
            });
        return this.refreshTask;
    }

    private async applyPlotRefresh({
        plots: plotsIdResponse,
        redraw,
        force,
        restoring,
        changed,
    }: PlotRefresh): Promise<void> {
        if (!this.canRefresh) {
            return;
        }
        const generation = this.requestGeneration;
        const hidden = new Set(this.hiddenPlots);
        const existing = new Map(this.plots.map((plot) => [plot.id, plot]));
        const plotIds = plotsIdResponse.map((x) => x.id).filter((id) => !hidden.has(id));
        const incoming = new Set(plotIds);
        for (const tracked of [this.stalePlots, this.failedPlots]) {
            for (const id of tracked) {
                if (!incoming.has(id)) {
                    tracked.delete(id);
                }
            }
        }
        for (const id of changed ?? []) {
            if (incoming.has(id)) {
                this.stalePlots.add(id);
                this.failedPlots.delete(id);
            }
        }
        const refreshIds = plotIds.filter((id) => {
            // A closed device must not be retried on every other device's update.
            // Retry on content changes, reactivation, reconnect or explicit refresh.
            if (this.failedPlots.has(id) && !this.api.isActive(id) && !force) {
                return false;
            }
            const plot = existing.get(id);
            return (
                force || !plot || this.stalePlots.has(id) || (!changed && id === this.activePlot)
            );
        });
        const results = await Promise.allSettled(
            refreshIds.map((id) =>
                this.getPlotContent(
                    id,
                    this.viewWidth,
                    this.viewHeight,
                    this.zoom,
                    existing.get(id) ?? null,
                ),
            ),
        );
        if (!this.canRefresh || generation !== this.requestGeneration) {
            return;
        }
        const refreshed = new Map<string, HttpgdPlot<string>>();
        results.forEach((result, index) => {
            const id = refreshIds[index];
            if (result.status === 'fulfilled') {
                refreshed.set(id, result.value);
                this.stalePlots.delete(id);
                this.failedPlots.delete(id);
            } else {
                if (!this.failedPlots.has(id)) {
                    this.reportRefreshError(result.reason);
                }
                this.failedPlots.add(id);
            }
        });
        // Preserve cached failures, omit unavailable uncached plots, and commit
        // successful renders from other devices without losing their updates.
        const newPlots = plotIds
            .map((id) => refreshed.get(id) ?? existing.get(id))
            .filter((plot): plot is HttpgdPlot<string> => plot !== undefined);
        const oldPlotIds = new Set(this.plots.map((plt) => plt.id));
        const newPlotIds = new Set(newPlots.map((plot) => plot.id));
        this.plots = newPlots;
        this.restoring = false;
        const added = this.plots.filter((plot) => !oldPlotIds.has(plot.id));
        if (
            (!restoring && added.length) ||
            !this.plots.some((plot) => plot.id === this.activePlot)
        ) {
            this.activePlot = this.plots[this.plots.length - 1]?.id;
        }
        // Initial connection replays existing plots. Only a new plot or an
        // explicit Show Viewer should reopen a closed panel.
        if (
            !this.webviewPanel &&
            !redraw &&
            (restoring || !this.plots.some((plot) => !oldPlotIds.has(plot.id)))
        ) {
            return;
        }
        if (redraw || !this.webviewPanel) {
            this.refreshHtml();
        } else {
            for (const id of oldPlotIds) {
                if (!newPlotIds.has(id)) {
                    this._hidePlot(id);
                }
            }
            for (const plt of this.plots) {
                if (oldPlotIds.has(plt.id)) {
                    if (existing.get(plt.id) !== plt) {
                        this.updatePlot(plt);
                    }
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
            svg: plt.data,
        };
        this.postWebviewMessage(msg);
    }

    protected addPlot(plt: HttpgdPlot<string>): void {
        const ejsData = this.makeEjsData();
        ejsData.plot = plt;
        const html = ejs.render(this.smallPlotTemplate, ejsData);
        const msg: AddPlotMessage = {
            message: 'addPlot',
            html: html,
        };
        this.postWebviewMessage(msg);
    }

    protected async getPlotContent(
        id: HttpgdPlotId,
        width: number,
        height: number,
        zoom: number,
        cached: HttpgdPlot<string> | null = this.plots.find((plot) => plot.id === id) ?? null,
    ): Promise<HttpgdPlot<string>> {
        if (cached && !this.api.isActive(id) && !this.stalePlots.has(id)) {
            // Unchanged inactive plots only need scaling. Changed content must
            // still be fetched; HttpgdDevices omits resize arguments for it.
            return { ...cached, width, height, zoom };
        }
        const args = {
            id: id,
            height: height,
            width: width,
            zoom: zoom,
            renderer: 'svgp',
        };
        const svg = await this.api.getPlotText(args);
        const plt: HttpgdPlot<string> = {
            id: id,
            data: svg,
            height: height,
            width: width,
            zoom: zoom,
        };
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
            plotHeight: this.viewHeight,
            sessionHtml: this.sessionContext?.getHtml() ?? '',
            sessionStyle: viewerSessionStyle,
            codicons:
                this.webviewPanel?.webview
                    .asWebviewUri(
                        vscode.Uri.joinPath(
                            extensionContext.extensionUri,
                            'dist',
                            'resources',
                            'codicon.css',
                        ),
                    )
                    .toString() ?? '',
            overwriteStyles: this.stripStyles,
            previewPlotLayout: this.previewPlotLayout,
            plots: this.plots,
            largePlot: this.plots[this.activeIndex],
            activePlot: this.activePlot,
            host: this.id,
            asLocalPath: asLocalPath,
            asWebViewPath: asWebViewPath,
            makeCommandUri: makeWebviewCommandUriString,
            overwriteCssPath: overwriteCssPath,
        };
    }

    protected makeNewWebview(showOptions?: ShowOptions): vscode.WebviewPanel {
        this.parent.registerActiveViewer(this);
        const webviewPanel = vscode.window.createWebviewPanel(
            'RPlot',
            'R Plot',
            showOptions || this.showOptions,
            this.webviewOptions,
        );
        webviewPanel.iconPath = new UriIcon('graph');
        webviewPanel.onDidDispose(() => {
            this.webviewPanel = undefined;
        });
        webviewPanel.onDidChangeViewState(() => {
            void this.setContextValues();
        });
        webviewPanel.webview.onDidReceiveMessage((e: OutMessage) => {
            this.handleWebviewMessage(e);
        });
        this.sessionContext?.attach(webviewPanel);
        return webviewPanel;
    }

    protected handleWebviewMessage(msg: OutMessage): void {
        if (msg.message === 'log') {
            console.log(msg.body);
        } else if (msg.message === 'resize') {
            this.handleResize(msg.height, msg.width, msg.userTriggered);
        }
    }

    protected postWebviewMessage(msg: InMessage): void {
        void this.webviewPanel?.webview.postMessage(msg);
    }

    public async exportPlot(
        id?: HttpgdPlotId,
        rendererId?: HttpgdRendererId,
        outFile?: string,
    ): Promise<void> {
        id ||= this.activePlot || this.plots[this.plots.length - 1]?.id;
        const plot = this.plots.find((plt) => plt.id === id);
        if (!plot) {
            void vscode.window.showWarningMessage('No plot available for export.');
            return;
        }
        if (!rendererId) {
            const renderers = this.api.getRenderers(id);
            const qpItems = renderers.map((renderer) => ({
                label: renderer.name,
                detail: renderer.descr,
                id: renderer.id,
            }));
            const qpPick = await vscode.window.showQuickPick(qpItems, {
                placeHolder: 'Please choose a file format',
            });
            rendererId = qpPick?.id;
            if (!rendererId) {
                return;
            }
        }
        if (!outFile) {
            const options: vscode.SaveDialogOptions = {};
            const renderer = this.api.getRenderers(id).find((r) => r.id === rendererId);
            const ext = renderer?.ext.replace(/^\./, '');
            if (this.lastExportUri) {
                const noExtPath = this.lastExportUri.fsPath.replace(/\.[^.]*$/, '');
                options.defaultUri = vscode.Uri.file(noExtPath + (ext ? `.${ext}` : ''));
            } else {
                const defaultFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (defaultFolder) {
                    options.defaultUri = vscode.Uri.file(
                        path.join(defaultFolder, 'plot' + (ext ? `.${ext}` : '')),
                    );
                }
            }
            if (ext && renderer?.name) {
                options.filters = { [renderer.name]: [ext], ['All']: ['*'] };
            }
            const outUri = await vscode.window.showSaveDialog(options);
            if (outUri) {
                this.lastExportUri = outUri;
                outFile = outUri.fsPath;
            } else {
                return;
            }
        }
        try {
            const bytes = await this.api.getPlotBytes({ id, renderer: rendererId });
            await fs.promises.writeFile(outFile, bytes);
            void vscode.window.showInformationMessage(`Export done: ${outFile}`);
        } catch (err) {
            if (!this.disposed) {
                void vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
            }
        }
    }

    public dispose(keepPanel = false): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.sessionConnectionSubscription?.dispose();
        this.stopRequests();
        if (!keepPanel) {
            this.webviewPanel?.dispose();
        }
        this.webviewPanel = undefined;
        this.releasePlots();
    }

    private releasePlots(): void {
        this.plots = [];
        this.hiddenPlots = [];
        this.activePlot = undefined;
        this.stalePlots.clear();
        this.failedPlots.clear();
        this.api.releasePlots();
    }

    private stopRequests(): void {
        this.requestGeneration++;
        this.pendingRefresh = undefined;
        this.changedPlots.clear();
        this.failedPlots.clear();
        this.pendingReveal = false;
        clearTimeout(this.resizeTimeout);
        clearTimeout(this.refreshTimeout);
        this.resizeTimeout = undefined;
        this.refreshTimeout = undefined;
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
