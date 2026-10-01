/// <reference lib="dom" />

import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';
import { tableDisplayValue } from './tableFormatting';
import { toolbarButton as button, toolbarStyle } from './rendererToolbar';

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
        saveRequest?: number; saveButton?: HTMLButtonElement; savePlot?(format: string): void;
        dispose?(): void;
    }
    const outputs = new Map<string, OutputState>();
    let requestId = 0;
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
        for (const [rowIndex, row] of ((data.rows ?? []) as Record<string, unknown>[]).entries()) {
            const tr = document.createElement('tr');
            for (const column of columns) {
                const td = document.createElement('td'); const value = row[column.field];
                td.textContent = tableDisplayValue(data, row, column.field, rowIndex);
                if (typeof value === 'number' && td.textContent !== String(value)) { td.title = String(value); }
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
            output.data = { ...output.data, formattedColumns: undefined, ...(message.result as object) };
            const table = output.element.querySelector<HTMLElement>('[data-table]');
            if (table) { drawTable(table, output.data); }
            updatePaging(output);
        } else if (message.action === 'saveAs') {
            if (message.requestId !== output.saveRequest || output.saveRequest === undefined) { return; }
            output.saveRequest = undefined;
            if (output.saveButton) {
                output.saveButton.disabled = output.data.connected === false;
                output.saveButton.focus({ preventScroll: true });
            }
            if (message.error && status) { status.textContent = String(message.error); }
            else if (typeof message.result === 'string') { output.savePlot?.(message.result); }
        } else if (message.error && status) {
            status.textContent = String(message.error);
        }
    });
    return {
        renderOutputItem(item, element) {
            outputs.get(item.id)?.dispose?.();
            const data = item.json(); element.replaceChildren();
            element.classList.add('r-interactive-output');
            element.style.cssText = 'color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)';
            const style = document.createElement('style');
            style.textContent = toolbarStyle;
            element.append(style);
            const state: OutputState = { element, data, page: 0 }; outputs.set(item.id, state);
            const toolbar = document.createElement('div'); toolbar.className = 'r-interactive-toolbar';
            toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Output actions');
            const status = document.createElement('span'); status.dataset.status = '';
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
                state.previous = button('Previous page', 'previous', () => page(state.page - TABLE_PAGE_SIZE), '');
                state.next = button('Next page', 'next', () => page(state.page + TABLE_PAGE_SIZE), '');
                toolbar.append(button('Open data viewer', 'table', () => send(item, data, 'table'), 'Data viewer'),
                    state.previous, state.next);
            } else if (data.kind === 'plot') {
                const image = document.createElement('img'); image.crossOrigin = 'anonymous'; image.src = data.url ? String(data.url) : `data:image/svg+xml;base64,${String(data.svgData ?? '')}`; image.alt = 'R plot';
                image.style.cssText = 'display:block;max-width:100%;height:auto'; element.append(image);
                let pngReady = false;
                const savePng = (): void => {
                    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    try {
                        if (!ctx) { throw new Error('Canvas unavailable'); }
                        ctx.drawImage(image, 0, 0); send(item, data, 'savePng', { image: canvas.toDataURL('image/png') });
                    } catch { status.textContent = 'Open the plot to export this image.'; }
                };
                // The host's native picker does not resize or scroll the notebook output.
                const save = button('Save plot as', 'save', () => {
                    state.saveRequest = ++requestId; save.disabled = true;
                    send(item, data, 'saveAs', { requestId: state.saveRequest, pngReady });
                }, 'Save…');
                save.setAttribute('aria-haspopup', 'dialog'); state.saveButton = save;
                state.savePlot = format => {
                    if (data.connected === false) { return; }
                    if (format === 'svg') { send(item, data, 'save'); }
                    else if (format === 'png' && pngReady) { savePng(); }
                };
                image.onload = () => { pngReady = true; };
                image.onerror = () => { pngReady = false; status.textContent = 'Could not load this plot. Reconnect to the session and try again.'; };
                state.dispose = () => { save.onclick = null; image.onload = null; image.onerror = null; };
                toolbar.append(button('Open plot', 'open', () => send(item, data, 'plot')), save,
                    button('Fit R device to cell width', 'fit', () => send(item, data, 'resize', { width: Math.round(element.clientWidth), height: 600 }), 'Fit R device'));
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
                toolbar.append(button('Open viewer', 'open', () => send(item, data, 'open')));
            } else if (data.kind === 'url') {
                const label = document.createElement('span'); label.textContent = String(data.url); element.append(label);
                toolbar.append(button('Open application', 'open', () => send(item, data, 'open')));
            } else {
                const pre = document.createElement('pre'); pre.textContent = JSON.stringify(data, null, 2); element.append(pre);
            }
            toolbar.append(status);
            if (!toolbar.parentElement) { element.append(toolbar); }
            if (data.kind === 'table') { updatePaging(state); }
            if (data.connected === false) {
                toolbar.querySelectorAll('button').forEach(control => { control.disabled = true; });
                status.textContent = `${status.textContent ? status.textContent + ' · ' : ''}Reconnect to use these controls`;
            }
        },
        disposeOutputItem(id) {
            if (id) { outputs.get(id)?.dispose?.(); outputs.delete(id); }
            else { outputs.forEach(state => state.dispose?.()); outputs.clear(); }
        },
    };
}
