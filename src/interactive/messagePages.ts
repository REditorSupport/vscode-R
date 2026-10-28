import { randomUUID } from 'crypto';

export interface MessagePageReference {
    __rInteractivePage: { token: string; bytes: number };
}
export interface MessagePage {
    offset: number;
    next: number;
    data: string;
}
export function pageReference(
    value: unknown,
): MessagePageReference['__rInteractivePage'] | undefined {
    if (!value || typeof value !== 'object') {
        return;
    }
    const page = (value as Partial<MessagePageReference>).__rInteractivePage;
    return page &&
        typeof page.token === 'string' &&
        Number.isSafeInteger(page.bytes) &&
        page.bytes >= 0
        ? page
        : undefined;
}

/** Stop serialization before an unexpected payload can create an unbounded scratch buffer. */
export function boundedJson(value: unknown, limit = 64 * 1024 * 1024): string {
    let size = 0;
    return JSON.stringify(value, (key: string, item: unknown) => {
        size += key ? Buffer.byteLength(JSON.stringify(key)) + 1 : 0;
        size += 2;
        if (typeof item === 'string') {
            if (Buffer.byteLength(item) > limit) {
                throw new Error('Message exceeds the 64 MiB paging limit');
            }
            size += Buffer.byteLength(JSON.stringify(item));
        } else if (typeof item === 'number' || typeof item === 'boolean' || item === null) {
            size += String(item).length;
        }
        if (size > limit) {
            throw new Error('Message exceeds the 64 MiB paging limit');
        }
        return item;
    });
}

/** Pull pages rather than flooding a socket with a large snapshot or workspace event. */
export class MessagePages {
    private pages = new Map<string, { bytes: Buffer; expires: number }>();
    private total = 0;
    retain(value: unknown): MessagePageReference {
        this.expire();
        const bytes = Buffer.from(boundedJson(value));
        if (this.pages.size >= 4 || this.total + bytes.length > 64 * 1024 * 1024) {
            throw new Error(
                'Too many large messages are pending; retry after the current read finishes',
            );
        }
        const token = randomUUID();
        this.pages.set(token, { bytes, expires: Date.now() + 30000 });
        this.total += bytes.length;
        return { __rInteractivePage: { token, bytes: bytes.length } };
    }
    read(token: string, offset: number): MessagePage {
        this.expire();
        const stored = this.pages.get(token);
        if (
            !stored ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset >= stored.bytes.length
        ) {
            throw new Error(
                'Message page expired or has an invalid cursor; request a fresh snapshot',
            );
        }
        stored.expires = Date.now() + 30000;
        const next = Math.min(offset + 512 * 1024, stored.bytes.length);
        const result = {
            offset,
            next,
            data: stored.bytes.subarray(offset, next).toString('base64'),
        };
        if (next === stored.bytes.length) {
            this.pages.delete(token);
            this.total -= stored.bytes.length;
        }
        return result;
    }
    expire(): void {
        for (const [token, stored] of this.pages) {
            if (stored.expires <= Date.now()) {
                this.pages.delete(token);
                this.total -= stored.bytes.length;
            }
        }
    }
}
