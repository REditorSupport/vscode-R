
import * as vscode from 'vscode';
import { asViewColumn, config, UriIcon } from '../util';
import * as session from '../session';
import { PlotViewer } from './types';

interface PlotResponse {
    data: string;
    format: string;
}

export class StandardPlotViewer implements PlotViewer {
    readonly id: string = 'standard';
    private panel: vscode.WebviewPanel | undefined;
    private viewWidth: number = 800;
    private viewHeight: number = 600;
    private plotData: string | undefined;
    private plotFormat: string | undefined;
    private panelGeneration = 0;
    private plotRequestPending = false;
    private plotRequest: Promise<void> | undefined;

    public async update(): Promise<void> {
        const viewColumn = asViewColumn(config().get<string>('session.viewers.viewColumn.plot'), vscode.ViewColumn.Two);
        if (!this.panel) {
            this.createPanel(viewColumn);
        } else {
            this.panel.reveal(viewColumn, true);
            await this.requestPlot();
        }
    }

    public show(preserveFocus?: boolean): void {
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
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this.panel = panel;
        const generation = ++this.panelGeneration;

        panel.iconPath = new UriIcon('graph');
        panel.webview.html = this.getHtml();

        panel.webview.onDidReceiveMessage(async (msg: { type: string, width?: number, height?: number }) => {
            if (this.panel === panel && this.panelGeneration === generation && msg.type === 'resize') {
                this.viewWidth = msg.width || this.viewWidth;
                this.viewHeight = msg.height || this.viewHeight;
                await this.requestPlot();
            }
        });

        panel.onDidDispose(() => {
            if (this.panel === panel && this.panelGeneration === generation) {
                this.panel = undefined;
                this.panelGeneration++;
            }
        });
    }

    private async requestPlot() {
        if (!session.globalPipePath || !this.panel) {
            return;
        }

        this.plotRequestPending = true;
        if (this.plotRequest) {
            return this.plotRequest;
        }

        const request = this.drainPlotRequests();
        this.plotRequest = request;
        try {
            await request;
        } finally {
            if (this.plotRequest === request) {
                this.plotRequest = undefined;
                // A request can become pending between the drain's final check
                // and this continuation. Start it without losing that event.
                if (this.plotRequestPending && this.panel) {
                    void this.requestPlot();
                }
            }
        }
    }

    private async drainPlotRequests(): Promise<void> {
        while (this.plotRequestPending) {
            this.plotRequestPending = false;
            const panel = this.panel;
            const generation = this.panelGeneration;
            const targetSession = session.activeSession;
            if (!session.globalPipePath || !panel) {
                continue;
            }

            const width = this.viewWidth;
            const height = this.viewHeight;
            const format = config().get<string>('plot.format', 'svglite');
            const devArgs = config().get<Record<string, unknown>>('plot.devArgs');
            let response: PlotResponse | undefined;
            try {
                response = await session.sessionRequest({
                    method: 'plot_latest',
                    params: { width, height, format, devArgs }
                }, targetSession) as PlotResponse | undefined;
            } catch {
                // sessionRequest normally converts transport failures to undefined;
                // keep the viewer resilient if a requester rejects directly.
            }

            if (!response?.data) {
                // A timed out request may still be running in R. Do not turn a
                // failed request into an automatic retry; a later event can retry.
                this.plotRequestPending = false;
                break;
            }

            if (this.panel === panel
                && this.panelGeneration === generation
                && session.activeSession === targetSession) {
                this.plotData = response.data;
                this.plotFormat = response.format || format;
                void panel.webview.postMessage({
                    type: 'update',
                    data: this.plotData,
                    format: this.plotFormat
                });
            }
        }
    }

    private getHtml() {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: transparent;
            display: flex;
            justify-content: center;
            align-items: center;
        }
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
    <div id="plot-container"></div>
    <script>
        const vscode = acquireVsCodeApi();
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
        observer.observe(document.body);

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
    </script>
</body>
</html>
        `;
    }
}
