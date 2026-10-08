// Native Fetch rejects credentials in URLs, but private CRAN repositories may
// use Basic Auth URLs. Move userinfo into a header before calling Fetch; Fetch
// also removes Authorization when following a redirect to a different origin.
export function fetchWithBasicAuth(input: URL | string): Promise<Response> {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    if (url.username || url.password) {
        const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
        headers.Authorization = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
        url.username = '';
        url.password = '';
    }
    return fetch(url, { headers });
}
