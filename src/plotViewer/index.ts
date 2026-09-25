
import * as vscode from 'vscode';
import { PlotViewer, PlotManager } from './types';
import { HttpgdManager, HttpgdViewer } from './httpgdViewer';
export { HttpgdManager };
import { StandardPlotViewer } from './standardViewer';
import { JgdManager } from './jgdViewer';
import { extensionContext } from '../extension';
import { config } from '../util';

export function resolveBackend(): 'auto' | 'standard' | 'httpgd' | 'jgd' {
    const explicit = config().get<string>('plot.backend', 'auto');
    if (explicit !== 'auto') return explicit as 'standard' | 'httpgd' | 'jgd';
    if (config().get<boolean>('plot.useHttpgd', false)) return 'httpgd';
    return 'auto';
}

export function jgdEnabled(backend = resolveBackend()): boolean {
    return backend === 'jgd' || backend === 'auto';
}

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
    public jgdManager: JgdManager;

    constructor() {
        this.httpgdManager = new HttpgdManager();
        this.standardPlotViewer = new StandardPlotViewer();
        this.jgdManager = new JgdManager();
    }

    get viewers(): PlotViewer[] {
        const viewers: PlotViewer[] = [...this.httpgdManager.viewers];
        const jgdViewer = this.jgdManager.getViewer();
        if (jgdViewer) viewers.push(jgdViewer);
        viewers.push(this.standardPlotViewer);
        return viewers;
    }

    get activeViewer(): PlotViewer | undefined {
        if (jgdEnabled()) {
            return this.jgdManager.getViewer() || this.httpgdManager.getRecentViewer() || this.standardPlotViewer;
        }
        return this.httpgdManager.getRecentViewer() || this.standardPlotViewer;
    }

    public initialize(): void {
        this.jgdManager.initialize(extensionContext.extensionUri);

        for (const cmd of commands) {
            const fullCommand = `r.plot.${cmd}`;
            extensionContext.subscriptions.push(
                vscode.commands.registerCommand(fullCommand, (hostOrWebviewUri?: string | vscode.Uri, ...args: unknown[]) => {
                    void this.handleCommand(cmd, hostOrWebviewUri, ...args);
                })
            );
        }

        this.applyBackend();
        extensionContext.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('r.plot.backend') || e.affectsConfiguration('r.plot.useHttpgd')) {
                    this.applyBackend();
                }
            })
        );
    }

    // Start the JGD server when the backend allows it, so switching to jgd
    // takes effect on the next R (re)start without reloading VS Code.
    private applyBackend(): void {
        const backend = resolveBackend();
        void vscode.commands.executeCommand('setContext', 'r.plot.backend', backend);
        if (!jgdEnabled(backend)) {
            return;
        }
        this.jgdManager.start();
        // Set JGD_SOCKET env var for R child processes
        const envCollection = extensionContext.environmentVariableCollection;
        envCollection.persistent = false;
        for (const [key, value] of Object.entries(this.getJgdEnvVars())) {
            envCollection.replace(key, value);
        }
    }

    public async showStandardPlot(): Promise<void> {
        await this.standardPlotViewer.update();
    }

    public async showHttpgdPlot(url: string): Promise<void> {
        await this.httpgdManager.showViewer(url);
    }

    public getJgdEnvVars(): Record<string, string> {
        return this.jgdManager.getEnvVars();
    }

    public dispose(): void {
        this.jgdManager.stop();
    }

    private async handleCommand(command: string, hostOrWebviewUri?: string | vscode.Uri, ...args: unknown[]): Promise<void> {
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
