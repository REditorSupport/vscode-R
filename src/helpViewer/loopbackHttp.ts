import { get, IncomingMessage } from 'node:http';
import { fetchWithBasicAuth } from './fetch';

export interface LocalHttpResponse {
    status: number;
    url: string;
    text: string;
}

// R's help server can use ports forbidden by Fetch, including 10080.
// Use this transport for the initial loopback origin; delegate other HTTP(S)
// origins to Fetch so it handles external redirects and compressed responses.
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
            if (!['http:', 'https:'].includes(next.protocol)) {
                throw new Error('R help redirect must use HTTP or HTTPS');
            }
            if (next.origin !== origin || next.username || next.password) {
                // tools::startDynamicHelp() redirects to CRAN when a Windows FAQ
                // or manual is not installed locally (tools/R/dynamicHelp.R).
                // Rejecting external redirects would break those help pages.
                const external = await fetchWithBasicAuth(next);
                return { status: external.status, url: external.url, text: await external.text() };
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
