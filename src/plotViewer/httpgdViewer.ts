import * as vscode from 'vscode';
import { HttpgdIdResponse, HttpgdPlotId, HttpgdRendererId } from './httpgdClient';
import { HttpgdDevices, HttpgdPlotReference } from './httpgdDevices';
import { PlotLifecycle } from './plotLifecycle';
import { PlotViewerRegistry } from './plotViewerRegistry';
import { PlotHistoryPersistence } from './plotHistoryPersistence';
import {
    HttpgdPlot,
    IHttpgdViewer,
    HttpgdViewerOptions,
    HttpgdHistoryState,
    HttpgdSelectionState,
} from './httpgdTypes';
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
    plotOrder?: HttpgdPlotReference[];
    historyId?: string;
}

function isPlotReference(value: unknown): value is HttpgdPlotReference {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as HttpgdPlotReference).origin === 'string' &&
        typeof (value as HttpgdPlotReference).id === 'string'
    );
}

function isHttpgdHistoryState(value: unknown): value is HttpgdHistoryState {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const state = value as Partial<HttpgdHistoryState>;
    return (
        (state.source === undefined || isViewerSessionSource(state.source)) &&
        Array.isArray(state.plots) &&
        state.plots.every(
            (plot) =>
                plot &&
                typeof plot.id === 'string' &&
                typeof plot.data === 'string' &&
                Number.isFinite(plot.width) &&
                plot.width > 0 &&
                Number.isFinite(plot.height) &&
                plot.height > 0 &&
                Number.isFinite(plot.zoom) &&
                plot.zoom > 0 &&
                isPlotReference(plot.reference),
        )
    );
}

function isHttpgdSelectionState(value: unknown): value is HttpgdSelectionState {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const state = value as Partial<HttpgdSelectionState>;
    return (
        (state.activePlot === undefined || typeof state.activePlot === 'string') &&
        Array.isArray(state.hiddenPlots) &&
        state.hiddenPlots.every((id) => typeof id === 'string')
    );
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
    private saveTimer?: NodeJS.Timeout;
    private histories = new Map<string, HttpgdHistoryState>();
    private selections = new Map<string, HttpgdSelectionState>();
    private historyDirty = true;
    private selectionDirty = true;

    getViewers(): HttpgdViewer[] {
        return this.viewers;
    }

    dispose(): void {
        this.disposed = true;
        clearTimeout(this.saveTimer);
        this.viewerStore.dispose();
    }

    async initialize(): Promise<void> {
        const histories = await this.historyPersistence.readHttpgd(
            extensionContext.workspaceState.get<unknown>('r.plot.httpgdHistory'),
        );
        const selections = extensionContext.workspaceState.get<unknown>('r.plot.httpgdSelection');
        if (histories && typeof histories === 'object') {
            for (const [id, value] of Object.entries(histories)) {
                if (isHttpgdHistoryState(value)) {
                    this.histories.set(id, value);
                }
            }
        }
        if (selections && typeof selections === 'object') {
            for (const [id, value] of Object.entries(selections)) {
                if (isHttpgdSelectionState(value)) {
                    this.selections.set(id, value);
                }
            }
        }
        this.secretKey = extensionContext.workspaceState.get<string>('r.plot.httpgdConnectionsKey');
        if (this.secretKey) {
            // URLs contain device tokens, so keep them in SecretStorage.
            this.savedConnections = Promise.resolve(extensionContext.secrets.get(this.secretKey))
                .then((value) => {
                    const connections: unknown = value === undefined ? [] : JSON.parse(value);
                    if (!Array.isArray(connections)) {
                        throw new Error('Invalid saved httpgd connections');
                    }
                    const saved = connections.filter(isHttpgdConnection).map((connection) => ({
                        ...connection,
                        plotOrder: Array.isArray(connection.plotOrder)
                            ? connection.plotOrder.filter(isPlotReference)
                            : undefined,
                    }));
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
        // Move legacy SVG payloads out of workspaceState without waiting for
        // the user to reopen a viewer. Connection loading remains asynchronous.
        if (this.histories.size) {
            this.scheduleSaveConnections();
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
        clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
        // Capture before shutdown releases the SVGs. Queued writes still filter
        // confirmed process exits, including exits during a SecretStorage write.
        for (const viewer of this.viewers) {
            if (!viewer.isDisposed) {
                this.histories.set(viewer.historyId, viewer.snapshotHistory());
                this.selections.set(viewer.historyId, viewer.snapshotSelection());
            }
        }
        this.connectionWrites = this.connectionWrites
            .then(() => this.writeConnections())
            .catch((error) => {
                this.historyDirty = this.selectionDirty = true;
                console.warn('[Plot Viewer] Could not save httpgd connections', error);
            });
        return this.connectionWrites;
    }

    scheduleSaveConnections(contentChanged = true): void {
        this.historyDirty ||= contentChanged;
        this.selectionDirty = true;
        if (!this.disposed && !this.saveTimer) {
            this.saveTimer = setTimeout(() => void this.saveConnections(), 250);
        }
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
        const retained = new Set(
            [...connections.values()].map((connection) => connection.historyId),
        );
        for (const id of this.histories.keys()) {
            if (!retained.has(id)) {
                this.histories.delete(id);
                this.selections.delete(id);
                this.historyDirty = this.selectionDirty = true;
            }
        }
        if (this.historyDirty) {
            this.historyDirty = false;
            await this.historyPersistence.writeHttpgd(new Map(this.histories));
        }
        if (this.selectionDirty) {
            this.selectionDirty = false;
            await extensionContext.workspaceState.update(
                'r.plot.httpgdSelection',
                Object.fromEntries(this.selections),
            );
        }
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

    constructor(
        lifecycle?: PlotLifecycle,
        private readonly historyPersistence = new PlotHistoryPersistence(extensionContext),
    ) {
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
        const saved = await this.savedConnections.catch(() => []);
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
        const matching = saved.filter((connection) =>
            source
                ? connection.source &&
                  sessionProcessIdentity(connection.source) === sessionProcessIdentity(source)
                : !connection.source && new URL(connection.url).origin === url.origin,
        );
        const sameDevice = matching.some((connection) => {
            const previous = new URL(connection.url);
            return (
                previous.origin === url.origin &&
                (previous.searchParams.get('token') || undefined) === token
            );
        });
        this.viewerOptions.plotOrder = matching
            .flatMap((connection) => connection.plotOrder ?? [])
            .filter((plot) => plot.origin !== url.origin || sameDevice);
        const historyId = matching.find(
            (connection) => typeof connection.historyId === 'string',
        )?.historyId;
        this.viewerOptions.historyId = historyId;
        const history = historyId ? this.histories.get(historyId) : undefined;
        this.viewerOptions.history = history && {
            ...history,
            plots: history.plots.filter(
                (plot) => plot.reference.origin !== url.origin || sameDevice,
            ),
        };
        this.viewerOptions.selection = historyId ? this.selections.get(historyId) : undefined;
        this.viewerOptions.connections = matching
            .map((connection) => new URL(connection.url))
            .filter((connection) => connection.origin !== url.origin)
            .filter(
                (connection) =>
                    !this.viewers.some((viewer) => viewer.api.connection(connection.origin)),
            )
            .map((connection) => ({
                origin: connection.origin,
                token: connection.searchParams.get('token') || undefined,
            }));
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
    plots: readonly HttpgdPlot<string>[];
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
    readonly historyId: string;
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
    private retainedPlotOrder?: HttpgdPlotReference[];
    private retainedPlots: HttpgdPlot<string>[] = [];
    private visiblePlots: HttpgdPlot<string>[] = [];

    get isDisposed(): boolean {
        return this.disposed;
    }

    get connection(): HttpgdConnection {
        return this.connections[0];
    }

    get connections(): HttpgdConnection[] {
        return this.api.connections.map(({ origin, token }, index) => {
            const url = new URL(origin);
            if (token) {
                url.searchParams.set('token', token);
            }
            return {
                url: url.toString(),
                source: this.source,
                historyId: this.historyId,
                ...(index === 0 ? { plotOrder: this.retainedPlotOrder ?? this.api.plotOrder } : {}),
            };
        });
    }

    public addDevice(origin: string, token?: string, restoring = false): void {
        void this.api
            .addDevice(origin, token, restoring)
            .catch((err) => this.reportRefreshError(err));
    }

    snapshotHistory(): HttpgdHistoryState {
        return {
            source: this.source && { ...this.source },
            plots: this.retainedPlots.flatMap((plot) => {
                const reference = this.api.plotReference(plot.id);
                return reference ? [{ ...plot, reference }] : [];
            }),
        };
    }

    snapshotSelection(): HttpgdSelectionState {
        return { activePlot: this.activePlot, hiddenPlots: [...this.hiddenPlots] };
    }
    get plots(): readonly HttpgdPlot<string>[] {
        return this.visiblePlots;
    }

    protected setPlots(plots: HttpgdPlot<string>[]): void {
        this.retainedPlots = plots;
        const hidden = new Set(this.hiddenPlots);
        this.visiblePlots = plots.filter((plot) => !hidden.has(plot.id));
    }
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
        this.historyId = options.historyId ?? randomUUID();
        this.token = options.token;
        this.restoring = options.restoring ?? false;
        this.parent = options.parent;

        this.api = new HttpgdDevices(this.origin, this.token, this.restoring, options.plotOrder);
        for (const connection of options.connections ?? []) {
            void this.api.addDevice(connection.origin, connection.token, true);
        }
        if (options.history) {
            this.api.restorePlots(options.history.plots);
            const restored = new Set(this.api.getPlots().map(({ id }) => id));
            this.hiddenPlots = (options.selection?.hiddenPlots ?? []).filter((id) =>
                restored.has(id),
            );
            const saved = new Map(options.history.plots.map((plot) => [plot.id, plot]));
            this.setPlots(
                this.api.getPlots().flatMap(({ id }) => {
                    const plot = saved.get(id);
                    return plot ? [{ ...plot }] : [];
                }),
            );
            this.activePlot =
                this.plots.find((plot) => plot.id === options.selection?.activePlot)?.id ??
                this.plots.at(-1)?.id;
        }
        this.api.onPlotsChanged((plots, restoring, changed, orderChanged) => {
            if (orderChanged) {
                this.parent.scheduleSaveConnections();
            }
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
            const retainedUnavailable =
                this.retainedPlots.length > 0 &&
                ['ECONNREFUSED', 'ECONNRESET'].includes((err as NodeJS.ErrnoException)?.code ?? '');
            if (
                this.canRefresh &&
                !retainedUnavailable &&
                !(err instanceof Error && err.name === 'AbortError')
            ) {
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
                plt.zoom !== this.zoom ||
                (plt.resizeDeferred && this.api.isActive(plt.id) && this.api.isAvailable(plt.id)))
        ) {
            await this.refreshPlots(this.api.getPlots());
        } else {
            this._focusPlot();
        }
        this.parent.scheduleSaveConnections(false);
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
        this.setPlots(this.retainedPlots);
        if (id === this.activePlot) {
            this.activeIndex = tmpIndex;
            this._focusPlot();
        }
        this._hidePlot(id);
        this.parent.scheduleSaveConnections(false);
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
                if (!this.api.isAvailable(id)) {
                    this.api.forgetPlot(id);
                } else {
                    try {
                        await this.api.removePlot({ id });
                    } catch (error) {
                        if (this.api.isAvailable(id)) {
                            throw error;
                        }
                        this.api.forgetPlot(id);
                    }
                }
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
        this.setPlots(this.retainedPlots.map((plot) => (plot.id === id ? plt : plot)));
        this.parent.scheduleSaveConnections();
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
        const existing = new Map(this.retainedPlots.map((plot) => [plot.id, plot]));
        const incoming = new Set(plotsIdResponse.map(({ id }) => id));
        this.hiddenPlots = this.hiddenPlots.filter((id) => incoming.has(id));
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
        const refreshIds = [...incoming].filter((id) => {
            // Hiding a received plot only changes visibility. Keep its drawing
            // current while R can still render it, even if the device later closes.
            if (hidden.has(id) && !existing.has(id)) {
                return false;
            }
            // A closed device must not be retried on every other device's update.
            // Retry on content changes, reactivation, reconnect or explicit refresh.
            if (this.failedPlots.has(id) && !this.api.isActive(id) && !force) {
                return false;
            }
            const plot = existing.get(id);
            return (
                force ||
                !plot ||
                this.stalePlots.has(id) ||
                (id === this.activePlot &&
                    (!changed ||
                        (plot.resizeDeferred && this.api.isActive(id) && this.api.isAvailable(id))))
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
        const oldPlotIds = new Set(this.plots.map((plt) => plt.id));
        this.setPlots(
            [...incoming]
                .map((id) => refreshed.get(id) ?? existing.get(id))
                .filter((plot): plot is HttpgdPlot<string> => plot !== undefined),
        );
        const newPlotIds = new Set(this.plots.map((plot) => plot.id));
        this.restoring = false;
        const added = this.plots.filter((plot) => !oldPlotIds.has(plot.id));
        this.parent.scheduleSaveConnections();
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
        const appendedOrder = [...oldPlotIds]
            .filter((id) => newPlotIds.has(id))
            .concat(added.map((plot) => plot.id));
        const reordered = appendedOrder.some((id, index) => this.plots[index]?.id !== id);
        if (redraw || !this.webviewPanel || reordered) {
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
        const active = this.api.isActive(id);
        const scaled = cached && {
            ...cached,
            width,
            height,
            zoom,
            resizeDeferred:
                cached.resizeDeferred ||
                cached.width !== width ||
                cached.height !== height ||
                cached.zoom !== zoom,
        };
        if (scaled && (!this.api.isAvailable(id) || (!active && !this.stalePlots.has(id)))) {
            // Unchanged inactive plots only need scaling. Changed content must
            // still be fetched; HttpgdDevices omits resize arguments for it.
            return scaled;
        }
        const args = {
            id: id,
            height: height,
            width: width,
            zoom: zoom,
            renderer: 'svgp',
        };
        let svg: string;
        try {
            svg = await this.api.getPlotText(args);
        } catch (error) {
            if (
                scaled &&
                ['ECONNREFUSED', 'ECONNRESET'].includes(
                    (error as NodeJS.ErrnoException)?.code ?? '',
                )
            ) {
                return scaled;
            }
            throw error;
        }
        const plt: HttpgdPlot<string> = {
            id: id,
            data: svg,
            height: height,
            width: width,
            zoom: zoom,
            // Inactive-device requests omit geometry even when fetching changed content.
            resizeDeferred: !active,
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
        const renderers = this.api.isAvailable(plot.id) ? [...this.api.getRenderers(id)] : [];
        if (!renderers.some((renderer) => renderer.id === 'svgp')) {
            renderers.push({ id: 'svgp', name: 'SVG', ext: 'svg', descr: 'Retained plot' });
        }
        if (!rendererId) {
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
            const renderer = renderers.find((r) => r.id === rendererId);
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
            const svg = rendererId === 'svgp' || rendererId === 'svg';
            let bytes: Buffer;
            if (svg && !this.api.isAvailable(plot.id)) {
                bytes = Buffer.from(plot.data, 'utf8');
            } else {
                try {
                    bytes = await this.api.getPlotBytes({ id, renderer: rendererId });
                } catch (error) {
                    if (
                        !svg ||
                        !['ECONNREFUSED', 'ECONNRESET'].includes(
                            (error as NodeJS.ErrnoException)?.code ?? '',
                        )
                    ) {
                        throw error;
                    }
                    bytes = Buffer.from(plot.data, 'utf8');
                }
            }
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
        if (!keepPanel) {
            // The shutdown checkpoint may run after clients and SVG caches are
            // disposed. Retain only the small ordering metadata for that write.
            this.retainedPlotOrder = this.api.plotOrder;
        }
        this.sessionConnectionSubscription?.dispose();
        this.stopRequests();
        if (!keepPanel) {
            this.webviewPanel?.dispose();
        }
        this.webviewPanel = undefined;
        this.releasePlots();
    }

    private releasePlots(): void {
        this.setPlots([]);
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
