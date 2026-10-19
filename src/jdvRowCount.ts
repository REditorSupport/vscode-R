'use strict';

interface PendingHint {
    readonly generation: number;
    readonly nrow: number;
}

interface ViewState {
    readonly scope: string;
    /** Highest generation observed from a hint, open, or close. */
    generation: number;
    /** A close can arrive before the corresponding view/open notification. */
    closedGeneration?: number;
    active?: {
        readonly generation: number;
        readonly onHint: (nrow: number) => void;
        nrow?: number;
    };
    pending?: PendingHint;
}

/**
 * Correlates row-count notifications with jdv view/open notifications, which
 * travel over separate connections. `scope` should identify both the
 * authenticated sess session and its jdv socket address.
 */
export class JdvRowCountHints {
    private readonly views = new Map<string, ViewState>();

    constructor(
        private readonly maxPending = 128,
        private readonly maxMetadata = 512,
    ) {
        if (!Number.isInteger(maxPending) || maxPending < 0 ||
            !Number.isInteger(maxMetadata) || maxMetadata < 0) {
            throw new RangeError('Row-count hint bounds must be non-negative integers.');
        }
    }

    /** Receive a hint, buffering it if the matching view has not opened yet. */
    hint(scope: string, view: string, generation: number, nrow: number): void {
        if (!validGeneration(generation) || !validRowCount(nrow)) { return; }
        const key = viewKey(scope, view);
        const state = this.get(key);
        if (!state) {
            const created: ViewState = { scope, generation, pending: { generation, nrow } };
            this.set(key, created);
            this.enforceBounds();
            return;
        }
        this.touch(key, state);
        if (generation < state.generation) { return; }
        if (generation === state.generation) {
            if (state.active?.generation === generation) {
                state.active.nrow = nrow;
                state.active.onHint(nrow);
            } else if (state.pending?.generation === generation && state.closedGeneration !== generation) {
                state.pending = { generation, nrow };
            }
            // A hint for a closed generation, or one without a matching open,
            // must not revive the view.
            return;
        }

        state.generation = generation;
        state.pending = { generation, nrow };
        this.enforceBounds();
    }

    /** Register an opened view and return a matching hint buffered earlier. */
    open(
        scope: string,
        view: string,
        generation: number,
        onHint: (nrow: number) => void,
    ): number | undefined {
        if (!validGeneration(generation)) { return undefined; }
        const key = viewKey(scope, view);
        let state = this.get(key);
        if (!state) {
            state = { scope, generation };
            this.set(key, state);
        } else {
            this.touch(key, state);
            if (generation < state.generation || state.closedGeneration === generation) {
                return undefined;
            }
            if (generation > state.generation) {
                state.generation = generation;
            }
        }

        // Opening a newer generation supersedes its older pending hint. A
        // future generation's hint remains buffered until that view opens.
        let nrow: number | undefined;
        if (state.active?.generation === generation) { nrow = state.active.nrow; }
        if (state.pending && state.pending.generation <= generation) {
            if (state.pending.generation === generation) { nrow = state.pending.nrow; }
            state.pending = undefined;
        }
        state.active = { generation, onHint, nrow };
        this.enforceBounds();
        return nrow;
    }

    /** Close only this generation; a delayed close cannot affect a newer one. */
    close(scope: string, view: string, generation: number): void {
        if (!validGeneration(generation)) { return; }
        const key = viewKey(scope, view);
        let state = this.get(key);
        if (!state) {
            state = { scope, generation, closedGeneration: generation };
            this.set(key, state);
            this.enforceBounds();
            return;
        }
        this.touch(key, state);
        if (generation < state.generation) {
            if (state.active?.generation === generation) { state.active = undefined; }
            this.enforceBounds();
            return;
        }
        if (generation > state.generation) { state.generation = generation; }
        state.closedGeneration = generation;
        if (state.active && state.active.generation <= generation) { state.active = undefined; }
        if (state.pending && state.pending.generation <= generation) { state.pending = undefined; }
        this.enforceBounds();
    }

    /** Forget all pending hints and generation metadata for one R session. */
    clear(scope: string): void {
        for (const [key, state] of this.views) {
            if (state.scope === scope) { this.views.delete(key); }
        }
    }

    private get(key: string): ViewState | undefined {
        return this.views.get(key);
    }

    private set(key: string, state: ViewState): void {
        this.views.set(key, state);
    }

    private touch(key: string, state: ViewState): void {
        this.views.delete(key);
        this.views.set(key, state);
    }

    private enforceBounds(): void {
        let pending = 0;
        for (const state of this.views.values()) {
            if (state.pending) { pending++; }
        }
        while (pending > this.maxPending) {
            const oldest = [...this.views.values()].find(state => state.pending !== undefined);
            if (!oldest) { break; }
            oldest.pending = undefined;
            pending--;
        }

        // Live panel callbacks are never evicted. Inactive generation
        // tombstones are LRU-bounded so closed or unopened views cannot grow
        // metadata without limit.
        while (this.views.size > this.maxMetadata) {
            const inactive = [...this.views].find(([, state]) => !state.active);
            if (!inactive) { break; }
            this.views.delete(inactive[0]);
        }
    }
}

function viewKey(scope: string, view: string): string {
    return JSON.stringify([scope, view]);
}

function validGeneration(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}

function validRowCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}
