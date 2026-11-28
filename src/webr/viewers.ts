import type { WebR } from 'webr';
import { viewerJsonlite } from './viewerJsonlite';
import { viewerRunner } from './viewerRunner';

/** Load the viewer's private dependency without adding its directory to the user's library paths. */
export async function prepareWebRViewers(runtime: WebR): Promise<void> {
    if (!(await runtime.evalRBoolean('base::isNamespaceLoaded("jsonlite")'))) {
        const library = '/tmp/vscode-r-viewer-library';
        const archive = library + '/jsonlite.tgz';
        await runtime.FS.mkdir(library);
        await runtime.FS.writeFile(archive, viewerJsonlite());
        try {
            await runtime.evalRVoid(
                'utils::untar(archive, exdir = library, tar = "internal"); base::loadNamespace("jsonlite", lib.loc = library)',
                { env: { archive, library } },
            );
        } finally {
            await runtime.FS.unlink(archive);
        }
    }
    await runtime.evalRVoid(viewerRunner);
}

/** Use native sess validation and its size-limited JSON result envelope. Parameters are R data. */
export async function inspectWebRViewer(
    runtime: WebR,
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> {
    const raw = await runtime.evalRString(
        'base::getOption("vscodeR.webR.inspect")(method, packet)',
        {
            env: { method, packet: JSON.stringify(params) },
        },
    );
    const reply = JSON.parse(raw) as { version?: unknown; result?: unknown };
    if (reply?.version !== 1) {
        throw new Error('Invalid webR viewer response.');
    }
    return reply.result;
}
