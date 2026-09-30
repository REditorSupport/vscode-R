/// <reference lib="dom" />

const paths = {
    previous: 'M10 3 5 8l5 5',
    next: 'm6 3 5 5-5 5',
    down: 'm4 6 4 4 4-4',
    table: 'M2 2h12v12H2ZM2 6h12M6 2v12',
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

interface MenuAction {
    id: string; label: string; description: string; run(): void; enabled?(): boolean;
}
let nextMenuId = 0;

/** Keep the menu in output flow so the notebook measures it, including in the last cell. */
export function saveMenu(parent: HTMLElement, actions: MenuAction[]): {
    button: HTMLButtonElement; refresh(): void; dispose(): void;
} {
    const menu = document.createElement('div'); menu.className = 'r-interactive-menu'; menu.hidden = true;
    menu.id = `r-interactive-save-${++nextMenuId}`; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Save plot as');
    const button = toolbarButton('Save plot as', 'save', () => menu.hidden ? open() : close(true), 'Save…');
    button.append(icon('down')); button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', 'false');
    const items = actions.map(action => {
        const item = document.createElement('button'); item.type = 'button'; item.tabIndex = -1;
        item.setAttribute('role', 'menuitem'); item.dataset.format = action.id;
        item.title = `Save as ${action.id.toUpperCase()}`;
        const label = document.createElement('span'); label.textContent = action.label;
        const description = document.createElement('small'); description.textContent = action.description;
        item.append(label, description);
        item.onclick = () => { close(true); action.run(); };
        menu.append(item); return item;
    });
    const refresh = (): void => { actions.forEach((action, i) => { items[i].disabled = action.enabled?.() === false; }); };
    const enabled = (): HTMLButtonElement[] => items.filter(item => !item.disabled);
    const position = (): void => {
        const offset = button.getBoundingClientRect().left - parent.getBoundingClientRect().left;
        menu.style.marginInlineStart = `${Math.max(0, Math.min(offset, parent.clientWidth - menu.offsetWidth))}px`;
    };
    const resize = new ResizeObserver(() => { if (!menu.hidden) { position(); } });
    const outside = (event: Event): void => {
        if (event.target instanceof Node && !menu.contains(event.target) && !button.contains(event.target)) { close(false); }
    };
    function close(restoreFocus: boolean): void {
        menu.hidden = true; button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true);
        resize.disconnect();
        if (restoreFocus) { button.focus(); }
    }
    function open(last = false): void {
        if (button.disabled) { return; }
        refresh(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); position(); resize.observe(parent);
        const available = enabled(); (last ? available.at(-1) : available[0])?.focus();
        document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside, true);
    }
    const triggerKey = (event: KeyboardEvent): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation(); open(event.key === 'ArrowUp');
        } else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    button.addEventListener('keydown', triggerKey);
    menu.onkeydown = event => {
        const available = enabled();
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const current = available.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
            available[next]?.focus();
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') { close(true); }
    };
    parent.append(menu); refresh();
    return { button, refresh, dispose: () => { close(false); button.removeEventListener('keydown', triggerKey); button.onclick = null; } };
}

export const toolbarStyle = `
.r-interactive-output .r-interactive-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:6px;padding:2px 0;font-size:12px}
.r-interactive-output button{font:inherit}
.r-interactive-output .r-interactive-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:28px;min-height:28px;padding:3px 6px;color:inherit;background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer}
.r-interactive-output .r-interactive-button svg{flex-shrink:0}
.r-interactive-output .r-interactive-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.r-interactive-output .r-interactive-button[aria-expanded=true]{background:var(--vscode-toolbar-activeBackground,rgba(128,128,128,.25))}
.r-interactive-output button:disabled{opacity:.45;cursor:default}
.r-interactive-output button:focus-visible{outline:1px solid var(--vscode-focusBorder,#007acc);outline-offset:-1px}
.r-interactive-output [data-status]{opacity:.7;padding:0 4px;overflow-wrap:anywhere}
.r-interactive-output .r-interactive-menu{box-sizing:border-box;width:220px;max-width:100%;padding:4px;margin-top:4px;color:var(--vscode-menu-foreground,var(--vscode-editor-foreground));background:var(--vscode-menu-background,var(--vscode-editor-background));border:1px solid var(--vscode-menu-border,var(--vscode-panel-border,#888));border-radius:4px;font-size:12px}
.r-interactive-output .r-interactive-menu[hidden]{display:none}
.r-interactive-output .r-interactive-menu button{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;padding:6px 8px;color:inherit;background:transparent;border:0;border-radius:3px;text-align:left;cursor:pointer}
.r-interactive-output .r-interactive-menu small{opacity:.75;font-size:11px}
.r-interactive-output .r-interactive-menu button:is(:hover,:focus):not(:disabled){background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground,rgba(128,128,128,.2)));color:var(--vscode-menu-selectionForeground,inherit)}
@media(forced-colors:active){.r-interactive-output button:disabled{color:GrayText;opacity:1}.r-interactive-output .r-interactive-button{border-color:ButtonText}.r-interactive-output .r-interactive-menu{border-color:ButtonText}}
`;
