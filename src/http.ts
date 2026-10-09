import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { promisify } from 'node:util';
import { gunzip, inflate, inflateRaw, brotliDecompress } from 'node:zlib';

export interface HttpTextResponse {
    status: number;
    url: string;
    text: string;
}

export interface HttpResponse {
    status: number;
    url: string;
    body: Buffer;
}

export interface HttpRequestOptions {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
}

const decompressGzip = promisify(gunzip);
const decompressDeflate = promisify(inflate);
const decompressRawDeflate = promisify(inflateRaw);
const decompressBrotli = promisify(brotliDecompress);

// R help/httpgd servers and private CRAN repositories can use Fetch-blocked ports
// or Basic Auth URLs. Node's HTTP(S) transport preserves access to those URLs.
export async function getHttpText(input: URL | string, redirectsLeft = 20): Promise<HttpTextResponse> {
    const response = await getHttpResponse(input, {}, redirectsLeft);
    return { status: response.status, url: response.url, text: response.body.toString('utf8') };
}

export async function getHttpResponse(input: URL | string, options: HttpRequestOptions = {}, redirectsLeft = 20): Promise<HttpResponse> {
    let current = new URL(input);
    const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br' };
    for (const [name, value] of Object.entries(options.headers ?? {})) {
        headers[name.toLowerCase()] = value;
    }
    while (true) {
        options.signal?.throwIfAborted();
        if (!['http:', 'https:'].includes(current.protocol)) {
            throw new Error('Expected an HTTP or HTTPS URL');
        }
        if (current.username || current.password) {
            const credentials = `${decodeURIComponent(current.username)}:${decodeURIComponent(current.password)}`;
            headers.authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
            current.username = '';
            current.password = '';
        }
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const transport = current.protocol === 'https:' ? https : http;
            const request = transport.get(current, { headers, signal: options.signal }, resolve);
            request.on('error', reject);
            if (options.timeoutMs) {
                request.setTimeout(options.timeoutMs, () => request.destroy(new Error('HTTP request timed out')));
            }
        });
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
            response.destroy();
            if (redirectsLeft <= 0) {
                throw new Error('Too many HTTP redirects');
            }
            const next = new URL(location, current);
            // Retain credentials only within an origin; never forward them to a
            // different host/port or on an HTTPS-to-HTTP redirect.
            if (next.origin !== current.origin) {
                delete headers.authorization;
                delete headers.cookie;
                delete headers['x-httpgd-token'];
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
        options.signal?.throwIfAborted();
        return { status, url: current.href, body };
    }
}
