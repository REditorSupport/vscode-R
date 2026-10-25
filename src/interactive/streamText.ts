/** A prefix stays readable while more console text arrives. */
export interface StreamSnapshot {
    readonly source: StreamText;
    readonly length: number;
    text(start?: number): string;
}

/** Keep console chunks until delivery instead of flattening every growing prefix. */
export class StreamText {
    private chunks: string[] = [];
    private length = 0;

    constructor(text: string) {
        this.append(text);
    }

    append(text: string): void {
        if (!text) {
            return;
        }
        const last = this.chunks.length - 1;
        // Bound small-write overhead. Replacing a chunk only extends its prefix,
        // so existing snapshots remain valid through their captured length.
        if (last >= 0 && this.chunks[last].length + text.length <= 32768) {
            this.chunks[last] += text;
        } else {
            this.chunks.push(text);
        }
        this.length += text.length;
    }

    snapshot(): StreamSnapshot {
        const chunks = this.chunks;
        const length = this.length;
        return {
            source: this,
            length,
            text(start = 0): string {
                const parts: string[] = [];
                let offset = 0;
                for (const chunk of chunks) {
                    const end = Math.min(offset + chunk.length, length);
                    if (end > start) {
                        parts.push(chunk.slice(Math.max(0, start - offset), end - offset));
                    }
                    offset += chunk.length;
                    if (offset >= length) {
                        break;
                    }
                }
                return parts.join('');
            },
        };
    }

    seal(): void {
        if (this.chunks.length > 1) {
            this.chunks = [this.snapshot().text()];
        }
    }
}
