import * as assert from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { getHttpText } from '../../helpViewer/http';
import { getPackagesFromCran } from '../../helpViewer/cran';

function listen(server: Server, port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

suite('CRAN HTTP authentication', () => {
    let server: Server;
    let external: Server;
    let origin: string;
    let externalOrigin: string;
    let requests: { path: string; authorization?: string }[];
    let externalAuthorization: string | undefined;
    const authorization = `Basic ${Buffer.from('user:p@ss:word').toString('base64')}`;

    setup(async () => {
        requests = [];
        externalAuthorization = undefined;
        external = createServer((request, response) => {
            externalAuthorization = request.headers.authorization;
            response.end('external');
        });
        externalOrigin = await listen(external);
        server = createServer((request, response) => {
            const path = request.url ?? '/';
            requests.push({ path, authorization: request.headers.authorization });
            if (path === '/same-origin' || path === '/cross-origin') {
                response.writeHead(302, { Location: path === '/same-origin' ? '/authenticated' : externalOrigin });
                response.end();
            } else if (request.headers.authorization !== authorization) {
                response.writeHead(401);
                response.end();
            } else if (path === '/repo/web/packages/available_packages_by_date.html') {
                response.writeHead(404);
                response.end('Not found');
            } else if (path === '/repo/src/contrib/PACKAGES') {
                response.end('Package: privatePackage\nVersion: 1.0.0\n');
            } else {
                response.end('authenticated');
            }
        });
        origin = await listen(server);
    });
    teardown(async () => { await Promise.all([close(server), close(external)]); });

    function authenticatedUrl(path: string): URL {
        const url = new URL(path, origin);
        url.username = 'user';
        url.password = 'p@ss:word';
        return url;
    }

    test('decodes URL credentials into Basic Auth without mutating the caller URL', async () => {
        const url = authenticatedUrl('/authenticated');
        const original = url.href;
        const response = await getHttpText(url);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.text, 'authenticated');
        assert.strictEqual(requests[0].authorization, authorization);
        assert.strictEqual(url.href, original);
        assert.strictEqual(response.url, `${origin}/authenticated`);
    });
    test('retains authentication for a same-origin redirect', async () => {
        const response = await getHttpText(authenticatedUrl('/same-origin'));
        assert.strictEqual(response.text, 'authenticated');
        assert.strictEqual(response.url, `${origin}/authenticated`);
        assert.deepStrictEqual(requests.map(request => request.authorization), [authorization, authorization]);
    });
    test('does not forward authentication to another origin', async () => {
        const response = await getHttpText(authenticatedUrl('/cross-origin'));
        assert.strictEqual(response.text, 'external');
        assert.strictEqual(requests[0].authorization, authorization);
        assert.strictEqual(externalAuthorization, undefined);
    });
    test('loads the package index from a private CRAN repository', async () => {
        assert.deepStrictEqual(await getPackagesFromCran(authenticatedUrl('/repo/').href), [{
            name: 'privatePackage', description: '', isCran: true
        }]);
        assert.deepStrictEqual(requests.map(request => request.path), [
            '/repo/web/packages/available_packages_by_date.html', '/repo/src/contrib/PACKAGES'
        ]);
        assert.ok(requests.every(request => request.authorization === authorization));
    });
    test('loads an authenticated CRAN index on port 10080 with redirects and compression', async function () {
        const seen: (string | undefined)[] = [];
        const blockedPortServer = createServer((request, response) => {
            seen.push(request.headers.authorization);
            if (request.headers.authorization !== authorization) {
                response.writeHead(401);
                response.end();
            } else if (request.url?.endsWith('available_packages_by_date.html')) {
                response.writeHead(404);
                response.end();
            } else if (request.url === '/repo/src/contrib/PACKAGES') {
                response.writeHead(302, { Location: '/index' });
                response.end();
            } else {
                response.writeHead(200, { 'Content-Encoding': 'gzip' });
                response.end(gzipSync('Package: privatePackage\nVersion: 1.0.0\n'));
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
            const url = new URL('http://127.0.0.1:10080/repo/');
            url.username = 'user';
            url.password = 'p@ss:word';
            assert.deepStrictEqual(await getPackagesFromCran(url.href), [{
                name: 'privatePackage', description: '', isCran: true
            }]);
            assert.deepStrictEqual(seen, [authorization, authorization, authorization]);
        } finally {
            await close(blockedPortServer);
        }
    });
    test('keeps ordinary URLs free of an Authorization header', async () => {
        const response = await getHttpText(`${origin}/unauthenticated`);
        assert.strictEqual(response.status, 401);
        assert.strictEqual(requests[0].authorization, undefined);
    });
});
