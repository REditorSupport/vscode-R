import * as assert from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import * as sinon from 'sinon';
import { getHttpText, getHttpResponse } from '../../http';

function listen(server: Server, port = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

suite('HTTP(S) help transport', () => {
    let server: Server;
    let origin: string;
    let externalUrl: string;
    const html = '<html>日本語のRヘルプ</html>';

    setup(async () => {
        server = createServer((request, response) => {
            const pathname = new URL(request.url ?? '/', origin).pathname;
            if (pathname === '/stall') {
                response.writeHead(200);
                response.write('partial');
            } else if (pathname.startsWith('/redirect/')) {
                response.writeHead(Number(pathname.split('/')[2]), { Location: '../help?topic=mean' });
                response.end();
            } else if (pathname === '/loop') {
                response.writeHead(302, { Location: '/loop' });
                response.end();
            } else if (pathname === '/external') {
                response.writeHead(302, { Location: externalUrl });
                response.end();
            } else if (pathname === '/truncated') {
                response.writeHead(200, { 'Content-Length': 100 });
                response.write('partial');
                setImmediate(() => response.destroy());
            } else if (pathname === '/missing') {
                response.writeHead(404);
                response.end('Not found');
            } else if (pathname.startsWith('/compressed/')) {
                const encoding = pathname.split('/')[2];
                const compressors: Record<string, (input: string) => Buffer> = {
                    gzip: gzipSync, deflate: deflateSync, raw: deflateRawSync, br: brotliCompressSync
                };
                response.writeHead(200, { 'Content-Encoding': encoding === 'raw' ? 'deflate' : encoding });
                response.end(compressors[encoding](html));
            } else if (pathname === '/invalid-gzip') {
                response.writeHead(200, { 'Content-Encoding': 'gzip' });
                response.end('invalid');
            } else if (pathname === '/empty-gzip') {
                response.writeHead(204, { 'Content-Encoding': 'gzip' });
                response.end();
            } else {
                const body = Buffer.from(html);
                response.write(body.subarray(0, 8));
                setImmediate(() => response.end(body.subarray(8)));
            }
        });
        await listen(server);
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    teardown(async () => { await close(server); });

    test('aborts a pending response body and enforces the request timeout', async () => {
        const controller = new AbortController();
        const request = getHttpResponse(new URL('/stall', origin), { signal: controller.signal });
        const timer = setTimeout(() => controller.abort(), 20);
        try { await assert.rejects(request, /abort/i); }
        finally { clearTimeout(timer); }
        await assert.rejects(getHttpResponse(new URL('/stall', origin), { timeoutMs: 20 }), /aborted|timed out/i);
        await assert.rejects(getHttpResponse(new URL('/help', origin), { signal: controller.signal }), /abort/i);
    });
    test('does not forward the httpgd token or cookies to another origin', async () => {
        let headers: http.IncomingHttpHeaders = {};
        const external = createServer((request, response) => { headers = request.headers; response.end('ok'); });
        await listen(external);
        externalUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}/help`;
        try {
            const response = await getHttpResponse(new URL('/external', origin), {
                headers: { 'X-HTTPGD-TOKEN': 'secret', Cookie: 'session=secret' }
            });
            assert.strictEqual(response.body.toString(), 'ok');
            assert.strictEqual(headers['x-httpgd-token'], undefined);
            assert.strictEqual(headers.cookie, undefined);
        } finally { await close(external); }
    });
    test('collects UTF-8 HTML even when a character spans response chunks', async () => {
        const url = new URL('/help', origin);
        assert.deepStrictEqual(await getHttpText(url), { status: 200, url: url.href, text: html });
    });
    test('follows relative redirects and retains the final URL and query', async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const response = await getHttpText(new URL(`/redirect/${status}`, origin));
            assert.deepStrictEqual(response, { status: 200, url: `${origin}/help?topic=mean`, text: html });
        }
    });
    test('preserves unsuccessful status codes', async () => {
        const response = await getHttpText(new URL('/missing', origin));
        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.text, 'Not found');
    });
    test('decodes gzip, deflate, raw deflate and Brotli responses', async () => {
        for (const encoding of ['gzip', 'deflate', 'raw', 'br']) {
            const response = await getHttpText(new URL(`/compressed/${encoding}`, origin));
            assert.strictEqual(response.text, html);
        }
        const empty = await getHttpText(new URL('/empty-gzip', origin));
        assert.strictEqual(empty.status, 204);
        assert.strictEqual(empty.text, '');
        await assert.rejects(getHttpText(new URL('/invalid-gzip', origin)));
    });
    test('rejects redirect loops and non-HTTP redirects', async () => {
        await assert.rejects(getHttpText(new URL('/loop', origin)), /Too many/);
        externalUrl = 'file:///tmp/help.html';
        await assert.rejects(getHttpText(new URL('/external', origin)), /HTTP or HTTPS/);
    });
    test('follows the Windows FAQ redirect using the HTTPS transport', async () => {
        externalUrl = 'https://cran.r-project.org/bin/windows/base/rw-FAQ.html';
        // Route the HTTPS transport call to the local fixture, without accessing CRAN.
        const httpsGet = sinon.stub(https, 'get').callsFake((_url, options, callback) =>
            http.get(new URL('/help', origin), options, callback));
        try {
            const response = await getHttpText(new URL('/external', origin));
            assert.deepStrictEqual(response, { status: 200, url: externalUrl, text: html });
            assert.strictEqual(httpsGet.callCount, 1);
            const fetchedUrl = httpsGet.firstCall.args[0];
            assert.ok(fetchedUrl instanceof URL);
            assert.strictEqual(fetchedUrl.href, externalUrl);
        } finally {
            httpsGet.restore();
        }
    });
    test('follows external redirects, decompresses HTML and retains the final URL', async () => {
        const external = createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { Location: '/manual' });
                response.end();
            } else {
                response.writeHead(200, { 'Content-Encoding': 'gzip' });
                response.end(gzipSync(html));
            }
        });
        await listen(external);
        const externalOrigin = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
        externalUrl = `${externalOrigin}/redirect`;
        try {
            assert.deepStrictEqual(await getHttpText(new URL('/external', origin)), {
                status: 200, url: `${externalOrigin}/manual`, text: html
            });
        } finally {
            await close(external);
        }
    });
    test('rejects non-HTTP initial URLs', async () => {
        await assert.rejects(getHttpText('file:///tmp/help.html'), /HTTP or HTTPS/);
    });
    test('rejects truncated responses and connection errors', async () => {
        await assert.rejects(getHttpText(new URL('/truncated', origin)));
        const temporary = createServer();
        await listen(temporary);
        const port = (temporary.address() as AddressInfo).port;
        await close(temporary);
        await assert.rejects(getHttpText(new URL(`http://127.0.0.1:${port}/`)));
    });
    test('loads help HTML and follows a redirect on Fetch-blocked port 10080', async function () {
        const blockedPortServer = createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(302, { Location: '/help' });
                response.end();
            } else {
                response.end(html);
            }
        });
        try {
            await listen(blockedPortServer, 10080);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                this.skip();
                return;
            }
            throw error;
        }
        try {
            const url = new URL('http://127.0.0.1:10080/help');
            assert.deepStrictEqual(await getHttpText(url), { status: 200, url: url.href, text: html });
            assert.deepStrictEqual(await getHttpText(new URL('/redirect', url)), {
                status: 200, url: url.href, text: html
            });
        } finally {
            await close(blockedPortServer);
        }
    });
});
