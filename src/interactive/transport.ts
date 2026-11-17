import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createHash } from 'crypto';

/** Endpoint names are transport addresses, never evidence that an agent is alive. */
export function localEndpoint(
    directory: string,
    name: string,
    platform = process.platform,
): string {
    if (platform === 'win32') {
        const identity = createHash('sha256').update(directory).digest('hex').slice(0, 32);
        return `\\\\.\\pipe\\vscode-r-${identity}-${name}`;
    }
    return path.join(directory, name);
}

export async function listenLocal(server: net.Server, endpoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    if (process.platform !== 'win32') {
        fs.chmodSync(endpoint, 0o600);
    }
}
