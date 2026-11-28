import { WebR } from 'webr';
import type { Message } from 'vscode-jsonrpc';
import { downloadWebRAsset, type LoadWebRAsset } from './assets';
import packages from './packages.json';
import serverModules from './serverModules.json';

export interface WebRLanguageSession {
    dispatch(message: Message): Promise<Message[]>;
    close(): void;
}

/** A language worker has its own package library and never shares the user's evaluation session. */
export async function createWebRLanguageSession(options: {
    baseUrl: string;
    signal?: AbortSignal;
    loadAsset?: LoadWebRAsset;
}): Promise<WebRLanguageSession> {
    const { signal, loadAsset = downloadWebRAsset } = options;
    signal?.throwIfAborted();
    const runtime = new WebR({ baseUrl: options.baseUrl, interactive: false });
    const lifetime = new AbortController();
    const close = () => {
        if (!lifetime.signal.aborted) {
            lifetime.abort();
            runtime.close();
        }
    };
    signal?.addEventListener('abort', close, { once: true });
    try {
        await runtime.init();
        await runtime.FS.mkdir('/language-library');
        // Keep peak memory bounded while downloading packages concurrently.
        for (let first = 0; first < packages.length; first += 4) {
            const batch = await Promise.all(
                packages.slice(first, first + 4).map(async (asset) => ({
                    bytes: await loadAsset(asset, lifetime.signal),
                })),
            );
            for (const { bytes } of batch) {
                await runtime.FS.writeFile('/tmp/pkg.tgz', bytes);
                await runtime.evalRVoid(
                    'utils::untar("/tmp/pkg.tgz", exdir = "/language-library", tar = "internal")',
                );
            }
        }
        await runtime.FS.unlink('/tmp/pkg.tgz');
        await runtime.evalRVoid(
            '.libPaths(c("/language-library", .libPaths())); loadNamespace("collections")',
        );
        // The published Wasm binary supplies compiled providers. Load the matching upstream
        // embedded entry point in a private environment until an integrated binary is published.
        await runtime.evalRVoid('server_api <- new.env(parent = asNamespace("languageserver"))');
        for (const asset of serverModules) {
            await runtime.FS.writeFile('/tmp/server.R', await loadAsset(asset, lifetime.signal));
            await runtime.evalRVoid('sys.source("/tmp/server.R", envir = server_api)');
        }
        await runtime.evalRVoid('dispatch_lsp <- server_api$run_embedded()');
        signal?.throwIfAborted();
        return {
            async dispatch(message) {
                const json = await runtime.evalRString(
                    'as.character(jsonlite::toJSON(dispatch_lsp(packet), auto_unbox = FALSE))',
                    {
                        env: { packet: JSON.stringify(message) },
                    },
                );
                return (JSON.parse(json) as string[]).map((reply) => JSON.parse(reply) as Message);
            },
            close,
        };
    } catch (error) {
        close();
        throw error;
    } finally {
        signal?.removeEventListener('abort', close);
    }
}
