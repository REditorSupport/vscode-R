/** A generated HTML document and its package-owned assets, relative to index.html. */
export type HtmlBundle = Record<string, Uint8Array>;

export const maxHtmlBytes = 64 * 1024 * 1024;
export const maxHtmlFiles = 5000;

export function checkHtmlPath(relative: string): void {
    const parts = relative.split('/');
    if (
        parts.some(
            (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                // eslint-disable-next-line no-control-regex -- widget assets must be valid portable file names
                /[\\:<>"|?*\x00-\x1f]|[. ]$/.test(part) ||
                /^(?:con|aux|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        )
    ) {
        throw new Error('Invalid path in HTML widget bundle');
    }
}

export function checkHtmlSize(files: number, bytes: number): void {
    if (files > maxHtmlFiles || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxHtmlBytes) {
        throw new Error('HTML bundle exceeds the 64 MiB / 5000 file limit');
    }
}

export function validateHtmlBundle(files: HtmlBundle): number {
    if (!Object.hasOwn(files, 'index.html')) {
        throw new Error('HTML widget has no index.html');
    }
    const entries = Object.entries(files);
    let total = 0;
    for (const [name, bytes] of entries) {
        checkHtmlPath(name);
        if (!(bytes instanceof Uint8Array)) {
            throw new Error('Invalid HTML widget asset');
        }
        total += bytes.length;
        checkHtmlSize(entries.length, total);
    }
    return total;
}
