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
import { randomUUID } from 'crypto';
import type { PlotHistoryState } from './jgdPlotHistory';
import { PlotLifecycle } from './plotLifecycle';
import { PlotViewerRegistry } from './plotViewerRegistry';

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
    public jgdManager: JgdManager;
    private lifecycle = new PlotLifecycle();
    private standardViewers = new PlotViewerRegistry<StandardPlotViewer>((source) => {
        const key = sessionProcessIdentity(source);
        this.restoredStandardSessions = this.restoredStandardSessions.filter(
            (saved) => sessionProcessIdentity(saved) !== key,
        );
        void this.saveStandardSources();
    }, this.lifecycle);
    private restoredStandardSessions: ViewerSessionSource[] = [];
    private disposed = false;
    private historySaveTimer: NodeJS.Timeout | undefined;
    private historySubscription: { dispose(): void } | undefined;
    private historyWrites: Promise<void> | undefined;
    private historyContentDirty = false;
    private historySelectionDirty = false;
    private historyCheckpointId: string | undefined;

    constructor() {
        this.httpgdManager = new HttpgdManager(this.lifecycle);
        this.jgdManager = new JgdManager(this.lifecycle);
    }

    get viewers(): PlotViewer[] {
        const viewers: PlotViewer[] = this.httpgdManager.getViewers();
        viewers.push(...this.jgdManager.getViewers());
        viewers.push(...this.standardViewers.values());
        return viewers;
    }

    get activeViewer(): PlotViewer | undefined {
        const focused = this.viewers.find((viewer) => viewer.isActive);
        if (focused) {
            return focused;
        }
        if (jgdEnabled()) {
            return this.jgdManager.getViewer() || this.httpgdManager.getRecentViewer();
        }
        return this.httpgdManager.getRecentViewer();
    }

    public initialize(): void {
        this.jgdManager.initialize(extensionContext.extensionUri);
        const saved = extensionContext.workspaceState.get<
            PlotHistoryState & { checkpointId?: string }
        >('r.plot.jgdState');
        const selection = extensionContext.workspaceState.get<{
            checkpointId?: string;
            positions?: unknown;
        }>('r.plot.jgdSelection');
        this.historyCheckpointId = saved?.checkpointId;
        const trimmed = this.jgdManager.history.restore(
            saved,
            this.historyCheckpointId && selection?.checkpointId === this.historyCheckpointId
                ? selection.positions
                : undefined,
        );
        this.historyContentDirty =
            !this.historyCheckpointId ||
            trimmed ||
            saved?.sessions.length !== this.jgdManager.history.sessionIds().length;
        const sources = extensionContext.workspaceState.get<unknown>('r.plot.standardSessions');
        this.restoredStandardSessions = Array.isArray(sources)
            ? sources.filter(isViewerSessionSource)
            : [];
        for (const source of this.restoredStandardSessions) {
            this.lifecycle.observe(source);
        }
        this.httpgdManager.initialize();
        this.historySubscription = this.jgdManager.history.onDidChange((_id, selectionOnly) => {
            this.historyContentDirty ||= !selectionOnly;
            this.historySelectionDirty = true;
            // Checkpoint during normal operation: shutdown-only writes can be
            // lost when VS Code tears down the extension host's storage bridge.
            if (!this.historySaveTimer && !this.disposed) {
                this.historySaveTimer = setTimeout(() => {
                    this.historySaveTimer = undefined;
                    void this.saveJgdHistory();
                }, 250);
            }
        });

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
        if (this.disposed) {
            return;
        }
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

    public async showStandardPlot(target: Session, restoring = false): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.lifecycle.observe(target);
        if (this.lifecycle.hasExited(target)) {
            return;
        }
        const viewer = restoring
            ? this.standardViewers.get(sessionProcessIdentity(target))
            : this.getStandardViewer(target);
        await viewer?.update(restoring);
    }

    private getStandardViewer(target: Session): StandardPlotViewer {
        const existing = this.standardViewers.forSession(target);
        const viewer = this.standardViewers.getOrCreate(
            target,
            target.sessionId,
            () => new StandardPlotViewer(target),
        );
        viewer.bindSession(target);
        if (!existing) {
            void this.saveStandardSources();
        }
        return viewer;
    }

    public async showHttpgdPlot(url: string, target?: Session, restoring = false): Promise<void> {
        const source = target
            ? {
                  sessionId: target.sessionId,
                  host: target.host,
                  pid: target.pid,
                  rVer: target.rVer,
                  processExited: target.processExited,
              }
            : undefined;
        await this.httpgdManager.showViewer(url, source, false, restoring);
    }

    public getJgdEnvVars(): Record<string, string> {
        return this.jgdManager.getEnvVars();
    }

    public async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        clearTimeout(this.historySaveTimer);
        this.historySubscription?.dispose();
        this.lifecycle.dispose();
        const saved = Promise.all([
            this.saveJgdHistory(),
            this.saveStandardSources(),
            this.httpgdManager.saveConnections(),
        ]);
        this.jgdManager.stop();
        this.standardViewers.dispose();
        this.httpgdManager.dispose();
        await saved;
    }

    private saveJgdHistory(): Promise<void> {
        // Keep one writer and coalesce changes arriving during storage I/O.
        // Navigation writes only small cursor metadata, never plot geometry.
        this.historyWrites ??= Promise.resolve()
            .then(async () => {
                while (this.historyContentDirty || this.historySelectionDirty) {
                    const contentDirty = this.historyContentDirty;
                    this.historyContentDirty = false;
                    this.historySelectionDirty = false;
                    if (contentDirty) {
                        const checkpointId = randomUUID();
                        await extensionContext.workspaceState.update('r.plot.jgdState', {
                            ...this.jgdManager.history.snapshot(),
                            checkpointId,
                        });
                        this.historyCheckpointId = checkpointId;
                    }
                    // Tie cursors to their frame checkpoint so an interrupted write
                    // cannot apply old indices to a different set of retained plots.
                    if (!this.historyContentDirty) {
                        await extensionContext.workspaceState.update('r.plot.jgdSelection', {
                            checkpointId: this.historyCheckpointId,
                            positions: this.jgdManager.history.snapshotSelection(),
                        });
                    }
                }
            })
            .catch((error) => {
                this.historyContentDirty = true;
                console.warn('[Plot Viewer] Could not save JGD state', error);
            })
            .finally(() => {
                this.historyWrites = undefined;
            });
        return this.historyWrites;
    }

    private async saveStandardSources(): Promise<void> {
        const standardSources = new Map(
            this.restoredStandardSessions.map((source) => [sessionProcessIdentity(source), source]),
        );
        for (const viewer of this.standardViewers.values()) {
            if (!this.lifecycle.hasExited(viewer.sessionSource)) {
                standardSources.set(
                    sessionProcessIdentity(viewer.sessionSource),
                    viewer.sessionSource,
                );
            }
        }
        await extensionContext.workspaceState
            .update('r.plot.standardSessions', [...standardSources.values()])
            .then(undefined, (error) =>
                console.warn('[Plot Viewer] Could not save standard plot sessions', error),
            );
    }

    private async handleCommand(
        command: string,
        hostOrWebviewUri?: string | vscode.Uri,
        ...args: unknown[]
    ): Promise<void> {
        if (command === 'showViewers') {
            const source = activeSession;
            const target = source && resolvePlotSession(source);
            if (this.disposed) {
                return;
            }
            if (!target) {
                void vscode.window.showInformationMessage(
                    'Focus an attached R session to show its plot viewer.',
                );
                return;
            }
            if (this.jgdManager.showForSession(target)) {
                return;
            }
            const httpgd = await this.httpgdManager.restoreConnection(target);
            if (this.disposed) {
                return;
            }
            if (httpgd) {
                httpgd.show(true);
                return;
            }
            const key = sessionProcessIdentity(target);
            if (
                this.standardViewers.get(key) ||
                this.restoredStandardSessions.some((saved) => sessionProcessIdentity(saved) === key)
            ) {
                this.getStandardViewer(target).show(true);
            } else {
                void vscode.window.showInformationMessage(
                    'No plot is available for the active R session.',
                );
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
            const viewers = this.httpgdManager.getViewers();
            viewer =
                viewers.find((v: HttpgdViewer) => v.id === hostOrWebviewUri) ??
                viewers.find((v) =>
                    v.connections.some((connection) => {
                        const url = new URL(connection.url);
                        return url.host === hostOrWebviewUri || url.origin === hostOrWebviewUri;
                    }),
                );
        } else if (hostOrWebviewUri instanceof vscode.Uri) {
            viewer = this.viewers.find((v) => v.getPanelPath?.() === hostOrWebviewUri.path);
        }

        // A command from an ended session's retained tab must not target another session.
        if (hostOrWebviewUri === undefined) {
            viewer = this.activeViewer;
        }

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
