import { AgentSnapshot, ExecutionRecord, SessionEvent } from './protocol';

export interface TranscriptOutput {
    type: 'stream' | 'condition' | 'display' | 'truncated';
    data: Record<string, unknown>;
}
export interface TranscriptCell {
    generation: string;
    record: ExecutionRecord;
    outputs: TranscriptOutput[];
}

/** Pure replay model: notebook indices and socket incarnations are never execution identity. */
export class Transcript {
    readonly cells = new Map<string, TranscriptCell>();
    seq = 0;

    constructor(readonly generation: string) {}

    restore(snapshot: AgentSnapshot): void {
        this.cells.clear();
        for (const record of snapshot.executions) {
            this.cells.set(record.id, { generation: this.generation, record, outputs: [] });
        }
        for (const event of snapshot.events) {
            this.apply(event, true);
        }
        for (const id of snapshot.truncated ?? []) {
            this.cells.get(id)?.outputs.unshift({
                type: 'truncated',
                data: {
                    message: 'Earlier output is outside the retained history or reconnect window.',
                },
            });
        }
        this.seq = snapshot.seq;
    }

    apply(event: SessionEvent, replay = false): string | undefined {
        if (event.generation !== this.generation || (!replay && event.seq <= this.seq)) {
            return;
        }
        this.seq = Math.max(this.seq, event.seq);
        const id = event.executionId;
        if (!id) {
            return;
        }
        if (event.type === 'accepted' && !this.cells.has(id)) {
            this.cells.set(id, {
                generation: this.generation,
                record: event.data.record as ExecutionRecord,
                outputs: [],
            });
        }
        const cell = this.cells.get(id);
        if (!cell) {
            return;
        }
        if (event.type === 'started' && !replay) {
            cell.record = { ...cell.record, state: 'running', started: event.time };
        } else if (event.type === 'finished' || event.type === 'uncertain') {
            cell.record = event.data.record as ExecutionRecord;
        } else if (event.type === 'stream') {
            const previous = cell.outputs.at(-1);
            if (previous?.type === 'stream' && previous.data.channel === event.data.channel) {
                previous.data.text =
                    (typeof previous.data.text === 'string' ? previous.data.text : '') +
                    (typeof event.data.text === 'string' ? event.data.text : '');
            } else {
                cell.outputs.push({ type: 'stream', data: { ...event.data } });
            }
        } else if (event.type === 'display') {
            const previous = cell.outputs.find(
                (output) =>
                    output.type === 'display' && output.data.displayId === event.data.displayId,
            );
            if (previous) {
                previous.data = event.data;
            } else {
                cell.outputs.push({ type: 'display', data: event.data });
            }
        } else if (event.type === 'condition' || event.type === 'truncated') {
            cell.outputs.push({ type: event.type, data: event.data });
        }
        return id;
    }
}
