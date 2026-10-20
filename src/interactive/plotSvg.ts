import type { PlotFrame } from '../plotViewer/jgdPlotHistory';

interface GraphicsContext {
    col?: string | null;
    fill?: string | null;
    lwd?: number;
    lty?: number[];
    lend?: string;
    ljoin?: string;
    font?: { family?: string; size?: number; face?: number };
}
interface Operation {
    op: string;
    gc?: GraphicsContext;
    x: number & number[];
    y: number & number[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    r: number;
    str: string;
    rot: number;
    hadj: number;
    w: number;
    h: number;
    data: string;
    interpolate?: boolean;
    winding: string;
    subpaths: number[][][];
    ext?: { opacity?: number; blendMode?: string; filter?: string };
}

export function escapeXml(value: unknown): string {
    const text =
        value === null || value === undefined
            ? ''
            : typeof value === 'string' ||
                typeof value === 'number' ||
                typeof value === 'boolean' ||
                typeof value === 'bigint' ||
                typeof value === 'symbol'
              ? String(value)
              : JSON.stringify(value);
    return text.replace(
        /[&<>"']/g,
        (character) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&apos;',
            })[character]!,
    );
}

/** JGD's portable retained representation, also used when no browser is attached. */
export function plotToSvg(plot: PlotFrame): string {
    const n = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : 0;
    // JGD coordinates are device pixels, but font sizes are R points (1/72 in).
    const fontScale = (n(plot.device.dpi) > 0 ? n(plot.device.dpi) : 96) / 72;
    const color = (value: unknown): string =>
        escapeXml(typeof value === 'string' && !/[<>]|url\s*\(/i.test(value) ? value : 'none');
    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${n(plot.device.width)}" height="${n(plot.device.height)}" viewBox="0 0 ${n(plot.device.width)} ${n(plot.device.height)}">`,
    ];
    parts.push(`<rect width="100%" height="100%" fill="${color(plot.device.bg)}"/>`);
    let clip = 0;
    let currentClip: number | undefined;
    let clipOpen = false;
    const groups: (number | undefined)[] = [];
    const closeClip = (): void => {
        if (clipOpen) {
            parts.push('</g>');
            clipOpen = false;
        }
    };
    const openClip = (): void => {
        if (currentClip !== undefined) {
            parts.push(`<g clip-path="url(#c${currentClip})">`);
            clipOpen = true;
        }
    };
    for (const op of plot.ops as Operation[]) {
        const gc = op.gc ?? {};
        const stroke =
            ` stroke="${color(gc.col)}" stroke-width="${n(gc.lwd ?? 1)}" stroke-linecap="${escapeXml(gc.lend ?? 'round')}" stroke-linejoin="${escapeXml(gc.ljoin ?? 'round')}"` +
            (Array.isArray(gc.lty) ? ` stroke-dasharray="${gc.lty.map(n).join(',')}"` : '');
        const paint = ` fill="${color(gc.fill)}"${stroke}`;
        switch (op.op) {
            case 'clip':
                closeClip();
                currentClip = ++clip;
                parts.push(
                    `<defs><clipPath id="c${clip}"><rect x="${Math.min(n(op.x0), n(op.x1))}" y="${Math.min(n(op.y0), n(op.y1))}" width="${Math.abs(n(op.x1) - n(op.x0))}" height="${Math.abs(n(op.y1) - n(op.y0))}"/></clipPath></defs>`,
                );
                openClip();
                break;
            case 'line':
                parts.push(
                    `<line x1="${n(op.x1)}" y1="${n(op.y1)}" x2="${n(op.x2)}" y2="${n(op.y2)}"${stroke}/>`,
                );
                break;
            case 'rect':
                // SVG omits zero-area rectangles entirely; R still strokes
                // their border (e.g. empty bins in a marginal histogram).
                if (n(op.x0) === n(op.x1) || n(op.y0) === n(op.y1)) {
                    parts.push(
                        `<line x1="${n(op.x0)}" y1="${n(op.y0)}" x2="${n(op.x1)}" y2="${n(op.y1)}"${stroke}/>`,
                    );
                } else {
                    parts.push(
                        `<rect x="${Math.min(n(op.x0), n(op.x1))}" y="${Math.min(n(op.y0), n(op.y1))}" width="${Math.abs(n(op.x1) - n(op.x0))}" height="${Math.abs(n(op.y1) - n(op.y0))}"${paint}/>`,
                    );
                }
                break;
            case 'circle':
                parts.push(`<circle cx="${n(op.x)}" cy="${n(op.y)}" r="${n(op.r)}"${paint}/>`);
                break;
            case 'polyline':
            case 'polygon': {
                const points =
                    Array.isArray(op.x) && Array.isArray(op.y)
                        ? op.x.map((x, index) => `${n(x)},${n(op.y[index])}`).join(' ')
                        : '';
                parts.push(
                    `<${op.op} points="${points}"${op.op === 'polyline' ? ` fill="none"${stroke}` : paint}/>`,
                );
                break;
            }
            case 'path': {
                const d = (op.subpaths ?? [])
                    .map(
                        (points) =>
                            points
                                .map(
                                    (point, index) =>
                                        `${index ? 'L' : 'M'}${n(point[0])} ${n(point[1])}`,
                                )
                                .join('') + 'Z',
                    )
                    .join('');
                parts.push(
                    `<path d="${d}" fill-rule="${op.winding === 'evenodd' ? 'evenodd' : 'nonzero'}"${paint}/>`,
                );
                break;
            }
            case 'text': {
                const font = gc.font ?? {};
                const face = font.face ?? 1;
                const anchor = op.hadj === 0.5 ? 'middle' : op.hadj === 1 ? 'end' : 'start';
                parts.push(
                    `<text transform="translate(${n(op.x)} ${n(op.y)}) rotate(${-n(op.rot)})" text-anchor="${anchor}" font-family="${escapeXml(font.family || 'sans-serif')}" font-size="${n(font.size ?? 12) * fontScale}" font-weight="${face === 2 || face === 4 ? 'bold' : 'normal'}" font-style="${face === 3 || face === 4 ? 'italic' : 'normal'}" fill="${color(gc.col)}">${escapeXml(op.str)}</text>`,
                );
                break;
            }
            case 'raster': {
                if (!/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=\s]+$/.test(op.data)) {
                    break;
                }
                const w = Math.abs(n(op.w)),
                    h = Math.abs(n(op.h));
                // R anchors rasters at (xleft, ybottom) and rotates about that
                // point. JGD's downward device Y axis gives ordinary rasters
                // a negative height; reversed extents mirror the pixels.
                const transform = `translate(${n(op.x)} ${n(op.y)}) rotate(${-n(op.rot)}) scale(${n(op.w) < 0 ? -1 : 1} ${n(op.h) > 0 ? -1 : 1})`;
                parts.push(
                    `<image x="0" y="${-h}" width="${w}" height="${h}" preserveAspectRatio="none" transform="${transform}" image-rendering="${op.interpolate === false ? 'pixelated' : 'auto'}" href="${escapeXml(op.data)}"/>`,
                );
                break;
            }
            case 'beginGroup':
                // A clip is replaceable drawing state, not a permanent mask on
                // the group. Move it inside so later clips can expand beyond it
                // (e.g. from a base-graphics panel to its axes and title).
                closeClip();
                groups.push(currentClip);
                parts.push(`<g opacity="${Math.max(0, Math.min(1, n(op.ext?.opacity ?? 1)))}">`);
                openClip();
                break;
            case 'endGroup':
                if (!groups.length) {
                    break;
                }
                closeClip();
                parts.push('</g>');
                currentClip = groups.pop();
                openClip();
                break;
        }
    }
    closeClip();
    while (groups.length) {
        groups.pop();
        parts.push('</g>');
    }
    parts.push('</svg>');
    return parts.join('');
}
