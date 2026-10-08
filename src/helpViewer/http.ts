import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { promisify } from 'node:util';
import { gunzip, inflate, inflateRaw, brotliDecompress } from 'node:zlib';

export interface HttpTextResponse {
    status: number;
    url: string;
    text: string;
}

const decompressGzip = promisify(gunzip);
const decompressDeflate = promisify(inflate);
const decompressRawDeflate = promisify(inflateRaw);
const decompressBrotli = promisify(brotliDecompress);

// Both R help servers and private CRAN repositories can use Fetch-blocked ports
// or Basic Auth URLs. Node's HTTP(S) transport preserves access to those URLs.
export async function getHttpText(input: URL | string, redirectsLeft = 20): Promise<HttpTextResponse> {
    let current = new URL(input);
    let authorization: string | undefined;
    while (true) {
        if (!['http:', 'https:'].includes(current.protocol)) {
            throw new Error('Expected an HTTP or HTTPS URL');
        }
        if (current.username || current.password) {
            const credentials = `${decodeURIComponent(current.username)}:${decodeURIComponent(current.password)}`;
            authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
            current.username = '';
            current.password = '';
        }
        const headers: Record<string, string> = { Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' };
        if (authorization) {
            headers.Authorization = authorization;
        }
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const transport = current.protocol === 'https:' ? https : http;
            const request = transport.get(current, { headers }, resolve);
            request.on('error', reject);
        });
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
            response.destroy();
            if (redirectsLeft <= 0) {
                throw new Error('Too many HTTP redirects');
            }
            const next = new URL(location, current);
            // Retain Basic Auth only within an origin; never forward it to a
            // different host/port or on an HTTPS-to-HTTP redirect.
            if (next.origin !== current.origin) {
                authorization = undefined;
            }
            current = next;
            redirectsLeft--;
            continue;
        }
        // Decode after concatenation so multibyte characters survive chunk boundaries.
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
            chunks.push(chunk as Buffer);
        }
        let body: Buffer = Buffer.concat(chunks);
        if (body.length > 0 && status !== 204 && status !== 304) {
            switch (response.headers['content-encoding']?.toLowerCase()) {
                case 'gzip':
                case 'x-gzip':
                    body = await decompressGzip(body);
                    break;
                case 'deflate':
                case 'x-deflate':
                    // Like node-fetch, accept both zlib-wrapped and raw deflate.
                    body = await ((body[0] & 0x0f) === 0x08 ? decompressDeflate(body) : decompressRawDeflate(body));
                    break;
                case 'br':
                    body = await decompressBrotli(body);
                    break;
            }
        }
        return { status, url: current.href, text: body.toString('utf8') };
    }
}
