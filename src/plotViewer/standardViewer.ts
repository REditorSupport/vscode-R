import * as vscode from 'vscode';
import { asViewColumn, config, UriIcon } from '../util';
import * as session from '../session';
import { PlotViewer, plotPanelPath } from './types';
import {
    getViewerSessionScript,
    viewerSessionStyle,
    ViewerSessionContext,
    ViewerSessionSource,
} from '../viewerSession';
import { extensionContext } from '../extension';

interface PlotResponse {
    data: string;
    format: string;
}

interface PendingPlotRequest {
    panel: vscode.WebviewPanel;
    panelGeneration: number;
    targetSession: session.Session;
    width: number;
    height: number;
    format: string;
    devArgs: Record<string, unknown> | undefined;
}

export class StandardPlotViewer implements PlotViewer {
    readonly id: string = 'standard';
    private panel: vscode.WebviewPanel | undefined;
    private viewWidth: number = 800;
    private viewHeight: number = 600;
    private panelGeneration = 0;
    private pendingPlotRequest: PendingPlotRequest | undefined;
    private plotRequest: Promise<void> | undefined;

    private source!: ViewerSessionSource;
    private sessionContext: ViewerSessionContext | undefined;

    get sessionSource(): ViewerSessionSource {
        return this.source;
    }

    constructor(owner: session.Session) {
        this.bindSession(owner);
    }

    bindSession(owner: session.Session): void {
        this.source = {
            sessionId: owner.sessionId,
            host: owner.host,
            pid: owner.pid,
            rVer: owner.rVer,
            processExited: owner.processExited,
        };
    }

    get isActive(): boolean {
        return this.panel?.active ?? false;
    }

    getPanelPath(): string | undefined {
        return plotPanelPath(this.panel);
    }

    public async update(): Promise<void> {
        const viewColumn = asViewColumn(
            config().get<string>('session.viewers.viewColumn.plot'),
            vscode.ViewColumn.Two,
        );
        if (!this.panel) {
            this.createPanel(viewColumn);
        } else {
            this.panel.reveal(viewColumn, true);
            await this.requestPlot();
        }
    }

    public show(preserveFocus?: boolean): void {
        if (!this.panel && !this.source.processExited && !this.sessionContext?.hasExited) {
            this.createPanel(
                asViewColumn(
                    config().get<string>('session.viewers.viewColumn.plot'),
                    vscode.ViewColumn.Two,
                ),
            );
        }
        if (this.panel) {
            this.panel.reveal(undefined, preserveFocus);
        }
    }

    public handleCommand(): void {
        // Contextual plot commands are not supported by the standard viewer.
    }

    public dispose(): void {
        const panel = this.panel;
        if (panel) {
            this.panel = undefined;
            this.panelGeneration++;
            panel.dispose();
        }
    }

    private createPanel(viewColumn: vscode.ViewColumn) {
        const panel = vscode.window.createWebviewPanel(
            'r.standardPlot',
            'R Plot',
            {
                viewColumn,
                preserveFocus: true,
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        this.panel = panel;
        const generation = ++this.panelGeneration;
        let initialRequest = false;

        panel.iconPath = new UriIcon('graph');

        panel.webview.onDidReceiveMessage(
            async (msg: { type: string; width?: number; height?: number }) => {
                if (
                    this.panel === panel &&
                    this.panelGeneration === generation &&
                    (msg.type === 'resize' || (msg.type === 'ready' && !initialRequest))
                ) {
                    initialRequest = true;
                    if (msg.type === 'resize') {
                        this.viewWidth = msg.width || this.viewWidth;
                        this.viewHeight = msg.height || this.viewHeight;
                    }
                    await this.requestPlot();
                }
            },
        );

        panel.onDidDispose(() => {
            if (this.panel === panel && this.panelGeneration === generation) {
                this.panel = undefined;
                this.panelGeneration++;
            }
        });
        // Install the receiver before starting the document so its first ready
        // message cannot be missed, even without a visible layout/resize event.
        this.sessionContext = session.getViewerSessionContext(this.source.sessionId, this.source);
        this.sessionContext?.attach(panel);
        panel.webview.html = this.getHtml();
    }

    private requestPlot(): Promise<void> {
        const panel = this.panel;
        const targetSession = session.resolvePlotSession(this.source);
        if (!panel || !targetSession) {
            return Promise.resolve();
        }

        const conf = config();
        this.pendingPlotRequest = {
            panel,
            panelGeneration: this.panelGeneration,
            targetSession,
            width: this.viewWidth,
            height: this.viewHeight,
            format: conf.get<string>('plot.format', 'svglite'),
            devArgs: conf.get<Record<string, unknown>>('plot.devArgs'),
        };
        return this.startPlotDrain();
    }

    private startPlotDrain(): Promise<void> {
        if (this.plotRequest) {
            return this.plotRequest;
        }

        // Publish the flight before starting the drain because a requester can
        // synchronously trigger another viewer event while starting its RPC.
        let resolveFlight!: () => void;
        const flight = new Promise<void>((resolve) => {
            resolveFlight = resolve;
        });
        this.plotRequest = flight;

        const drain = () => {
            void this.drainPlotRequests().then(
                () => {
                    if (this.plotRequest !== flight) {
                        resolveFlight();
                        return;
                    }
                    if (this.pendingPlotRequest) {
                        // Keep the queued descriptor as captured; never recapture
                        // the active session while handing off the same flight.
                        drain();
                        return;
                    }
                    this.plotRequest = undefined;
                    resolveFlight();
                },
                (error) => {
                    console.error('Failed to update the standard plot viewer:', error);
                    if (this.plotRequest === flight) {
                        this.plotRequest = undefined;
                    }
                    resolveFlight();
                },
            );
        };

        drain();
        return flight;
    }

    private async drainPlotRequests(): Promise<void> {
        while (this.pendingPlotRequest) {
            const request = this.pendingPlotRequest;
            this.pendingPlotRequest = undefined;
            if (!this.isCurrentRequest(request)) {
                continue;
            }

            let response: PlotResponse | undefined;
            try {
                response = (await session.sessionRequest(
                    {
                        method: 'plot_latest',
                        params: {
                            width: request.width,
                            height: request.height,
                            format: request.format,
                            devArgs: request.devArgs,
                        },
                    },
                    request.targetSession,
                )) as PlotResponse | undefined;
            } catch {
                // sessionRequest normally converts transport failures to undefined;
                // keep the viewer resilient if a requester rejects directly.
            }

            if (!response?.data) {
                // A timed out request may still be running in R. Do not turn a
                // failed request into an automatic retry for the same session.
                this.discardPendingForSession(request.targetSession);
                continue;
            }

            if (this.isCurrentRequest(request)) {
                void request.panel.webview.postMessage({
                    type: 'update',
                    data: response.data,
                    format: response.format || request.format,
                });
            }
        }
    }

    private isCurrentRequest(request: PendingPlotRequest): boolean {
        return (
            this.panel === request.panel &&
            this.panelGeneration === request.panelGeneration &&
            session.resolvePlotSession(this.source) === request.targetSession
        );
    }

    private discardPendingForSession(targetSession: session.Session): void {
        if (this.pendingPlotRequest?.targetSession === targetSession) {
            this.pendingPlotRequest = undefined;
        }
    }

    private getHtml() {
        const codicons = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'resources', 'codicon.css'),
        );
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codicons.toString()}">
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: transparent;
            display: flex;
            flex-direction: column;
        }
        #session-info { display: flex; justify-content: flex-end; padding: 6px 8px; }
        #session-info:empty { display: none; }
        #plot-container { flex: 1; min-height: 0; width: 100%; display: flex; justify-content: center; align-items: center; }
        ${viewerSessionStyle}
        img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
        svg {
            width: 100%;
            height: 100%;
        }
    </style>
</head>
<body>
    <div id="session-info">${this.sessionContext?.getHtml() ?? ''}</div>
    <div id="plot-container"></div>
    <script>
        const vscode = acquireVsCodeApi();
        ${getViewerSessionScript()}
        const container = document.getElementById('plot-container');
        
        let resizeTimeout;
        const observer = new ResizeObserver(entries => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    clearTimeout(resizeTimeout);
                    resizeTimeout = setTimeout(() => {
                        vscode.postMessage({
                            type: 'resize',
                            width: Math.floor(width),
                            height: Math.floor(height)
                        });
                    }, 200);
                }
            }
        });
        observer.observe(container);

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                if (message.format === 'svglite' || message.format === 'svg') {
                    const binaryString = atob(message.data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    container.innerHTML = new TextDecoder().decode(bytes);
                } else {
                    container.innerHTML = '<img src="data:image/' + message.format + ';base64,' + message.data + '" />';
                }
            }
        });
        // Hidden webviews can suspend ResizeObserver callbacks. Request the
        // initial plot once scripts are listening, then refine its size on resize.
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>
        `;
    }
}
