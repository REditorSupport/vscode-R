
import * as vscode from 'vscode';
import { asViewColumn, config, UriIcon } from '../util';
import { sessionRequest, server } from '../session';
import { PlotViewer } from './types';

export class StandardPlotViewer implements PlotViewer {
    readonly id: string = 'standard';
    private panel: vscode.WebviewPanel | undefined;
    private viewWidth: number = 800;
    private viewHeight: number = 600;
    private plotData: string | undefined;
    private plotFormat: string | undefined;

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

    public handleCommand(command: string): void {
        if (command === 'showViewers') {
            this.show();
        }
        // Other commands are not supported by the standard viewer
    }

    public dispose(): void {
        this.panel?.dispose();
    }

    private createPanel(viewColumn: vscode.ViewColumn) {
        this.panel = vscode.window.createWebviewPanel(
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

        this.panel.iconPath = new UriIcon('graph');
        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(async (msg: { type: string, width?: number, height?: number }) => {
            if (msg.type === 'resize') {
                this.viewWidth = msg.width || this.viewWidth;
                this.viewHeight = msg.height || this.viewHeight;
                await this.requestPlot();
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    private async requestPlot() {
        if (!server || !this.panel) {
            return;
        }

        const format = config().get<string>('plot.format', 'svglite');
        const devArgs = config().get<Record<string, unknown>>('plot.devArgs');
        const response = await sessionRequest(server, {
            method: 'plot_latest',
            params: {
                width: this.viewWidth,
                height: this.viewHeight,
                format: format,
                devArgs: devArgs
            }
        });

        if (response && (response as any).data) {
            this.plotData = (response as any).data;
            this.plotFormat = (response as any).format || format;
            void this.panel.webview.postMessage({
                type: 'update',
                data: this.plotData,
                format: this.plotFormat
            });
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
