import type { PlotFrame } from '../plotViewer/jgdPlotHistory';

interface GraphicsContext {
    col?: string | null; fill?: string | null; lwd?: number; lty?: number[];
    lend?: string; ljoin?: string;
    font?: { family?: string; size?: number; face?: number };
}
interface Operation {
    op: string; gc?: GraphicsContext;
    x: number & number[]; y: number & number[];
    x0: number; y0: number; x1: number; y1: number; x2: number; y2: number;
    r: number; str: string; rot: number; hadj: number;
    w: number; h: number; data: string; winding: string; subpaths: number[][][];
    ext?: { opacity?: number; blendMode?: string; filter?: string };
}

export function escapeXml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;',
    }[character]!));
}

/** JGD's portable retained representation, also used when no browser is attached. */
export function plotToSvg(plot: PlotFrame): string {
    const n = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const color = (value: unknown): string => escapeXml(typeof value === 'string' &&
        !/[<>]|url\s*\(/i.test(value) ? value : 'none');
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${n(plot.device.width)}" height="${n(plot.device.height)}" viewBox="0 0 ${n(plot.device.width)} ${n(plot.device.height)}">`];
    parts.push(`<rect width="100%" height="100%" fill="${color(plot.device.bg)}"/>`);
    let clip = 0;
    const groups: string[] = [];
    const closeClips = (): void => {
        while (groups[groups.length - 1] === 'clip') { groups.pop(); parts.push('</g>'); }
    };
    for (const op of plot.ops as Operation[]) {
        const gc = op.gc ?? {};
        const stroke = ` stroke="${color(gc.col)}" stroke-width="${n(gc.lwd ?? 1)}" stroke-linecap="${escapeXml(gc.lend ?? 'round')}" stroke-linejoin="${escapeXml(gc.ljoin ?? 'round')}"` +
            (Array.isArray(gc.lty) ? ` stroke-dasharray="${gc.lty.map(n).join(',')}"` : '');
        const paint = ` fill="${color(gc.fill)}"${stroke}`;
        switch (op.op) {
            case 'clip':
                closeClips(); clip++;
                parts.push(`<defs><clipPath id="c${clip}"><rect x="${Math.min(n(op.x0), n(op.x1))}" y="${Math.min(n(op.y0), n(op.y1))}" width="${Math.abs(n(op.x1) - n(op.x0))}" height="${Math.abs(n(op.y1) - n(op.y0))}"/></clipPath></defs><g clip-path="url(#c${clip})">`);
                groups.push('clip'); break;
            case 'line':
                parts.push(`<line x1="${n(op.x1)}" y1="${n(op.y1)}" x2="${n(op.x2)}" y2="${n(op.y2)}"${stroke}/>`); break;
            case 'rect':
                parts.push(`<rect x="${Math.min(n(op.x0), n(op.x1))}" y="${Math.min(n(op.y0), n(op.y1))}" width="${Math.abs(n(op.x1) - n(op.x0))}" height="${Math.abs(n(op.y1) - n(op.y0))}"${paint}/>`); break;
            case 'circle':
                parts.push(`<circle cx="${n(op.x)}" cy="${n(op.y)}" r="${n(op.r)}"${paint}/>`); break;
            case 'polyline': case 'polygon': {
                const points = Array.isArray(op.x) && Array.isArray(op.y)
                    ? op.x.map((x, index) => `${n(x)},${n(op.y[index])}`).join(' ') : '';
                parts.push(`<${op.op} points="${points}"${op.op === 'polyline' ? ` fill="none"${stroke}` : paint}/>`);
                break;
            }
            case 'path': {
                const d = (op.subpaths ?? []).map(points => points.map((point, index) =>
                    `${index ? 'L' : 'M'}${n(point[0])} ${n(point[1])}`).join('') + 'Z').join('');
                parts.push(`<path d="${d}" fill-rule="${op.winding === 'evenodd' ? 'evenodd' : 'nonzero'}"${paint}/>`);
                break;
            }
            case 'text': {
                const font = gc.font ?? {};
                const face = font.face ?? 1;
                const anchor = op.hadj === 0.5 ? 'middle' : op.hadj === 1 ? 'end' : 'start';
                parts.push(`<text transform="translate(${n(op.x)} ${n(op.y)}) rotate(${-n(op.rot)})" text-anchor="${anchor}" font-family="${escapeXml(font.family || 'sans-serif')}" font-size="${n(font.size ?? 12)}" font-weight="${face === 2 || face === 4 ? 'bold' : 'normal'}" font-style="${face === 3 || face === 4 ? 'italic' : 'normal'}" fill="${color(gc.col)}">${escapeXml(op.str)}</text>`);
                break;
            }
            case 'raster': {
                if (!/^data:image\/(png|jpeg);base64,[a-zA-Z0-9+/=\s]+$/.test(op.data)) { break; }
                const w = Math.abs(n(op.w)), h = Math.abs(n(op.h));
                const x = n(op.x) + Math.min(0, n(op.w)), y = n(op.y) - h;
                parts.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" transform="rotate(${-n(op.rot)} ${x + w / 2} ${y + h / 2})" href="${escapeXml(op.data)}"/>`);
                break;
            }
            case 'beginGroup':
                parts.push(`<g opacity="${Math.max(0, Math.min(1, n(op.ext?.opacity ?? 1)))}">`);
                groups.push('group'); break;
            case 'endGroup':
                closeClips();
                if (groups.pop()) { parts.push('</g>'); }
                break;
        }
    }
    while (groups.pop()) { parts.push('</g>'); }
    parts.push('</svg>');
    return parts.join('');
}
