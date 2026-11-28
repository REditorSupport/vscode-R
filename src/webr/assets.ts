export interface WebRAsset {
    name: string;
    url: string;
    sha256: string;
}

export type LoadWebRAsset = (
    asset: WebRAsset,
    signal?: AbortSignal,
) => Promise<Uint8Array<ArrayBuffer>>;

export async function hasExpectedDigest(
    bytes: Uint8Array<ArrayBuffer>,
    expected: string,
): Promise<boolean> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (octet) => octet.toString(16).padStart(2, '0')).join('') === expected;
}

export const downloadWebRAsset: LoadWebRAsset = async (asset, signal) => {
    const response = await fetch(asset.url, { signal });
    if (!response.ok) {
        throw new Error(`Cannot download ${asset.name}: HTTP ${response.status} from ${asset.url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!(await hasExpectedDigest(bytes, asset.sha256))) {
        throw new Error(`Invalid checksum for webR dependency ${asset.name}`);
    }
    return bytes;
};
