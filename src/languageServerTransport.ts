import * as net from 'node:net';
import type { DisposableProcess } from './util';

/** Settle TCP startup even when R fails before it can connect to the listener. */
export function connectTcpLanguageServer(
    spawn: (port: number) => DisposableProcess,
    signal?: AbortSignal,
): Promise<{ reader: net.Socket; writer: net.Socket }> {
    return new Promise((resolve, reject) => {
        let child: DisposableProcess | undefined;
        let settled = false;
        const cleanup = () => {
            server.removeListener('error', fail);
            child?.removeListener('error', fail);
            child?.removeListener('exit', exited);
            signal?.removeEventListener('abort', aborted);
        };
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            try {
                child?.dispose();
            } catch (cleanupError) {
                error.cause ??= cleanupError;
            } finally {
                // Wait for close before rejecting so a failed start cannot leave
                // a listening socket behind, including a listen/spawn error.
                server.close(() => reject(error));
            }
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            fail(
                new Error(
                    `R language server exited before connecting ${
                        signal ? `from signal ${signal}` : `with exit code ${code ?? 'null'}`
                    }.`,
                ),
            );
        };
        const aborted = () => {
            const error = new Error('R language server startup was cancelled.');
            error.name = 'AbortError';
            fail(error);
        };
        const server = net.createServer((socket) => {
            if (settled) {
                socket.destroy();
                return;
            }
            settled = true;
            cleanup();
            server.close();
            resolve({ reader: socket, writer: socket });
        });
        server.once('error', fail);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) {
            aborted();
            return;
        }
        server.listen(0, '127.0.0.1', () => {
            try {
                child = spawn((server.address() as net.AddressInfo).port);
                if (settled) {
                    child.dispose();
                    return;
                }
                child.once('error', fail);
                child.once('exit', exited);
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}
