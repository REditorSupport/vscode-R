import { load } from 'cheerio/slim';
import { checkHtmlSize, type HtmlBundle, validateHtmlBundle } from '../interactive/htmlBundle';

const utf8 = new TextDecoder();
const mime: Record<string, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    css: 'text/css',
};

function binaryUrl(bytes: Uint8Array, type: string): string {
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 0x4000) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x4000)));
    }
    return 'data:' + type + ';base64,' + btoa(chunks.join(''));
}

/** Inline a saved widget's static dependencies for an opaque, sandboxed browser iframe. */
export function webRWidgetHtml(files: HtmlBundle): string {
    validateHtmlBundle(files);
    const $ = load(utf8.decode(files['index.html']));
    const origin = 'https://widget.invalid';
    let expanded = files['index.html'].length;
    const reserve = (bytes: number) => {
        expanded += bytes;
        checkHtmlSize(1, expanded);
    };
    const resolve = (reference: string, from: string): string | undefined => {
        if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(reference)) {
            return;
        }
        try {
            const base = new URL(from.split('/').map(encodeURIComponent).join('/'), origin);
            const url = new URL(reference, base);
            const path = decodeURIComponent(url.pathname.slice(1));
            if (url.origin === origin && Object.hasOwn(files, path)) {
                return path;
            }
        } catch {
            // Leave malformed or external references to the sandboxed document.
        }
    };
    const dataUrl = (reference: string, from: string): string | undefined => {
        const file = resolve(reference, from);
        if (!file) {
            return;
        }
        const type = mime[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
        reserve(4 * Math.ceil(files[file].length / 3));
        return (
            binaryUrl(files[file], type) +
            (reference.includes('#') ? reference.slice(reference.indexOf('#')) : '')
        );
    };
    const css = (text: string, from: string) =>
        text.replace(
            /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
            (original, _quote: string, ref: string) => {
                const url = dataUrl(ref.trim(), from);
                return url ? 'url("' + url + '")' : original;
            },
        );
    $('style').each((_, element) => {
        const style = $(element);
        style.text(css(style.text(), 'index.html'));
    });
    $('[style]').each((_, element) => {
        const tag = $(element);
        tag.attr('style', css(tag.attr('style')!, 'index.html'));
    });
    $('script[src]').each((_, element) => {
        const script = $(element);
        const file = resolve(script.attr('src') ?? '', 'index.html');
        if (file) {
            reserve(files[file].length);
            script
                .removeAttr('src')
                .text(utf8.decode(files[file]).replace(/<\/(?=script)/gi, '<\\/'));
        }
    });
    $('link[href]').each((_, element) => {
        const link = $(element);
        const ref = link.attr('href') ?? '';
        const file = resolve(ref, 'index.html');
        if (file && link.attr('rel')?.toLowerCase().split(/\s+/).includes('stylesheet')) {
            reserve(files[file].length);
            const style = $('<style></style>').text(
                css(utf8.decode(files[file]), file).replace(/<\/(?=style)/gi, '<\\/'),
            );
            const media = link.attr('media');
            if (media) {
                style.attr('media', media);
            }
            link.replaceWith(style);
        } else {
            const url = dataUrl(ref, 'index.html');
            if (url) {
                link.attr('href', url);
            }
        }
    });
    $('img[src],source[src],input[src],audio[src],video[src],video[poster]').each((_, element) => {
        const tag = $(element);
        for (const attr of ['src', 'poster']) {
            const ref = tag.attr(attr);
            const url = ref && dataUrl(ref, 'index.html');
            if (url) {
                tag.attr(attr, url);
            }
        }
    });
    return $.html();
}
