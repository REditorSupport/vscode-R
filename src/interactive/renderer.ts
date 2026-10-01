/// <reference lib="dom" />

import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';
import { tableColumnAlignment, tableDisplayValue } from './tableFormatting';
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
        saveRequest?: number; saveButton?: HTMLButtonElement; savePlot?(format: string): void; updatePlotPaging?(): void;
        dispose?(): void;
    }
    const outputs = new Map<string, OutputState>();
    // Output IDs change on replaceOutput. Keep local choices until the host has
    // persisted them, and while browsing a saved notebook without a live host.
    const choices = new Map<string, { tableView?: string; selectedPlot?: string }>();
    const remember = (key: string, value: { tableView?: string; selectedPlot?: string }): void => {
        choices.delete(key); choices.set(key, value);
        while (choices.size > 1000) { choices.delete(choices.keys().next().value as string); }
    };
    let requestId = 0;
    const send = (item: OutputItem, data: Record<string, unknown>, action: string, extra: Record<string, unknown> = {}): void => {
        context.postMessage({ outputId: item.id, displayId: data.displayId, generation: data.generation, action, ...extra });
    };
    const drawTable = (parent: HTMLElement, data: Record<string, unknown>): void => {
        parent.replaceChildren();
        parent.style.cssText = 'overflow:auto;max-height:460px';
        const table = document.createElement('table'); table.style.cssText = 'border-collapse:collapse;font-size:12px;min-width:320px';
        const columns = (data.columns ?? []) as { field: string; headerName: string; type?: unknown }[];
        const head = document.createElement('tr');
        for (const column of columns) {
            const th = document.createElement('th'); th.textContent = column.headerName;
            th.style.cssText = `text-align:${tableColumnAlignment(data, column)};padding:5px 14px;border-bottom:1px solid var(--vscode-panel-border);position:sticky;top:0;background:var(--vscode-editor-background)`; head.append(th);
        }
        table.append(head);
        for (const [rowIndex, row] of ((data.rows ?? []) as Record<string, unknown>[]).entries()) {
            const tr = document.createElement('tr');
            for (const column of columns) {
                const td = document.createElement('td'); const value = row[column.field];
                td.textContent = tableDisplayValue(data, row, column.field, rowIndex);
                if (typeof value === 'number' && td.textContent !== String(value)) { td.title = String(value); }
                td.style.cssText = `text-align:${tableColumnAlignment(data, column)};padding:4px 14px;border-bottom:1px solid var(--vscode-panel-border);white-space:pre`; tr.append(td);
            }
            table.append(tr);
        }
        parent.append(table);
    };
    const connectionHint = (data: Record<string, unknown>): string => data.connected === false ? 'Reconnect to use live controls'
        : data.running === false ? 'R has stopped · saved output is still available'
            : data.archived === true ? 'Previous R process · run the code again for live controls' : '';
    const updatePaging = (state: OutputState): void => {
        const count = Number(state.data.totalRows ?? 0);
        const shown = Array.isArray(state.data.rows) ? state.data.rows.length : 0;
        const unavailable = state.data.connected === false || state.data.archived === true || state.data.running === false;
        if (state.previous) { state.previous.disabled = unavailable || !!state.request || state.page === 0; }
        if (state.next) { state.next.disabled = unavailable || !!state.request || state.page + shown >= count || shown === 0; }
        const status = state.element.querySelector('[data-status]');
        if (status) {
            status.textContent = state.data.tableView === 'text' ? 'Printed R output' : state.request ? 'Loading rows…' : shown
                ? `Rows ${state.page + 1}–${state.page + shown} of ${count}` : `${count} rows`;
            status.textContent = [status.textContent, connectionHint(state.data)].filter(Boolean).join(' · ');
        }
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
            output.updatePlotPaging?.();
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
            const choiceKey = `${String(data.generation ?? '')}:${String(data.displayId ?? item.id)}`;
            const choice = choices.get(choiceKey);
            const connected = data.connected !== false;
            const live = connected && data.archived !== true && data.running !== false;
            element.classList.add('r-interactive-output');
            element.style.cssText = 'color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)';
            const style = document.createElement('style');
            style.textContent = toolbarStyle;
            element.append(style);
            const state: OutputState = { element, data: { ...data }, page: 0 }; outputs.set(item.id, state);
            const toolbar = document.createElement('div'); toolbar.className = 'r-interactive-toolbar';
            toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Output actions');
            const status = document.createElement('span'); status.dataset.status = '';
            status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            if (data.kind === 'table') {
                const table = document.createElement('div'); table.dataset.table = '';
                drawTable(table, data); element.append(table);
                const printed = document.createElement('pre'); printed.dataset.printed = '';
                printed.style.cssText = 'white-space:pre;overflow:auto;max-height:460px;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,12px)';
                printed.textContent = typeof data.printedText === 'string' ? data.printedText : '';
                element.append(printed);
                const page = (start: number): void => {
                    if (state.request || !live) { return; }
                    state.request = { id: ++requestId, start: tablePage(Number(state.data.totalRows), start).start };
                    updatePaging(state);
                    send(item, data, 'page', { start: state.request.start, requestId: state.request.id });
                };
                state.previous = button('Previous page', 'previous', () => page(state.page - TABLE_PAGE_SIZE), '');
                state.next = button('Next page', 'next', () => page(state.page + TABLE_PAGE_SIZE), '');
                const open = button('Open data viewer', 'table', () => send(item, data, 'table'), 'Data viewer');
                open.disabled = !live;
                const hasText = typeof data.printedText === 'string';
                state.data.tableView = hasText ? choice?.tableView ?? data.tableView ?? 'table' : 'table';
                const showView = (): void => {
                    const text = state.data.tableView === 'text';
                    table.hidden = text; printed.hidden = !text;
                    if (state.previous) { state.previous.hidden = text; }
                    if (state.next) { state.next.hidden = text; }
                    toggle.replaceChildren(...Array.from(button('', text ? 'table' : 'text', () => undefined, text ? 'Table' : 'Text').childNodes));
                    toggle.title = text ? 'Show table preview' : 'Show R printed output';
                    toggle.setAttribute('aria-label', toggle.title);
                    toggle.disabled = !hasText;
                    if (!hasText) { toggle.title = data.printError ? `R printout unavailable: ${String(data.printError)}` : 'Printed output unavailable. Run the code in a session started with the current extension.'; }
                    updatePaging(state);
                };
                const toggle = button('Show R printed output', 'text', () => {
                    state.data.tableView = state.data.tableView === 'text' ? 'table' : 'text';
                    remember(choiceKey, { tableView: String(state.data.tableView) });
                    send(item, data, 'tableView', { mode: state.data.tableView }); showView();
                }, 'Text');
                toolbar.append(open, toggle, state.previous, state.next); showView();
                state.dispose = () => { for (const control of [open, toggle, state.previous, state.next]) { if (control) { control.onclick = null; } } };
            } else if (data.kind === 'plot') {
                const pages = (Array.isArray(data.pages) && data.pages.length ? data.pages : [data]) as Record<string, unknown>[];
                const selected = choice?.selectedPlot ?? data.selectedPlot;
                let index = pages.findIndex(page => page.displayId === selected);
                if (index < 0) { index = pages.length - 1; }
                const current = (): Record<string, unknown> => ({ ...pages[index], generation: data.generation });
                const image = document.createElement('img'); image.crossOrigin = 'anonymous';
                image.style.cssText = 'display:block;max-width:100%;height:auto'; element.append(image);
                const pngReady = (): boolean => image.complete && image.naturalWidth > 0;
                const savePng = (): void => {
                    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
                    const ctx = canvas.getContext('2d');
                    try {
                        if (!ctx) { throw new Error('Canvas unavailable'); }
                        ctx.drawImage(image, 0, 0); send(item, current(), 'savePng', { image: canvas.toDataURL('image/png') });
                    } catch { status.textContent = 'Open the plot to export this image.'; }
                };
                // The host's native picker does not resize or scroll the notebook output.
                const save = button('Save plot as', 'save', () => {
                    state.saveRequest = ++requestId; save.disabled = true;
                    state.updatePlotPaging?.();
                    send(item, current(), 'saveAs', { requestId: state.saveRequest, pngReady: pngReady() });
                }, 'Save…');
                save.disabled = !connected;
                save.setAttribute('aria-haspopup', 'dialog'); state.saveButton = save;
                state.savePlot = format => {
                    if (!connected) { return; }
                    if (format === 'svg') { send(item, current(), 'save'); }
                    else if (format === 'png' && pngReady()) { savePng(); }
                };
                const open = button('Open plot', 'open', () => send(item, current(), 'plot'));
                open.disabled = !connected;
                const fit = button('Fit R device to cell width', 'fit', () => send(item, current(), 'resize', { width: Math.round(element.clientWidth), height: 600 }), 'Fit R device');
                const previous = button('Previous plot', 'previous', () => select(index - 1), '');
                const next = button('Next plot', 'next', () => select(index + 1), '');
                const counter = document.createElement('span'); counter.dataset.plotPage = '';
                counter.setAttribute('aria-live', 'polite');
                state.updatePlotPaging = () => {
                    previous.disabled = state.saveRequest !== undefined || index === 0;
                    next.disabled = state.saveRequest !== undefined || index === pages.length - 1;
                    counter.textContent = `Plot ${index + 1} of ${pages.length}`;
                    fit.disabled = !live || pages[index].resizable === false;
                    fit.hidden = pages[index].resizable === false;
                };
                const showPlot = (): void => {
                    const page = pages[index];
                    // Reserve the previous page's dimensions until the new image
                    // loads, so equal-sized pages do not collapse between clicks.
                    if (Number(page.width) > 0 && Number(page.height) > 0) {
                        image.width = Number(page.width); image.height = Number(page.height);
                    }
                    image.alt = pages.length > 1 ? `R plot ${index + 1} of ${pages.length}` : 'R plot';
                    image.src = page.url ? String(page.url) : page.imageData
                        ? `data:${String(page.mime)};base64,${String(page.imageData)}` : `data:image/svg+xml;base64,${String(page.svgData ?? '')}`;
                    state.updatePlotPaging?.();
                };
                const select = (page: number): void => {
                    if (state.saveRequest !== undefined || page < 0 || page >= pages.length) { return; }
                    index = page;
                    remember(choiceKey, { selectedPlot: String(pages[index].displayId) });
                    send(item, data, 'plotPage', { selectedPlot: pages[index].displayId });
                    status.textContent = connectionHint(data); showPlot();
                };
                image.onload = () => { image.width = image.naturalWidth; image.height = image.naturalHeight; };
                image.onerror = () => { status.textContent = 'Could not load this plot. Reconnect to the session and try again.'; };
                state.dispose = () => {
                    for (const control of [save, open, fit, previous, next]) { control.onclick = null; }
                    image.onload = null; image.onerror = null;
                };
                if (pages.length > 1) { toolbar.append(previous, counter, next); }
                toolbar.append(open, save, fit); showPlot();
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
            if (data.kind !== 'table') {
                status.textContent = [status.textContent, connectionHint(data)].filter(Boolean).join(' · ');
                if (!connected && data.kind !== 'plot') { toolbar.querySelectorAll('button').forEach(control => { control.disabled = true; }); }
            }
        },
        disposeOutputItem(id) {
            if (id) { outputs.get(id)?.dispose?.(); outputs.delete(id); }
            else { outputs.forEach(state => state.dispose?.()); outputs.clear(); }
        },
    };
}
