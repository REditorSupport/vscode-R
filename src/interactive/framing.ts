import { StringDecoder } from 'string_decoder';
import { MAX_MESSAGE_BYTES, object } from './protocol';

/** Preserve split UTF-8 characters and reject oversized unterminated frames. */
export class JsonLines {
    private decoder = new StringDecoder('utf8');
    private parts: string[] = [];
    private bytes = 0;

    constructor(
        private readonly receive: (message: Record<string, unknown>) => void,
        private readonly limit = MAX_MESSAGE_BYTES,
    ) {}

    push(chunk: Buffer): void {
        const text = this.decoder.write(chunk);
        let start = 0;
        let end: number;
        // Search and count only newly decoded text. Rescanning an incomplete
        // workspace/table frame on each socket read makes fragmented input quadratic.
        while ((end = text.indexOf('\n', start)) >= 0) {
            this.append(text.slice(start, end));
            const line = this.parts.join('');
            this.parts = [];
            this.bytes = 0;
            if (line.trim()) {
                this.receive(object(JSON.parse(line)));
            }
            start = end + 1;
        }
        this.append(text.slice(start));
    }

    private append(text: string): void {
        this.bytes += Buffer.byteLength(text);
        if (this.bytes > this.limit) {
            throw new Error('IPC frame exceeds size limit');
        }
        if (text) {
            // Bound fragment bookkeeping for peers which split every character.
            const last = this.parts.length - 1;
            if (last >= 0 && this.parts[last].length + text.length <= 32768) {
                this.parts[last] += text;
            } else {
                this.parts.push(text);
            }
        }
    }
}
