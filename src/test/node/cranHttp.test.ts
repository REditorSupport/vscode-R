import * as assert from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { fetchWithBasicAuth } from '../../helpViewer/fetch';
import { getPackagesFromCran } from '../../helpViewer/cran';

function listen(server: Server): Promise<string> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
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
        const response = await fetchWithBasicAuth(url);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(await response.text(), 'authenticated');
        assert.strictEqual(requests[0].authorization, authorization);
        assert.strictEqual(url.href, original);
        assert.strictEqual(response.url, `${origin}/authenticated`);
    });
    test('retains authentication for a same-origin redirect', async () => {
        const response = await fetchWithBasicAuth(authenticatedUrl('/same-origin'));
        assert.strictEqual(await response.text(), 'authenticated');
        assert.strictEqual(response.url, `${origin}/authenticated`);
        assert.deepStrictEqual(requests.map(request => request.authorization), [authorization, authorization]);
    });
    test('does not forward authentication to another origin', async () => {
        const response = await fetchWithBasicAuth(authenticatedUrl('/cross-origin'));
        assert.strictEqual(await response.text(), 'external');
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
    test('keeps ordinary URLs free of an Authorization header', async () => {
        const response = await fetchWithBasicAuth(`${origin}/unauthenticated`);
        assert.strictEqual(response.status, 401);
        await response.text();
        assert.strictEqual(requests[0].authorization, undefined);
    });
});
