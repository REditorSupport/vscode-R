import * as vscode from 'vscode';
import { PlotViewer, PlotManager } from './types';
import { HttpgdManager, HttpgdViewer } from './httpgdViewer';
export { HttpgdManager };
import { StandardPlotViewer } from './standardViewer';
import { JgdManager } from './jgdViewer';
import { extensionContext } from '../extension';
import { config } from '../util';
import { getMigratedSetting } from '../configuration';
import { activeSession, resolvePlotSession, Session } from '../session';
import { sessionProcessIdentity } from '../sessionIdentity';
import { isViewerSessionSource, ViewerSessionSource } from '../viewerSession';

export type PlotBackend = 'auto' | 'standard' | 'httpgd' | 'jgd' | 'native';

export function resolveBackend(): PlotBackend {
    const selected = getMigratedSetting<string | boolean>(
        config(),
        'plot.backend',
        'plot.useHttpgd',
        (value) => value !== 'auto' && value !== false,
    )?.value;
    if (selected === true) {
        return 'httpgd';
    }
    return typeof selected === 'string' ? (selected as PlotBackend) : 'auto';
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
    'zoomOut',
] as const;

export class CommonPlotManager implements PlotManager {
    public httpgdManager: HttpgdManager;
    public standardPlotViewer: StandardPlotViewer;
    public jgdManager: JgdManager;
    private standardViewers = new Map<string, StandardPlotViewer>();
    private restoredStandardSessions: ViewerSessionSource[] = [];
    private disposed = false;

    constructor() {
        this.httpgdManager = new HttpgdManager();
        this.standardPlotViewer = new StandardPlotViewer();
        this.jgdManager = new JgdManager();
    }

    get viewers(): PlotViewer[] {
        const viewers: PlotViewer[] = [...this.httpgdManager.viewers];
        const jgdViewer = this.jgdManager.getViewer();
        if (jgdViewer) {
            viewers.push(jgdViewer);
        }
        viewers.push(this.standardPlotViewer);
        viewers.push(...this.standardViewers.values());
        return viewers;
    }

    get activeViewer(): PlotViewer | undefined {
        const focused = this.viewers.find((viewer) => viewer.isActive);
        if (focused) {
            return focused;
        }
        if (jgdEnabled()) {
            return (
                this.jgdManager.getViewer() ||
                this.httpgdManager.getRecentViewer() ||
                this.standardPlotViewer
            );
        }
        return this.httpgdManager.getRecentViewer() || this.standardPlotViewer;
    }

    public initialize(): void {
        this.jgdManager.initialize(extensionContext.extensionUri);
        this.jgdManager.history.restore(extensionContext.workspaceState.get('r.plot.jgdState'));
        const sources = extensionContext.workspaceState.get<unknown>('r.plot.standardSessions');
        this.restoredStandardSessions = Array.isArray(sources)
            ? sources.filter(isViewerSessionSource)
            : [];
        this.httpgdManager.initialize();

        for (const cmd of commands) {
            const fullCommand = `r.plot.${cmd}`;
            extensionContext.subscriptions.push(
                vscode.commands.registerCommand(
                    fullCommand,
                    (hostOrWebviewUri?: string | vscode.Uri, ...args: unknown[]) => {
                        return this.handleCommand(cmd, hostOrWebviewUri, ...args);
                    },
                ),
            );
        }

        this.applyBackend();
        extensionContext.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('r.plot.backend') ||
                    e.affectsConfiguration('r.plot.useHttpgd')
                ) {
                    this.applyBackend();
                }
            }),
        );
    }

    // Start the JGD server when the backend allows it, so switching to jgd
    // takes effect on the next R (re)start without reloading VS Code.
    private applyBackend(): void {
        const backend = resolveBackend();
        void vscode.commands.executeCommand('setContext', 'r.plot.backend', backend);
        const envCollection = extensionContext.environmentVariableCollection;
        envCollection.persistent = false;
        if (!jgdEnabled(backend)) {
            envCollection.delete('JGD_SOCKET');
            return;
        }
        this.jgdManager.start();
        // Set JGD_SOCKET env var for R child processes
        for (const [key, value] of Object.entries(this.getJgdEnvVars())) {
            envCollection.replace(key, value);
        }
    }

    public async showStandardPlot(target = activeSession): Promise<void> {
        if (!target) {
            return;
        }
        const key = sessionProcessIdentity(target);
        let viewer = this.standardViewers.get(key);
        if (!viewer) {
            viewer = new StandardPlotViewer(target);
            this.standardViewers.set(key, viewer);
        } else {
            viewer.bindSession(target);
        }
        await viewer.update();
    }

    public async showHttpgdPlot(url: string, target?: Session): Promise<void> {
        const source = target
            ? {
                  sessionId: target.sessionId,
                  host: target.host,
                  pid: target.pid,
                  rVer: target.rVer,
                  processExited: target.processExited,
              }
            : undefined;
        await this.httpgdManager.showViewer(url, source);
    }

    public getJgdEnvVars(): Record<string, string> {
        return this.jgdManager.getEnvVars();
    }

    public async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const standardSources = new Map(
            this.restoredStandardSessions.map((source) => [sessionProcessIdentity(source), source]),
        );
        for (const viewer of this.standardViewers.values()) {
            if (viewer.sessionSource) {
                standardSources.set(
                    sessionProcessIdentity(viewer.sessionSource),
                    viewer.sessionSource,
                );
            }
        }
        const saved = Promise.all([
            extensionContext.workspaceState.update(
                'r.plot.jgdState',
                this.jgdManager.history.snapshot(),
            ),
            extensionContext.workspaceState.update('r.plot.standardSessions', [
                ...standardSources.values(),
            ]),
            this.httpgdManager.saveConnections(),
        ]);
        this.jgdManager.stop();
        for (const viewer of this.standardViewers.values()) {
            viewer.dispose();
        }
        this.standardPlotViewer.dispose();
        this.httpgdManager.dispose();
        await saved.catch((error) =>
            console.warn('[Plot Viewer] Could not save reload state', error),
        );
    }

    private async handleCommand(
        command: string,
        hostOrWebviewUri?: string | vscode.Uri,
        ...args: unknown[]
    ): Promise<void> {
        if (command === 'showViewers') {
            await this.httpgdManager.restoreConnections();
            if (this.disposed) {
                return;
            }
            let unavailable = false;
            for (const source of this.restoredStandardSessions) {
                const target = resolvePlotSession(source);
                if (target) {
                    await this.showStandardPlot(target);
                } else if (!this.standardViewers.has(sessionProcessIdentity(source))) {
                    unavailable = true;
                }
            }
            if (unavailable) {
                void vscode.window.showInformationMessage(
                    'Attach the original R session to restore its standard plot viewer.',
                );
            }
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
            viewer = this.httpgdManager.viewers.find(
                (v: HttpgdViewer) => v.id === hostOrWebviewUri || v.host === hostOrWebviewUri,
            );
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            viewer = this.viewers.find((v) => v.getPanelPath?.() === hostOrWebviewUri.path);
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
