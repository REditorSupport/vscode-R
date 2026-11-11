import { EventEmitter } from 'events';

export interface PlotFrame {
    version: number;
    sessionId: string;
    frameExt?: Record<string, unknown> | null;
    device: {
        width: number;
        height: number;
        dpi: number;
        bg: string | null;
    };
    ops: any[];
    rIndex?: number;
}

interface SessionHistory {
    plots: PlotFrame[];
    currentIndex: number;
    latestDeleted: boolean;
    label?: string;
}

export interface PlotHistoryState {
    activeSessionId: string;
    selectedSessionId?: string;
    sessions: Array<SessionHistory & { id: string }>;
}

export class PlotHistory {
    private sessions: Map<string, SessionHistory> = new Map();
    private activeSessionId: string = '';
    private selectedSessionId: string | undefined;
    private maxPlots: number;
    private emitter = new EventEmitter();

    constructor(maxPlots: number = 50) {
        this.maxPlots = Math.max(1, Math.floor(maxPlots) || 50);
    }

    sessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    sessionLabel(sessionId: string): string | undefined {
        return this.sessions.get(sessionId)?.label;
    }

    setSessionLabel(sessionId: string, label: string): void {
        const history = this.sessions.get(sessionId);
        if (history && history.label !== label) {
            history.label = label.slice(0, 256);
            this.emitter.emit('change');
        }
    }

    snapshot(): PlotHistoryState {
        return {
            activeSessionId: this.activeSessionId,
            selectedSessionId: this.selectedSessionId,
            sessions: [...this.sessions].map(([id, history]) => ({ id, ...history })),
        };
    }

    restore(value: unknown): void {
        if (!value || typeof value !== 'object') {
            return;
        }
        const state = value as Partial<PlotHistoryState>;
        if (!Array.isArray(state.sessions)) {
            return;
        }
        for (const entry of state.sessions) {
            if (
                !entry ||
                typeof entry.id !== 'string' ||
                !entry.id ||
                !Array.isArray(entry.plots) ||
                !entry.plots.every(isPlotFrame) ||
                !Number.isInteger(entry.currentIndex) ||
                entry.currentIndex < -1 ||
                entry.currentIndex >= entry.plots.length ||
                (entry.plots.length > 0 && entry.currentIndex < 0) ||
                typeof entry.latestDeleted !== 'boolean'
            ) {
                continue;
            }
            const removed = Math.max(0, entry.plots.length - this.maxPlots);
            this.sessions.set(entry.id, {
                plots: entry.plots.slice(removed),
                currentIndex: entry.plots.length ? Math.max(0, entry.currentIndex - removed) : -1,
                latestDeleted: entry.latestDeleted,
                label: typeof entry.label === 'string' ? entry.label.slice(0, 256) : undefined,
            });
        }
        this.activeSessionId =
            state.activeSessionId && this.sessions.has(state.activeSessionId)
                ? state.activeSessionId
                : (this.sessionIds().at(-1) ?? '');
        this.selectedSessionId =
            state.selectedSessionId && this.sessions.has(state.selectedSessionId)
                ? state.selectedSessionId
                : undefined;
        this.emitter.emit('change');
    }

    selectSession(sessionId: string): boolean {
        if (!this.sessions.has(sessionId)) {
            return false;
        }
        this.selectedSessionId = sessionId;
        this.activeSessionId = sessionId;
        this.emitter.emit('change');
        return true;
    }

    private activate(sessionId: string): void {
        if (!this.selectedSessionId) {
            this.activeSessionId = sessionId;
        }
    }

    onDidChange(listener: () => void): { dispose(): void } {
        this.emitter.on('change', listener);
        return {
            dispose: () => {
                this.emitter.removeListener('change', listener);
            },
        };
    }

    addPlot(sessionId: string, plot: PlotFrame) {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = { plots: [], currentIndex: -1, latestDeleted: false };
            this.sessions.set(sessionId, session);
        }

        session.latestDeleted = false;
        session.plots.push(plot);
        while (session.plots.length > this.maxPlots) {
            session.plots.shift();
        }
        session.currentIndex = session.plots.length - 1;
        this.activate(sessionId);
        this.emitter.emit('change');
    }

    replaceCurrent(sessionId: string, plot: PlotFrame) {
        const session = this.sessions.get(sessionId);
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        const old = session.plots[session.currentIndex];
        if (old?.rIndex !== undefined) {
            plot.rIndex = old.rIndex;
        }
        session.plots[session.currentIndex] = plot;
        this.activate(sessionId);
        this.emitter.emit('change');
    }

    appendOps(sessionId: string, plot: PlotFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (session && session.latestDeleted) {
            return false;
        }
        if (!session || session.plots.length === 0) {
            this.addPlot(sessionId, plot);
            return true;
        }
        const latest = session.plots[session.plots.length - 1];
        const newOps = plot.ops || [];
        for (const op of newOps) {
            latest.ops.push(op);
        }
        latest.device = plot.device;
        if (plot.frameExt) {
            latest.frameExt = plot.frameExt;
        }
        this.activate(sessionId);
        this.emitter.emit('change');
        return true;
    }

    replaceAtIndex(sessionId: string, rIndex: number, plot: PlotFrame): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }
        const idx = session.plots.findIndex((p) => p.rIndex === rIndex);
        if (idx < 0) {
            return false;
        }
        plot.rIndex = rIndex;
        session.plots[idx] = plot;
        this.emitter.emit('change');
        return true;
    }

    replaceLatest(sessionId: string, plot: PlotFrame, expectedRIndex?: number): boolean {
        const session = this.sessions.get(sessionId);
        if (session && session.latestDeleted) {
            return false;
        }
        if (!session || session.plots.length === 0) {
            this.addPlot(sessionId, plot);
            return true;
        }
        const old = session.plots[session.plots.length - 1];
        if (
            expectedRIndex !== undefined &&
            old?.rIndex !== undefined &&
            old.rIndex !== expectedRIndex
        ) {
            return false;
        }
        if (old?.rIndex !== undefined) {
            plot.rIndex = old.rIndex;
        } else if (expectedRIndex !== undefined) {
            plot.rIndex = expectedRIndex;
        }
        session.plots[session.plots.length - 1] = plot;
        this.emitter.emit('change');
        return true;
    }

    currentPlot(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex < 0) {
            return null;
        }
        return session.plots[session.currentIndex] ?? null;
    }

    latestPlot(sessionId: string): PlotFrame | undefined {
        return this.sessions.get(sessionId)?.plots.at(-1);
    }

    navigatePrevious(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex <= 0) {
            return null;
        }
        session.currentIndex--;
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }

    navigateNext(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.currentIndex >= session.plots.length - 1) {
            return null;
        }
        session.currentIndex++;
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }

    getActiveSessionId(): string {
        return this.activeSessionId;
    }

    currentIndex(): number {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.currentIndex + 1 : 0;
    }

    currentRIndex(): number | undefined {
        const plot = this.currentPlot();
        return plot?.rIndex;
    }

    count(): number {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.plots.length : 0;
    }

    clear() {
        const session = this.sessions.get(this.activeSessionId);
        if (session) {
            session.plots = [];
            session.currentIndex = -1;
            session.latestDeleted = false;
        }
        this.emitter.emit('change');
    }

    isLatestDeleted(): boolean {
        const session = this.sessions.get(this.activeSessionId);
        return session ? session.latestDeleted : false;
    }

    removeCurrent(): PlotFrame | null {
        const session = this.sessions.get(this.activeSessionId);
        if (!session || session.plots.length === 0) {
            return null;
        }
        const wasLatest = session.currentIndex === session.plots.length - 1;
        session.plots.splice(session.currentIndex, 1);
        if (wasLatest) {
            session.latestDeleted = true;
        }
        if (session.plots.length === 0) {
            session.currentIndex = -1;
            this.emitter.emit('change');
            return null;
        }
        if (session.currentIndex >= session.plots.length) {
            session.currentIndex = session.plots.length - 1;
        }
        this.emitter.emit('change');
        return session.plots[session.currentIndex];
    }
}

function isPlotFrame(value: unknown): value is PlotFrame {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const frame = value as Partial<PlotFrame>;
    const device = frame.device;
    return (
        typeof frame.version === 'number' &&
        typeof frame.sessionId === 'string' &&
        Array.isArray(frame.ops) &&
        Boolean(
            device &&
            Number.isFinite(device.width) &&
            device.width > 0 &&
            Number.isFinite(device.height) &&
            device.height > 0 &&
            Number.isFinite(device.dpi) &&
            device.dpi > 0 &&
            (device.bg === null || typeof device.bg === 'string'),
        ) &&
        (frame.rIndex === undefined || (Number.isInteger(frame.rIndex) && frame.rIndex >= 0))
    );
}
