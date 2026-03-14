
import * as vscode from 'vscode';
import { PlotViewer, PlotManager } from './types';
import { HttpgdManager, HttpgdViewer } from './httpgdViewer';
export { HttpgdManager };
import { StandardPlotViewer } from './standardViewer';
import { extensionContext } from '../extension';

const commands = [
    'showViewers',
    'openUrl',
    'openExternal',
    'showIndex',
    'toggleStyle',
    'toggleFullWindow',
    'togglePreviewPlots',
    'exportPlot',
    'nextPlot',
    'prevPlot',
    'lastPlot',
    'firstPlot',
    'hidePlot',
    'closePlot',
    'resetPlots',
    'zoomIn',
    'zoomOut'
] as const;

export class CommonPlotManager implements PlotManager {
    public httpgdManager: HttpgdManager;
    public standardPlotViewer: StandardPlotViewer;

    constructor() {
        this.httpgdManager = new HttpgdManager();
        this.standardPlotViewer = new StandardPlotViewer();
    }

    get viewers(): PlotViewer[] {
        const viewers: PlotViewer[] = [...this.httpgdManager.viewers];
        viewers.push(this.standardPlotViewer);
        return viewers;
    }

    get activeViewer(): PlotViewer | undefined {
        return this.httpgdManager.getRecentViewer() || this.standardPlotViewer;
    }

    public initialize(): void {
        for (const cmd of commands) {
            const fullCommand = `r.plot.${cmd}`;
            extensionContext.subscriptions.push(
                vscode.commands.registerCommand(fullCommand, (hostOrWebviewUri?: string | vscode.Uri, ...args: any[]) => {
                    void this.handleCommand(cmd, hostOrWebviewUri, ...args);
                })
            );
        }
    }

    public async showStandardPlot(): Promise<void> {
        await this.standardPlotViewer.update();
    }

    public async showHttpgdPlot(url: string): Promise<void> {
        await this.httpgdManager.showViewer(url);
    }

    private async handleCommand(command: string, hostOrWebviewUri?: string | vscode.Uri, ...args: any[]): Promise<void> {
        if (command === 'showViewers') {
            for (const viewer of this.viewers) {
                viewer.show(true);
            }
            return;
        }

        if (command === 'openUrl') {
            await this.httpgdManager.openUrl();
            return;
        }

        // Identify the correct viewer
        let viewer: PlotViewer | undefined;
        if (typeof hostOrWebviewUri === 'string') {
            viewer = this.httpgdManager.viewers.find((v: HttpgdViewer) => v.host === hostOrWebviewUri);
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            viewer = this.httpgdManager.viewers.find((v: HttpgdViewer) => v.getPanelPath() === hostOrWebviewUri.path);
        }

        // Fallback to active viewer
        viewer ||= this.activeViewer;

        if (viewer) {
            await viewer.handleCommand(command, ...args);
        }
    }
}

export function initializePlotManager(): PlotManager {
    const manager = new CommonPlotManager();
    manager.initialize();
    return manager;
}
