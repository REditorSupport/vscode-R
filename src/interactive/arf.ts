import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { object, MAX_MESSAGE_BYTES } from './protocol';

export interface ArfSession {
    pid: number;
    socket_path: string;
    cwd?: string;
    r_version?: string;
    started_at?: string;
    session_type?: string;
}

/** arf speaks HTTP JSON-RPC, not sess's JSON Lines framing. */
export function arfRequest(endpoint: string, method: string, params: Record<string, unknown> = {},
    timeout = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const request = http.request({ socketPath: endpoint, path: '/', method: 'POST', agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_MESSAGE_BYTES) { request.destroy(new Error('arf response exceeds size limit')); }
                else { chunks.push(chunk); }
            });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    if (result.error) { reject(new Error(JSON.stringify(result.error))); }
                    else { resolve(result.result); }
                } catch (error) { reject(error); }
            });
        });
        if (timeout > 0) {
            request.setTimeout(timeout, () => request.destroy(new Error('arf request timed out; evaluation may still be running')));
        }
        request.on('error', reject);
        request.end(body);
    });
}

export function discoverArf(): ArfSession[] {
    const root = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
    const directory = path.join(root, 'arf', 'sessions');
    if (!fs.existsSync(directory)) { return []; }
    const sessions: ArfSession[] = [];
    for (const name of fs.readdirSync(directory)) {
        if (!/^\d+\.json$/.test(name)) { continue; }
        try {
            const file = path.join(directory, name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) { continue; }
            const value = object(JSON.parse(fs.readFileSync(file, 'utf8')));
            if (typeof value.pid !== 'number' || typeof value.socket_path !== 'string') { continue; }
            process.kill(value.pid, 0);
            sessions.push(value as unknown as ArfSession);
        } catch { /* A stale discovery file is not a running session. */ }
    }
    return sessions;
}
