import { getViewerSessionContext } from '../session';
import { sessionProcessIdentity } from '../sessionIdentity';
import type { ViewerSessionSource } from '../viewerSession';

/** Confirmed R exit triggers full cleanup, regardless of panel visibility.
 * Disposing the extension or losing its transport does not end an R session.
 */
export class PlotLifecycle {
    private subscriptions = new Map<string, { dispose(): void }>();
    private exited = new Set<string>();
    private listeners = new Set<(source: ViewerSessionSource) => void>();
    private disposed = false;

    onExit(listener: (source: ViewerSessionSource) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    hasExited(source?: ViewerSessionSource): boolean {
        return (
            !!source && (source.processExited || this.exited.has(sessionProcessIdentity(source)))
        );
    }

    observe(source?: ViewerSessionSource): void {
        if (!source || this.disposed) {
            return;
        }
        const key = sessionProcessIdentity(source);
        if (this.exited.has(key) || this.subscriptions.has(key)) {
            return;
        }
        // Session adapters can clear PID metadata during detach. Keep the
        // original process identity for the eventual exit callback.
        const captured: ViewerSessionSource = {
            sessionId: source.sessionId,
            host: source.host,
            pid: source.pid,
            rVer: source.rVer,
            processExited: source.processExited,
        };
        const context = getViewerSessionContext(captured.sessionId, captured);
        const subscription = context?.observeExit(() => this.markExited(captured));
        if (subscription) {
            this.subscriptions.set(key, subscription);
        }
        if (source.processExited || context?.hasExited) {
            this.markExited(captured);
        }
    }

    markExited(source: ViewerSessionSource): void {
        const key = sessionProcessIdentity(source);
        if (this.disposed || this.exited.has(key)) {
            return;
        }
        this.exited.add(key);
        this.subscriptions.get(key)?.dispose();
        this.subscriptions.delete(key);
        for (const listener of this.listeners) {
            listener(source);
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const subscription of this.subscriptions.values()) {
            subscription.dispose();
        }
        this.subscriptions.clear();
        this.listeners.clear();
    }
}
