import * as assert from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { getLoopbackHttp } from '../../helpViewer/loopbackHttp';

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

suite('R help loopback HTTP', () => {
    let server: Server;
    let origin: string;
    const html = '<html>日本語のRヘルプ</html>';

    setup(async () => {
        server = createServer((request, response) => {
            const pathname = new URL(request.url ?? '/', origin).pathname;
            if (pathname.startsWith('/redirect/')) {
                response.writeHead(Number(pathname.split('/')[2]), { Location: '../help?topic=mean' });
                response.end();
            } else if (pathname === '/loop') {
                response.writeHead(302, { Location: '/loop' });
                response.end();
            } else if (pathname === '/external' || pathname === '/other-port') {
                const location = pathname === '/external' ? 'http://example.com/help' : 'http://127.0.0.1:1/help';
                response.writeHead(302, { Location: location });
                response.end();
            } else if (pathname === '/truncated') {
                response.writeHead(200, { 'Content-Length': 100 });
                response.write('partial');
                setImmediate(() => response.destroy());
            } else if (pathname === '/missing') {
                response.writeHead(404);
                response.end('Not found');
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

    test('collects UTF-8 HTML even when a character spans response chunks', async () => {
        const url = new URL('/help', origin);
        assert.deepStrictEqual(await getLoopbackHttp(url), { status: 200, url: url.href, text: html });
    });
    test('follows relative redirects and retains the final URL and query', async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const response = await getLoopbackHttp(new URL(`/redirect/${status}`, origin));
            assert.deepStrictEqual(response, { status: 200, url: `${origin}/help?topic=mean`, text: html });
        }
    });
    test('preserves unsuccessful status codes', async () => {
        const response = await getLoopbackHttp(new URL('/missing', origin));
        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.text, 'Not found');
    });
    test('rejects redirect loops, external hosts and other loopback ports', async () => {
        await assert.rejects(getLoopbackHttp(new URL('/loop', origin)), /Too many/);
        for (const path of ['/external', '/other-port']) {
            await assert.rejects(getLoopbackHttp(new URL(path, origin)), /same origin/);
        }
    });
    test('rejects non-loopback, non-HTTP and credential-bearing initial URLs', async () => {
        for (const url of ['http://example.com/', 'https://127.0.0.1/', 'http://user@127.0.0.1/']) {
            await assert.rejects(getLoopbackHttp(new URL(url)), /Expected a loopback/);
        }
    });
    test('rejects truncated responses and connection errors', async () => {
        await assert.rejects(getLoopbackHttp(new URL('/truncated', origin)));
        const temporary = createServer();
        await listen(temporary);
        const port = (temporary.address() as AddressInfo).port;
        await close(temporary);
        await assert.rejects(getLoopbackHttp(new URL(`http://127.0.0.1:${port}/`)));
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
            assert.deepStrictEqual(await getLoopbackHttp(url), { status: 200, url: url.href, text: html });
            assert.deepStrictEqual(await getLoopbackHttp(new URL('/redirect', url)), {
                status: 200, url: url.href, text: html
            });
        } finally {
            await close(blockedPortServer);
        }
    });
});
