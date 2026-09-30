/// <reference lib="dom" />

import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';

interface OutputItem { id: string; json(): Record<string, unknown> }
interface RendererContext {
    postMessage(message: unknown): void;
    onDidReceiveMessage(listener: (message: Record<string, unknown>) => void): { dispose(): void };
}

export function activate(context: RendererContext): { renderOutputItem(item: OutputItem, element: HTMLElement): void; disposeOutputItem(id?: string): void } {
    interface OutputState {
        element: HTMLElement; data: Record<string, unknown>; page: number;
        request?: { id: number; start: number };
        previous?: HTMLButtonElement; next?: HTMLButtonElement;
    }
    const outputs = new Map<string, OutputState>();
    let requestId = 0;
    const button = (label: string, action: () => void): HTMLButtonElement => {
        const element = document.createElement('button'); element.textContent = label;
        element.style.cssText = 'margin:4px 6px 4px 0;padding:3px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;cursor:pointer;border-radius:3px';
        element.onclick = action; return element;
    };
    const send = (item: OutputItem, data: Record<string, unknown>, action: string, extra: Record<string, unknown> = {}): void => {
        context.postMessage({ outputId: item.id, displayId: data.displayId, action, ...extra });
    };
    const drawTable = (parent: HTMLElement, data: Record<string, unknown>): void => {
        parent.replaceChildren();
        parent.style.cssText = 'overflow:auto;max-height:460px';
        const table = document.createElement('table'); table.style.cssText = 'border-collapse:collapse;font-size:12px;min-width:320px';
        const columns = (data.columns ?? []) as { field: string; headerName: string }[];
        const head = document.createElement('tr');
        for (const column of columns) {
            const th = document.createElement('th'); th.textContent = column.headerName;
            th.style.cssText = 'text-align:left;padding:5px 14px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background)'; head.append(th);
        }
        table.append(head);
        for (const row of (data.rows ?? []) as Record<string, unknown>[]) {
            const tr = document.createElement('tr');
            for (const column of columns) {
                const td = document.createElement('td'); const value = row[column.field];
                td.textContent = value === null ? 'NA' : String(value ?? '');
                td.style.cssText = 'padding:4px 14px;border-bottom:1px solid var(--vscode-panel-border);white-space:pre'; tr.append(td);
            }
            table.append(tr);
        }
        parent.append(table);
    };
    const updatePaging = (state: OutputState): void => {
        const count = Number(state.data.totalRows ?? 0);
        const shown = Array.isArray(state.data.rows) ? state.data.rows.length : 0;
        if (state.previous) { state.previous.disabled = !!state.request || state.page === 0; }
        if (state.next) { state.next.disabled = !!state.request || state.page + shown >= count || shown === 0; }
        const status = state.element.querySelector('[data-status]');
        if (status) { status.textContent = state.request ? 'Loading rows…' : shown
            ? `Rows ${state.page + 1}–${state.page + shown} of ${count}` : `${count} rows`; }
    };
    context.onDidReceiveMessage(message => {
        const output = outputs.get(String(message.outputId));
        if (!output) { return; }
        const status = output.element.querySelector('[data-status]');
        if (message.action === 'page') {
            if (!output.request || message.requestId !== output.request.id) { return; }
            const start = output.request.start; output.request = undefined;
            if (message.error) {
                updatePaging(output);
                if (status) { status.textContent = String(message.error); }
                return;
            }
            output.page = start;
            output.data = { ...output.data, ...(message.result as object) };
            const table = output.element.querySelector<HTMLElement>('[data-table]');
            if (table) { drawTable(table, output.data); }
            updatePaging(output);
        } else if (message.error && status) {
            status.textContent = String(message.error);
        }
    });
    return {
        renderOutputItem(item, element) {
            const data = item.json(); element.replaceChildren();
            element.classList.add('r-interactive-output');
            element.style.cssText = 'color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)';
            const style = document.createElement('style');
            style.textContent = '.r-interactive-output button:disabled{opacity:.45;cursor:default!important}.r-interactive-output button:focus-visible{outline:2px solid var(--vscode-focusBorder,#007acc);outline-offset:2px}';
            element.append(style);
            const state: OutputState = { element, data, page: 0 }; outputs.set(item.id, state);
            const toolbar = document.createElement('div');
            const status = document.createElement('span'); status.dataset.status = ''; status.style.opacity = '0.7';
            status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            if (data.kind === 'table') {
                const table = document.createElement('div'); table.dataset.table = '';
                drawTable(table, data); element.append(table);
                const page = (start: number): void => {
                    if (state.request) { return; }
                    state.request = { id: ++requestId, start: tablePage(Number(state.data.totalRows), start).start };
                    updatePaging(state);
                    send(item, data, 'page', { start: state.request.start, requestId: state.request.id });
                };
                state.previous = button('Previous page', () => page(state.page - TABLE_PAGE_SIZE));
                state.next = button('Next page', () => page(state.page + TABLE_PAGE_SIZE));
                toolbar.append(button('Open data viewer', () => send(item, data, 'table')),
                    state.previous, state.next);
            } else if (data.kind === 'plot') {
                const image = document.createElement('img'); image.crossOrigin = 'anonymous'; image.src = data.url ? String(data.url) : `data:image/svg+xml;base64,${String(data.svgData ?? '')}`; image.alt = 'R plot';
                image.style.cssText = 'display:block;max-width:100%;height:auto'; element.append(image);
                const savePng = button('Save PNG', () => {
                    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    if (ctx) { ctx.drawImage(image, 0, 0); try { send(item, data, 'savePng', { image: canvas.toDataURL('image/png') }); } catch { status.textContent = 'Open the plot to export this image.'; } }
                });
                savePng.disabled = true;
                image.onload = () => { savePng.disabled = data.connected === false; };
                image.onerror = () => { status.textContent = 'Could not load this plot. Reconnect to the session and try again.'; };
                toolbar.append(button('Open plot', () => send(item, data, 'plot')), button('Save SVG', () => send(item, data, 'save')),
                    savePng, button('Fit R device', () => send(item, data, 'resize', { width: Math.round(element.clientWidth), height: 600 })));
            } else if (data.kind === 'html' || data.kind === 'htmlText') {
                const iframe = document.createElement('iframe');
                iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads');
                iframe.style.cssText = 'width:100%;height:500px;border:0;background:white';
                if (data.kind === 'html') {
                    if (data.url) { iframe.src = String(data.url); }
                    else { iframe.srcdoc = '<p>Reconnect to view this widget, or use the portable HTML export.</p>'; }
                }
                else { iframe.srcdoc = String(data.text); }
                element.append(iframe);
                toolbar.append(button('Open viewer', () => send(item, data, 'open')));
            } else if (data.kind === 'url') {
                const label = document.createElement('span'); label.textContent = String(data.url); element.append(label);
                toolbar.append(button('Open application', () => send(item, data, 'open')));
            } else {
                const pre = document.createElement('pre'); pre.textContent = JSON.stringify(data, null, 2); element.append(pre);
            }
            toolbar.append(status); element.append(toolbar);
            if (data.kind === 'table') { updatePaging(state); }
            if (data.connected === false) {
                toolbar.querySelectorAll('button').forEach(control => { control.disabled = true; });
                status.textContent = `${status.textContent ? status.textContent + ' · ' : ''}Reconnect to use these controls`;
            }
        },
        disposeOutputItem(id) { if (id) { outputs.delete(id); } else { outputs.clear(); } },
    };
}
