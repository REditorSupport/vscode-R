/// <reference lib="dom" />

const paths = {
    previous: 'M10 3 5 8l5 5',
    next: 'm6 3 5 5-5 5',
    first: 'M3 3v10M12 3 7 8l5 5',
    last: 'M13 3v10M4 3l5 5-5 5',
    reset: 'M3 6a5 5 0 1 1 0 5M3 2v4h4',
    filter: 'M2 3h12L9 8v5l-2 1V8Z',
    table: 'M2 2h12v12H2ZM2 6h12M6 2v12',
    list: 'M2 3h1M6 3h8M2 8h1M6 8h8M2 13h1M6 13h8',
    text: 'M2 3h12M2 6h9M2 9h12M2 12h9',
    open: 'M9 2h5v5M14 2 7 9M6 3H2v11h11v-4',
    save: 'M8 2v8M4 6l4 4 4-4M2 10v4h12v-4',
    fit: 'M2 2v12M14 2v12M3 8h10M6 5 3 8l3 3M10 5l3 3-3 3',
};
type Icon = keyof typeof paths;

function icon(name: Icon): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name]); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.3'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path); return svg;
}

export function toolbarButton(label: string, glyph: Icon, action: () => void, text = label): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'r-interactive-button'; button.title = label; button.setAttribute('aria-label', label);
    button.append(icon(glyph));
    if (text) { const caption = document.createElement('span'); caption.textContent = text; button.append(caption); }
    button.onclick = action; return button;
}

export const toolbarStyle = `
.r-interactive-output [hidden]{display:none!important}
.r-interactive-output .r-interactive-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;padding:2px 0;font-size:12px}
.r-interactive-output button{font:inherit}
.r-interactive-output .r-interactive-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:28px;min-height:28px;padding:3px 6px;color:inherit;background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer}
.r-interactive-output .r-interactive-button svg{flex-shrink:0}
.r-interactive-output .r-interactive-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.r-interactive-output .r-interactive-button[aria-expanded=true]{background:var(--vscode-toolbar-activeBackground,rgba(128,128,128,.25))}
.r-interactive-output button:disabled{opacity:.45;cursor:default}
.r-interactive-output button:focus-visible{outline:1px solid var(--vscode-focusBorder,#007acc);outline-offset:-1px}
.r-interactive-output [data-status]{opacity:.7;padding:0 4px;overflow-wrap:anywhere}
@media(forced-colors:active){.r-interactive-output button:disabled{color:GrayText;opacity:1}.r-interactive-output .r-interactive-button{border-color:ButtonText}}
`;
