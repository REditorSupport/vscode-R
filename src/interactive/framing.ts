import { StringDecoder } from 'string_decoder';
import { MAX_MESSAGE_BYTES, object } from './protocol';

/** Preserve split UTF-8 characters and reject oversized unterminated frames. */
export class JsonLines {
    private decoder = new StringDecoder('utf8');
    private buffer = '';

    constructor(
        private readonly receive: (message: Record<string, unknown>) => void,
        private readonly limit = MAX_MESSAGE_BYTES,
    ) {}

    push(chunk: Buffer): void {
        this.buffer += this.decoder.write(chunk);
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end + 1);
            if (Buffer.byteLength(line) > this.limit) {
                throw new Error('IPC frame exceeds size limit');
            }
            if (line.trim()) {
                this.receive(object(JSON.parse(line)));
            }
        }
        if (Buffer.byteLength(this.buffer) > this.limit) {
            throw new Error('IPC frame exceeds size limit');
        }
    }
}
