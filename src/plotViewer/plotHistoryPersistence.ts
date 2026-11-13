import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import { PersistentPlotCache, PersistentPlotReference } from './persistentPlotCache';
import { isPlotFrame, PlotHistoryState } from './jgdPlotHistory';
import type { HttpgdHistoryState } from './httpgdTypes';

type JgdCheckpoint = PlotHistoryState & { checkpointId?: string };
type JgdMetadata = Omit<JgdCheckpoint, 'sessions'> & {
    cacheVersion: 1;
    sessions: Array<
        Omit<JgdCheckpoint['sessions'][number], 'plots'> & {
            plots: PersistentPlotReference[];
        }
    >;
};
type HttpgdMetadata = Omit<HttpgdHistoryState, 'plots'> & {
    cacheVersion: 1;
    plots: PersistentPlotReference[];
};
type Position = { deviceId: string; currentIndex: number };

/** Saves and restores plot history across reloads; viewers render from their own in-memory history.
 * Payloads live in the workspace's extension storage, never in the project directory.
 */
export class PlotHistoryPersistence {
    private readonly cache: PersistentPlotCache;

    constructor(private readonly context: Pick<ExtensionContext, 'storageUri' | 'workspaceState'>) {
        const directory = context.storageUri?.fsPath;
        this.cache = new PersistentPlotCache(
            directory ? path.join(directory, 'plot-cache') : undefined,
        );
        const jgd = context.workspaceState.get<JgdMetadata>('r.plot.jgdState');
        const httpgd =
            context.workspaceState.get<Record<string, HttpgdMetadata>>('r.plot.httpgdHistory');
        this.cache.register(
            'jgd',
            jgd?.cacheVersion === 1
                ? jgd.sessions.flatMap((session) => session.plots.map((plot) => plot.cacheKey))
                : [],
        );
        this.cache.register(
            'httpgd',
            Object.values(httpgd ?? {}).flatMap((history) =>
                history?.cacheVersion === 1 ? history.plots.map((plot) => plot.cacheKey) : [],
            ),
        );
    }

    async readJgd(
        value: JgdCheckpoint | JgdMetadata | undefined,
        positions?: unknown,
    ): Promise<{
        state: JgdCheckpoint | undefined;
        positions: unknown;
        changed: boolean;
    }> {
        if (!value || !('cacheVersion' in value) || value.cacheVersion !== 1) {
            return { state: value as JgdCheckpoint | undefined, positions, changed: !!value };
        }
        let changed = false;
        const mappings = new Map<string, number[]>();
        const sessions: PlotHistoryState['sessions'] = [];
        for (const session of value.sessions) {
            const plots: PlotHistoryState['sessions'][number]['plots'] = [];
            const indices: number[] = [];
            for (const [index, reference] of session.plots.entries()) {
                const plot = await this.cache.read(reference);
                if (isPlotFrame(plot)) {
                    plots.push(plot);
                    indices.push(index);
                } else {
                    changed = true;
                }
            }
            mappings.set(session.id, indices);
            sessions.push({
                ...session,
                plots,
                currentIndex: remapIndex(session.currentIndex, indices),
                latestDeleted:
                    session.latestDeleted ||
                    (session.plots.length > 0 && !indices.includes(session.plots.length - 1)),
            });
        }
        const selections = new Map<string, number>();
        if (Array.isArray(positions)) {
            for (const position of positions as Position[]) {
                if (
                    position &&
                    typeof position.deviceId === 'string' &&
                    Number.isInteger(position.currentIndex)
                ) {
                    selections.set(position.deviceId, position.currentIndex);
                }
            }
        }
        const remappedPositions: Position[] = [];
        const timelines = value.timelines?.map((timeline) => {
            const indices: number[] = [];
            const plots = timeline.plots.flatMap((ref, index) => {
                const mapped = mappings.get(ref.deviceId)?.indexOf(ref.index) ?? -1;
                if (mapped < 0) {
                    return [];
                }
                indices.push(index);
                return [{ deviceId: ref.deviceId, index: mapped }];
            });
            remappedPositions.push({
                deviceId: timeline.deviceId,
                currentIndex: remapIndex(
                    selections.get(timeline.deviceId) ?? timeline.currentIndex,
                    indices,
                ),
            });
            return { ...timeline, plots, currentIndex: remapIndex(timeline.currentIndex, indices) };
        });
        return {
            state: { ...value, sessions, timelines },
            positions: timelines ? remappedPositions : positions,
            changed,
        };
    }

    writeJgd(state: JgdCheckpoint): Promise<void> {
        return this.cache.write(
            'jgd',
            async (put): Promise<JgdMetadata> => {
                const sessions: JgdMetadata['sessions'] = [];
                // Write in timeline order so eviction retains newer plots across devices.
                const references = new Map<object, PersistentPlotReference>();
                for (const timeline of state.timelines ?? []) {
                    for (const ref of timeline.plots) {
                        const plot = state.sessions.find((session) => session.id === ref.deviceId)
                            ?.plots[ref.index];
                        if (plot) {
                            references.set(plot, await put(plot));
                        }
                    }
                }
                for (const session of state.sessions) {
                    const plots: PersistentPlotReference[] = [];
                    for (const plot of session.plots) {
                        plots.push(references.get(plot) ?? (await put(plot)));
                    }
                    sessions.push({ ...session, plots });
                }
                return { ...state, cacheVersion: 1, sessions };
            },
            (metadata) => this.context.workspaceState.update('r.plot.jgdState', metadata),
        );
    }

    async readHttpgd(value: unknown): Promise<unknown> {
        if (!value || typeof value !== 'object') {
            return value;
        }
        const histories: Record<string, unknown> = {};
        for (const [id, history] of Object.entries(value as Record<string, HttpgdMetadata>)) {
            if (history?.cacheVersion !== 1) {
                histories[id] = history;
                continue;
            }
            const plots: unknown[] = [];
            for (const reference of history.plots) {
                const plot = await this.cache.read(reference);
                if (plot) {
                    plots.push(plot);
                }
            }
            histories[id] = { ...history, plots };
        }
        return histories;
    }

    writeHttpgd(histories: ReadonlyMap<string, HttpgdHistoryState>): Promise<void> {
        return this.cache.write(
            'httpgd',
            async (put) => {
                const metadata: Record<string, HttpgdMetadata> = {};
                for (const [id, history] of histories) {
                    const plots: PersistentPlotReference[] = [];
                    for (const plot of history.plots) {
                        plots.push(await put(plot));
                    }
                    metadata[id] = { ...history, cacheVersion: 1, plots };
                }
                return metadata;
            },
            (metadata) => this.context.workspaceState.update('r.plot.httpgdHistory', metadata),
        );
    }
}

function remapIndex(index: number, retained: number[]): number {
    if (!retained.length) {
        return -1;
    }
    const next = retained.findIndex((old) => old > index);
    return next < 0 ? retained.length - 1 : Math.max(0, next - 1);
}
