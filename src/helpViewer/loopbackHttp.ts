import { get, IncomingMessage } from 'node:http';

export interface LocalHttpResponse {
    status: number;
    url: string;
    text: string;
}

// R's help server can use ports forbidden by Fetch, including 10080.
// Keep this transport scoped to the same loopback origin, including redirects.
export async function getLoopbackHttp(url: URL, redirectsLeft = 5): Promise<LocalHttpResponse> {
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
        || url.username || url.password) {
        throw new Error('Expected a loopback HTTP URL without credentials');
    }
    const origin = url.origin;
    let current = url;
    while (true) {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const request = get(current, resolve);
            request.on('error', reject);
        });
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
            // Release the response/socket before following or rejecting a redirect.
            response.destroy();
            if (redirectsLeft <= 0) {
                throw new Error('Too many loopback HTTP redirects');
            }
            const next = new URL(location, current);
            if (next.origin !== origin || next.username || next.password) {
                throw new Error('Loopback HTTP redirect must stay on the same origin');
            }
            current = next;
            redirectsLeft--;
            continue;
        }
        // Decode after concatenation so a multibyte character split across chunks survives.
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
            chunks.push(chunk as Buffer);
        }
        return { status, url: current.href, text: Buffer.concat(chunks).toString('utf8') };
    }
}
