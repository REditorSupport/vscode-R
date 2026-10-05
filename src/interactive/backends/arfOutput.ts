import { MAX_MESSAGE_BYTES, object } from '../protocol';

/** R events are delimited and authenticated; ordinary console bytes remain text. */
export class ArfOutput {
    private pending = '';
    private prefix: string;
    constructor(token: string, private output: (text: string) => void,
        private event: (message: Record<string, unknown>) => void) { this.prefix = `\x1e${token}:`; }
    push(text: string): void {
        this.pending += text;
        for (;;) {
            const start = this.pending.indexOf(this.prefix);
            if (start < 0) {
                let keep = Math.min(this.pending.length, this.prefix.length - 1);
                while (keep && !this.prefix.startsWith(this.pending.slice(-keep))) { keep--; }
                this.output(this.pending.slice(0, this.pending.length - keep));
                this.pending = this.pending.slice(this.pending.length - keep);
                return;
            }
            if (start) { this.output(this.pending.slice(0, start)); this.pending = this.pending.slice(start); }
            const end = this.pending.indexOf('\x1f', this.prefix.length);
            if (end < 0) {
                if (this.pending.length > MAX_MESSAGE_BYTES) { throw new Error('arf event exceeds size limit'); }
                return;
            }
            const encoded = this.pending.slice(this.prefix.length, end);
            this.pending = this.pending.slice(end + 1);
            if (encoded.length > MAX_MESSAGE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { throw new Error('Invalid arf event'); }
            this.event(object(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))));
        }
    }
}
