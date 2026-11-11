import { EventEmitter } from 'events';
import { sessionProcessIdentity } from '../sessionIdentity';
import { isViewerSessionSource, ViewerSessionSource } from '../viewerSession';

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

interface DeviceHistory {
    plots: PlotFrame[];
    latestDeleted: boolean;
    label?: string;
    source?: ViewerSessionSource;
}

interface Timeline {
    plots: PlotFrame[];
    currentIndex: number;
    devices: Set<string>;
}

export interface PlotHistoryState {
    activeSessionId: string;
    sessions: Array<DeviceHistory & { id: string; currentIndex: number }>;
    timelines?: Array<{
        deviceId: string;
        plots: Array<{ deviceId: string; index: number }>;
        currentIndex: number;
    }>;
}

export class PlotHistory {
    private sessions: Map<string, DeviceHistory> = new Map();
    // Device histories index replay targets; timelines own session navigation.
    // Both reference the same frames, so operations are never copied for grouping.
    private timelines = new Map<string, Timeline>();
    private owners = new Map<string, Timeline>();
    private order = new WeakMap<PlotFrame, number>();
    private sequence = 0;
    private activeSessionId: string = '';
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

    sessionSource(sessionId: string): ViewerSessionSource | undefined {
        return this.sessions.get(sessionId)?.source;
    }

    restoreDeviceIdentity(previousId: string, id: string, source: ViewerSessionSource): void {
        const device = this.sessions.get(previousId);
        if (
            !device?.source ||
            this.sessions.has(id) ||
            sessionProcessIdentity(device.source) !== sessionProcessIdentity(source)
        ) {
            return;
        }
        // Explicit jgd() devices first acquire a sess logical ID on reconnect.
        // Transfer their existing frame index and timeline membership together.
        const timeline = this.timelines.get(previousId)!;
        this.sessions.delete(previousId);
        this.sessions.set(id, device);
        this.timelines.delete(previousId);
        this.timelines.set(id, timeline);
        timeline.devices.delete(previousId);
        timeline.devices.add(id);
        for (const plot of device.plots) {
            plot.sessionId = id;
        }
        if (this.activeSessionId === previousId) {
            this.activeSessionId = id;
        }
    }

    setSessionSource(sessionId: string, source: ViewerSessionSource): void {
        const history = this.sessions.get(sessionId);
        if (history && !history.source) {
            history.source = { ...source };
            this.bindOwner(sessionId, source);
            this.emitter.emit('change', sessionId);
        }
    }

    setSessionLabel(sessionId: string, label: string): void {
        label = label.slice(0, 256);
        const history = this.sessions.get(sessionId);
        if (history && history.label !== label) {
            history.label = label;
            this.emitter.emit('change', sessionId);
        }
    }

    snapshot(): PlotHistoryState {
        return {
            activeSessionId: this.activeSessionId,
            sessions: [...this.sessions].map(([id, history]) => ({
                id,
                ...history,
                currentIndex: Math.max(
                    history.plots.length ? 0 : -1,
                    history.plots.indexOf(this.currentPlot(id)!),
                ),
            })),
            timelines: [...new Set(this.timelines.values())].map((timeline) => ({
                deviceId: timeline.devices.values().next().value!,
                plots: timeline.plots.map((plot) => ({
                    deviceId: plot.sessionId,
                    index: this.sessions.get(plot.sessionId)!.plots.indexOf(plot),
                })),
                currentIndex: timeline.currentIndex,
            })),
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
            const plots = entry.plots.map((plot) => ({ ...plot, sessionId: entry.id }));
            for (const plot of plots) {
                this.order.set(plot, this.sequence++);
            }
            this.timelines.set(entry.id, {
                plots: [...plots],
                currentIndex: entry.currentIndex,
                devices: new Set([entry.id]),
            });
            this.sessions.set(entry.id, {
                plots,
                latestDeleted: entry.latestDeleted,
                label: typeof entry.label === 'string' ? entry.label.slice(0, 256) : undefined,
                source: isViewerSessionSource(entry.source) ? { ...entry.source } : undefined,
            });
        }
        this.activeSessionId =
            state.activeSessionId && this.sessions.has(state.activeSessionId)
                ? state.activeSessionId
                : (this.sessionIds().at(-1) ?? '');
        // Older snapshots only stored per-device histories. Group those by owner;
        // newer snapshots also retain the exact interleaving and session cursor.
        for (const [id, device] of this.sessions) {
            if (device.source) {
                this.bindOwner(id, device.source, false);
            }
        }
        if (Array.isArray(state.timelines)) {
            for (const saved of state.timelines) {
                const timeline = this.timelines.get(saved?.deviceId);
                if (!timeline || !Array.isArray(saved.plots)) {
                    continue;
                }
                const plots = saved.plots.map((ref) =>
                    ref && this.timelines.get(ref.deviceId) === timeline
                        ? this.sessions.get(ref.deviceId)?.plots[ref.index]
                        : undefined,
                );
                if (
                    plots.length !== timeline.plots.length ||
                    plots.some((plot) => !plot) ||
                    new Set(plots).size !== plots.length ||
                    !Number.isInteger(saved.currentIndex) ||
                    saved.currentIndex < (plots.length ? 0 : -1) ||
                    saved.currentIndex >= plots.length
                ) {
                    continue;
                }
                timeline.plots = plots as PlotFrame[];
                timeline.currentIndex = saved.currentIndex;
            }
        }
        for (const timeline of new Set(this.timelines.values())) {
            for (const plot of timeline.plots) {
                this.order.set(plot, this.sequence++);
            }
            this.trim(timeline);
        }
        this.emitter.emit('change');
    }

    private bindOwner(id: string, source: ViewerSessionSource, trim = true): void {
        const incoming = this.timelines.get(id)!;
        const key = sessionProcessIdentity(source);
        const existing = this.owners.get(key);
        if (!existing) {
            this.owners.set(key, incoming);
        } else if (existing !== incoming) {
            const selected = incoming.devices.has(this.activeSessionId)
                ? incoming.plots[incoming.currentIndex]
                : existing.plots[existing.currentIndex];
            existing.plots.push(...incoming.plots);
            existing.plots.sort((a, b) => this.order.get(a)! - this.order.get(b)!);
            existing.currentIndex = selected
                ? existing.plots.indexOf(selected)
                : existing.plots.length - 1;
            for (const device of incoming.devices) {
                existing.devices.add(device);
                this.timelines.set(device, existing);
            }
            if (trim) {
                this.trim(existing);
            }
        }
    }

    private trim(timeline: Timeline): void {
        while (timeline.plots.length > this.maxPlots) {
            this.removeFrame(timeline.plots.shift()!);
            timeline.currentIndex = Math.max(0, timeline.currentIndex - 1);
        }
    }

    private removeFrame(plot: PlotFrame): void {
        const device = this.sessions.get(plot.sessionId)!;
        const index = device.plots.indexOf(plot);
        if (index === device.plots.length - 1) {
            device.latestDeleted = true;
        }
        device.plots.splice(index, 1);
    }

    onDidChange(listener: (sessionId?: string) => void): { dispose(): void } {
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
            session = { plots: [], latestDeleted: false };
            this.sessions.set(sessionId, session);
            this.timelines.set(sessionId, {
                plots: [],
                currentIndex: -1,
                devices: new Set([sessionId]),
            });
        }

        plot.sessionId = sessionId;
        this.order.set(plot, this.sequence++);
        session.latestDeleted = false;
        session.plots.push(plot);
        const timeline = this.timelines.get(sessionId)!;
        timeline.plots.push(plot);
        timeline.currentIndex = timeline.plots.length - 1;
        this.trim(timeline);
        this.activeSessionId = sessionId;
        this.emitter.emit('change', sessionId);
    }

    replaceCurrent(sessionId: string, plot: PlotFrame) {
        const old = this.currentPlot(sessionId);
        if (!old) {
            return this.addPlot(sessionId, plot);
        }
        this.replaceFrame(old, plot);
        this.activeSessionId = sessionId;
        this.emitter.emit('change', sessionId);
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
        this.activeSessionId = sessionId;
        this.emitter.emit('change', sessionId);
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
        this.replaceFrame(session.plots[idx], plot);
        this.emitter.emit('change', sessionId);
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
        this.replaceFrame(old, plot);
        this.emitter.emit('change', sessionId);
        return true;
    }

    private replaceFrame(old: PlotFrame, plot: PlotFrame): void {
        // Preserve reference identity in both indexes and the original arrival order.
        const rIndex = old.rIndex ?? plot.rIndex;
        Object.assign(old, plot, { sessionId: old.sessionId, rIndex });
    }

    // Navigation accepts any device ID in the session; replay updates above
    // remain device-specific because R plot indices are only unique per device.
    currentPlot(sessionId = this.activeSessionId): PlotFrame | null {
        const session = this.timelines.get(sessionId);
        if (!session || session.currentIndex < 0) {
            return null;
        }
        return session.plots[session.currentIndex] ?? null;
    }

    latestPlot(sessionId: string): PlotFrame | undefined {
        return this.sessions.get(sessionId)?.plots.at(-1);
    }

    invalidateReplayIndices(sessionId: string): void {
        for (const plot of this.sessions.get(sessionId)?.plots ?? []) {
            delete plot.rIndex;
        }
    }

    navigatePrevious(sessionId = this.activeSessionId): PlotFrame | null {
        return this.navigateTo(this.currentIndex(sessionId) - 2, sessionId);
    }

    navigateNext(sessionId = this.activeSessionId): PlotFrame | null {
        return this.navigateTo(this.currentIndex(sessionId), sessionId);
    }

    navigateFirst(sessionId = this.activeSessionId): PlotFrame | null {
        return this.navigateTo(0, sessionId);
    }

    navigateLast(sessionId = this.activeSessionId): PlotFrame | null {
        return this.navigateTo(this.count(sessionId) - 1, sessionId);
    }

    private navigateTo(index: number, sessionId: string): PlotFrame | null {
        const session = this.timelines.get(sessionId);
        if (
            !session ||
            index < 0 ||
            index >= session.plots.length ||
            index === session.currentIndex
        ) {
            return null;
        }
        session.currentIndex = index;
        this.emitter.emit('change', sessionId);
        return session.plots[session.currentIndex];
    }

    getActiveSessionId(): string {
        return this.activeSessionId;
    }

    currentIndex(sessionId = this.activeSessionId): number {
        const session = this.timelines.get(sessionId);
        return session ? session.currentIndex + 1 : 0;
    }

    currentRIndex(sessionId = this.activeSessionId): number | undefined {
        const plot = this.currentPlot(sessionId);
        return plot?.rIndex;
    }

    count(sessionId = this.activeSessionId): number {
        const session = this.timelines.get(sessionId);
        return session ? session.plots.length : 0;
    }

    clear(sessionId = this.activeSessionId) {
        const timeline = this.timelines.get(sessionId);
        if (timeline) {
            for (const id of timeline.devices) {
                const device = this.sessions.get(id)!;
                device.latestDeleted = device.latestDeleted || device.plots.length > 0;
                device.plots = [];
            }
            timeline.plots = [];
            timeline.currentIndex = -1;
        }
        this.emitter.emit('change', sessionId);
    }

    isLatestDeleted(sessionId = this.activeSessionId): boolean {
        const session = this.sessions.get(sessionId);
        return session ? session.latestDeleted : false;
    }

    removeCurrent(sessionId = this.activeSessionId): PlotFrame | null {
        const session = this.timelines.get(sessionId);
        if (!session || session.plots.length === 0) {
            return null;
        }
        this.removeFrame(session.plots.splice(session.currentIndex, 1)[0]);
        if (session.plots.length === 0) {
            session.currentIndex = -1;
            this.emitter.emit('change', sessionId);
            return null;
        }
        if (session.currentIndex >= session.plots.length) {
            session.currentIndex = session.plots.length - 1;
        }
        this.emitter.emit('change', sessionId);
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
