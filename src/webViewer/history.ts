import type { Memento, ViewColumn } from 'vscode';
import type { ViewerSessionContext, ViewerSessionSource } from '../viewerSession';
import { sessionProcessIdentity as widgetSessionIdentity } from '../sessionIdentity';

export { widgetSessionIdentity };

export const widgetHistoryKey = 'r.htmlViewer.histories';
export const widgetHistoryLimit = 50;

export interface WidgetHistory {
    source: ViewerSessionSource;
    history: Array<{ file: string; title: string }>;
    index: number;
    viewColumn?: ViewColumn;
}

/** Retain output paths for a process lifetime, independently of its Viewer tab. */
export class WidgetHistoryStore {
    readonly entries = new Map<string, WidgetHistory>();
    private readonly subscriptions = new Map<string, { dispose(): void }>();
    private disposed = false;
    private writes: Promise<void> = Promise.resolve();

    constructor(
        private readonly state: Memento,
        resolveSession: (source: ViewerSessionSource) => ViewerSessionContext,
    ) {
        const saved = state.get<unknown>(widgetHistoryKey);
        if (Array.isArray(saved)) {
            for (const value of saved) {
                if (!isHistory(value)) { continue; }
                const removed = Math.max(0, value.history.length - widgetHistoryLimit);
                const record = { ...value, history: value.history.slice(-widgetHistoryLimit), index: Math.max(0, value.index - removed) };
                const session = resolveSession(record.source);
                if (!session.hasExited) {
                    this.entries.set(session.sessionId, record);
                    this.watch(session);
                }
            }
            // Drop invalid records and any already-confirmed process exits.
            void this.persist();
        }
    }

    remember(session: ViewerSessionContext): WidgetHistory {
        let record = this.entries.get(session.sessionId);
        if (record && widgetSessionIdentity(record.source) !== widgetSessionIdentity(session.source)) {
            this.forget(session.sessionId);
            record = undefined;
        }
        record ??= { source: { ...session.source }, history: [], index: -1 };
        if (!session.hasExited && !this.entries.has(session.sessionId)) {
            this.entries.set(session.sessionId, record);
            this.watch(session);
        }
        return record;
    }

    save(record: WidgetHistory): Promise<void> {
        if (this.entries.get(record.source.sessionId) !== record) { return this.writes; }
        return this.persist();
    }

    forget(sessionId: string): void {
        this.subscriptions.get(sessionId)?.dispose();
        this.subscriptions.delete(sessionId);
        if (this.entries.delete(sessionId)) { void this.persist(); }
    }

    private watch(session: ViewerSessionContext): void {
        this.subscriptions.get(session.sessionId)?.dispose();
        this.subscriptions.set(session.sessionId, session.observeExit(() => this.forget(session.sessionId)));
    }

    private persist(): Promise<void> {
        if (this.disposed) { return this.writes; }
        // Capture each revision before queuing: later mutations must not alter it.
        const saved = [...this.entries.values()].filter(record => record.history.length).map(record => ({
            ...record, source: { ...record.source }, history: record.history.map(item => ({ ...item })),
        }));
        this.writes = this.writes.then(() => this.state.update(widgetHistoryKey, saved)).catch(error => {
            console.warn('[HTML Viewer] Could not save widget history', error);
        });
        return this.writes;
    }

    flush(): Promise<void> { return this.writes; }

    dispose(): void {
        this.disposed = true;
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.subscriptions.clear();
    }
}

function isHistory(value: unknown): value is WidgetHistory {
    if (!value || typeof value !== 'object') { return false; }
    const record = value as Partial<WidgetHistory>;
    const source = record.source;
    return Boolean(source && typeof source.sessionId === 'string' && source.sessionId &&
        typeof source.host === 'string' && typeof source.pid === 'string' && typeof source.rVer === 'string' &&
        typeof source.processExited === 'boolean' && Array.isArray(record.history) && record.history.length &&
        record.history.every(item => item && typeof item.file === 'string' && typeof item.title === 'string') &&
        Number.isInteger(record.index) && record.index! >= 0 && record.index! < record.history.length &&
        (record.viewColumn === undefined || Number.isInteger(record.viewColumn) && record.viewColumn >= 1 && record.viewColumn <= 9));
}
