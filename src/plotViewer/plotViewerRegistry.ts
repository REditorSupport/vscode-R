import { sessionProcessIdentity } from '../sessionIdentity';
import type { ViewerSessionSource } from '../viewerSession';
import type { PlotViewer } from './types';
import { PlotLifecycle } from './plotLifecycle';

/** One viewer per R process, including devices whose owner is identified later. */
export class PlotViewerRegistry<T extends PlotViewer> {
    private viewers = new Map<string, T>();
    private recent: T[] = [];
    readonly lifecycle: PlotLifecycle;
    private readonly ownsLifecycle: boolean;
    private readonly exitSubscription: { dispose(): void };

    constructor(onExit: (source: ViewerSessionSource) => void, lifecycle?: PlotLifecycle) {
        this.ownsLifecycle = !lifecycle;
        this.lifecycle = lifecycle ?? new PlotLifecycle();
        this.exitSubscription = this.lifecycle.onExit((source) => {
            const viewer = this.forSession(source);
            if (viewer) {
                this.remove(viewer);
                viewer.dispose(true);
            }
            // Backing data may exist even when no viewer was opened.
            onExit(source);
        });
    }

    get(key: string): T | undefined {
        return this.viewers.get(key);
    }

    forSession(source?: ViewerSessionSource): T | undefined {
        return source ? this.get(sessionProcessIdentity(source)) : undefined;
    }

    values(): T[] {
        return [...this.viewers.values()];
    }

    get recentlyActive(): readonly T[] {
        return this.recent;
    }

    markActive(viewer: T): void {
        this.recent = this.recent.filter((active) => active !== viewer);
        this.recent.unshift(viewer);
    }

    remove(viewer: T): void {
        for (const [key, value] of this.viewers) {
            if (value === viewer) {
                this.viewers.delete(key);
            }
        }
        this.recent = this.recent.filter((active) => active !== viewer);
    }

    register(viewer: T, source?: ViewerSessionSource, deviceId = viewer.id): void {
        const key = source ? sessionProcessIdentity(source) : deviceId;
        // Preserve recent focus when moving an ownerless viewer to its owner.
        if (this.viewers.get(key) !== viewer) {
            for (const [oldKey, value] of this.viewers) {
                if (value === viewer) {
                    this.viewers.delete(oldKey);
                }
            }
        }
        this.viewers.delete(key);
        this.viewers.set(key, viewer);
        this.lifecycle.observe(source);
        if (this.lifecycle.hasExited(source) && this.viewers.get(key) === viewer) {
            this.remove(viewer);
            viewer.dispose(true);
        }
    }

    getOrCreate(source: ViewerSessionSource | undefined, deviceId: string, create: () => T): T {
        let viewer = this.forSession(source) ?? this.get(deviceId);
        const previous = this.get(deviceId);
        if (previous && previous !== viewer) {
            this.remove(previous);
            previous.dispose();
        }
        viewer ??= create();
        this.register(viewer, source, deviceId);
        return viewer;
    }

    dispose(): void {
        this.exitSubscription.dispose();
        if (this.ownsLifecycle) {
            this.lifecycle.dispose();
        }
        for (const viewer of this.viewers.values()) {
            viewer.dispose();
        }
        // Shutdown writers still read the owners/endpoints for live R sessions.
        // Permanent exit instead removes entries immediately in the handler above.
    }
}
