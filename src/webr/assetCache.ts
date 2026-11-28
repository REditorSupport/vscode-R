import { Uri, workspace } from 'vscode';
import { downloadWebRAsset, hasExpectedDigest, LoadWebRAsset } from './assets';

/** The digest is also the cache key, so different server versions can coexist. */
export function cachedWebRAssets(storage: Uri): LoadWebRAsset {
    const root = Uri.joinPath(storage, 'webr-packages');
    return async (asset, signal) => {
        const file = Uri.joinPath(root, asset.sha256);
        try {
            const bytes = new Uint8Array(await workspace.fs.readFile(file));
            if (await hasExpectedDigest(bytes, asset.sha256)) {
                return bytes;
            }
        } catch {
            // Remote and browser providers can discard cached assets.
        }
        const bytes = await downloadWebRAsset(asset, signal);
        try {
            await workspace.fs.createDirectory(root);
            await workspace.fs.writeFile(file, bytes);
        } catch {
            // A full or read-only cache still permits the current session.
        }
        return bytes;
    };
}
