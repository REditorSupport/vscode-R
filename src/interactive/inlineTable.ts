/// <reference lib="dom" />
import { TABLE_PAGE_SIZE, tablePage } from './tablePaging';
import { tableColumnAlignment, tableDisplayValue, tableSnapshotSummary } from './tableFormatting';
import { columnOperators, filterNeedsValue, filterOperators, TableColumn, TableFilters, tableSchema, TableSort } from './tableQuery';
import { toolbarButton as button } from './rendererToolbar';

export interface InlineTableState {
    data: Record<string, unknown>; start: number; size: number; live: boolean;
    sort: TableSort[]; filters: TableFilters; order: string[];
    filterOpen?: boolean;
}
export interface InlineTable {
    reply(message: Record<string, unknown>): void;
    setTextMode(text: boolean): void;
    dispose(): void;
}

/** A single requested page, never an accumulating copy of the R dataset. */
export function createInlineTable(parent: HTMLElement, toolbar: HTMLElement, status: HTMLElement,
    original: Record<string, unknown>, cached: InlineTableState | undefined,
    send: (query: Record<string, unknown>) => number, remember: (state: InlineTableState) => void,
    connectionHint: string): InlineTable {
    const initial = (): InlineTableState => ({ data: original, start: 0, size: TABLE_PAGE_SIZE, live: false, sort: [], filters: {}, order: [] });
    let state = cached ?? initial();
    let pending: { id: number; start: number; size: number; live: boolean; sort: TableSort[]; filters: TableFilters } | undefined;
    let active = true;
    let textMode = false;
    let dragged: string | undefined;
    let error = '';
    const available = original.connected !== false && original.archived !== true && original.running !== false;
    const hasFull = !!original.fullViewId;
    const columns = (): TableColumn[] => (state.data.columns ?? []) as TableColumn[];
    const count = (): number => !state.live && hasFull && !state.sort.length && !Object.keys(state.filters).length
        ? Number(original.sourceRows ?? original.totalRows) : Number(state.data.totalRows ?? 0);
    const ordered = (): TableColumn[] => {
        const all = columns();
        return [...all.filter(column => column.field === '0'),
            ...state.order.map(field => all.find(column => column.field === field && field !== '0')).filter((column): column is TableColumn => !!column),
            ...all.filter(column => column.field !== '0' && !state.order.includes(column.field))];
    };
    const tableHost = document.createElement('div'); tableHost.dataset.table = ''; parent.append(tableHost);
    const tools = document.createElement('div'); tools.className = 'r-inline-tools'; parent.append(tools);
    const filtersPanel = document.createElement('form'); filtersPanel.className = 'r-inline-panel'; filtersPanel.setAttribute('aria-label', 'Table filters');
    tools.append(filtersPanel);
    const pager = document.createElement('div'); pager.className = 'r-inline-pager';
    const number = document.createElement('input'); number.type = 'number'; number.min = '1'; number.step = '1'; number.setAttribute('aria-label', 'Page number');
    const pageCount = document.createElement('span');
    const size = document.createElement('select'); size.setAttribute('aria-label', 'Rows per page');
    for (const value of [20, 50, 100]) { size.add(new Option(`${value} rows`, String(value))); }

    const request = (start: number, sort = state.sort, filters = state.filters, pageSize = state.size): void => {
        if (!active || !available || pending) { return; }
        const changedQuery = sort !== state.sort || filters !== state.filters;
        const live = hasFull && (state.live || start + pageSize > Number(original.totalRows) || sort.length > 0 || Object.keys(filters).length > 0);
        const offset = changedQuery ? 0 : tablePage(count(), start, pageSize).start;
        error = '';
        const id = send({ start: offset, size: pageSize, live, refresh: live && (!state.live || changedQuery),
            schema: tableSchema(columns()),
            columns: columns(), sortModel: sort, filterModel: filters });
        pending = { id, start: offset, size: pageSize, live, sort, filters };
        update();
    };
    const first = button('First page', 'first', () => request(0), '');
    const previous = button('Previous page', 'previous', () => request(state.start - state.size), '');
    const next = button('Next page', 'next', () => request(state.start + state.size), '');
    const last = button('Last page', 'last', () => request(Math.max(0, count() - 1)), '');
    const jump = (): void => {
        const page = Number(number.value);
        if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(1, Math.ceil(count() / state.size))) {
            error = `Enter a page from 1 to ${Math.max(1, Math.ceil(count() / state.size)).toLocaleString('en-US')}.`; update(); return;
        }
        request((page - 1) * state.size);
    };
    number.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); jump(); } };
    const go = document.createElement('button'); go.type = 'button'; go.className = 'r-interactive-button';
    go.textContent = 'Go'; go.setAttribute('aria-label', 'Go to page'); go.title = 'Go to page'; go.onclick = jump;
    size.onchange = () => request(state.start, state.sort, state.filters, Number(size.value));
    pager.append(first, previous, document.createTextNode('Page '), number, pageCount, go, next, last, size);
    const filtersButton = button('Filter columns', 'filter', () => { state.filterOpen = !state.filterOpen; remember(state); update(); }, 'Filters');
    const reset = button('Reset table view', 'reset', () => {
        if (!active) { return; }
        // Restoring saved output is local, and invalidates even an in-flight reply.
        pending = undefined; state = initial(); error = ''; remember(state);
        draw(); buildFilters(true); update(); tableHost.scrollLeft = 0; tableHost.scrollTop = 0;
    }, 'Reset');
    reset.title = 'Restore the saved preview, first page, original column order, and clear sorting and filters';
    toolbar.append(filtersButton, reset, pager);

    const move = (field: string, target: string): void => {
        if (!active || field === '0' || target === '0' || field === target) { return; }
        const fields = ordered().filter(column => column.field !== '0').map(column => column.field);
        const from = fields.indexOf(field); const to = fields.indexOf(target);
        if (from < 0 || to < 0) { return; }
        fields.splice(from, 1); fields.splice(to, 0, field); state.order = fields;
        remember(state); draw();
    };
    function draw(): void {
        const scroll = tableHost.scrollLeft;
        const focused = tableHost.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : undefined;
        tableHost.replaceChildren(); tableHost.style.cssText = 'overflow:auto;max-height:460px';
        const table = document.createElement('table'); table.className = 'r-inline-table';
        const header = document.createElement('tr');
        const visible = ordered();
        for (const column of visible) {
            const th = document.createElement('th');
            th.style.textAlign = tableColumnAlignment(state.data, column);
            if (column.headerTooltip) { th.title = column.headerTooltip; }
            const sort = state.sort.find(item => item.colId === column.field)?.sort;
            th.setAttribute('aria-sort', sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none');
            if (column.field !== '0' && column.sortable !== false) {
                const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'r-inline-heading';
                heading.textContent = `${column.headerName}${sort === 'asc' ? ' ↑' : sort === 'desc' ? ' ↓' : ''}`;
                heading.setAttribute('aria-label', `Sort by ${column.headerName}`);
                heading.title = `Sort ${column.headerName}: ${sort === 'asc' ? 'descending' : sort === 'desc' ? 'original order' : 'ascending'}`;
                heading.dataset.sort = ''; heading.disabled = !available || !!pending;
                heading.onclick = () => request(0, sort === 'desc' ? [] : [{ colId: column.field, sort: sort === 'asc' ? 'desc' : 'asc' }]);
                th.append(heading);
            } else { th.textContent = column.headerName; }
            th.draggable = column.field !== '0';
            th.ondragstart = event => { dragged = column.field; event.dataTransfer?.setData('text/plain', column.field); };
            th.ondragover = event => { if (dragged && column.field !== '0') { event.preventDefault(); } };
            th.ondrop = event => { event.preventDefault(); if (dragged) { move(dragged, column.field); } dragged = undefined; };
            th.ondragend = () => { dragged = undefined; };
            header.append(th);
        }
        table.append(header);
        for (const [rowIndex, row] of ((state.data.rows ?? []) as Record<string, unknown>[]).entries()) {
            const tr = document.createElement('tr');
            for (const column of visible) {
                const td = document.createElement('td'); const value = row[column.field];
                td.textContent = tableDisplayValue(state.data, row, column.field, rowIndex);
                td.style.textAlign = tableColumnAlignment(state.data, column);
                if (typeof value === 'number' && td.textContent !== String(value)) { td.title = String(value); }
                if (value === null && ['NA', 'NaN'].includes(td.textContent)) {
                    td.style.fontStyle = 'italic'; td.style.color = 'var(--vscode-descriptionForeground)';
                    td.title = td.textContent === 'NaN' ? 'Not a number (NaN)' : 'Missing value (NA)'; td.setAttribute('aria-label', td.title);
                }
                tr.append(td);
            }
            table.append(tr);
        }
        tableHost.append(table); tableHost.scrollLeft = scroll;
        if (focused) { Array.from(tableHost.querySelectorAll<HTMLButtonElement>('[data-sort]')).find(control => control.getAttribute('aria-label') === focused)?.focus({ preventScroll: true }); }
    }

    const filterColumn = document.createElement('select'); filterColumn.setAttribute('aria-label', 'Filter column');
    const operator = document.createElement('select'); operator.setAttribute('aria-label', 'Filter operator');
    const value = document.createElement('input'); value.type = 'text'; value.maxLength = 1000; value.setAttribute('aria-label', 'Filter value');
    const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply'; apply.className = 'r-interactive-button';
    const chips = document.createElement('div'); chips.className = 'r-inline-chips';
    const hint = document.createElement('span'); hint.className = 'r-inline-hint';
    hint.textContent = hasFull ? 'Applies to the full data. Large sorts and filters may take time.' : 'Filters are combined with AND.';
    filtersPanel.append(filterColumn, operator, value, apply, chips, hint);
    const updateValue = (): void => { value.disabled = !available || !!pending || !filterNeedsValue(operator.value); };
    const updateOperators = (preserveDraft = false): void => {
        const draft = { operator: operator.value, value: value.value };
        const column = columns().find(column => column.field === filterColumn.value);
        operator.replaceChildren();
        if (column) {
            for (const op of columnOperators(column)) { operator.add(new Option(filterOperators[op as keyof typeof filterOperators], op)); }
        }
        const filter = state.filters[filterColumn.value];
        value.value = '';
        if (filter) { operator.value = filter.type; value.value = filter.filter ?? ''; }
        if (preserveDraft && Array.from(operator.options).some(option => option.value === draft.operator)) {
            operator.value = draft.operator; value.value = draft.value;
        }
        value.placeholder = column?.type === 'dateColumn' ? 'YYYY-MM-DD' : column?.type === 'datetimeColumn' ? 'YYYY-MM-DD HH:MM:SS' : 'Value';
        updateValue();
    };
    filterColumn.onchange = () => updateOperators(); operator.onchange = updateValue;
    filtersPanel.onsubmit = event => {
        event.preventDefault();
        if (!filterColumn.value) { return; }
        const column = columns().find(column => column.field === filterColumn.value);
        if (filterNeedsValue(operator.value) && (!value.value.trim() || (column?.type === 'numericColumn' && !Number.isFinite(Number(value.value))) ||
            (column?.type === 'bigintColumn' && !/^[+-]?\d+$/.test(value.value)))) {
            error = 'Enter a valid filter value.'; update(); return;
        }
        request(0, state.sort, { ...state.filters, [filterColumn.value]: { type: operator.value, ...(filterNeedsValue(operator.value) ? { filter: value.value } : {}) } });
    };
    function buildFilters(resetDraft = false): void {
        const selected = filterColumn.value; filterColumn.replaceChildren();
        for (const column of columns().filter(column => column.field !== '0' && column.filter !== false)) { filterColumn.add(new Option(column.headerName, column.field)); }
        if (!resetDraft && Array.from(filterColumn.options).some(option => option.value === selected)) { filterColumn.value = selected; }
        updateOperators(!resetDraft && filterColumn.value === selected); chips.replaceChildren();
        for (const [field, filter] of Object.entries(state.filters)) {
            const name = columns().find(column => column.field === field)?.headerName ?? field;
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'r-interactive-button';
            remove.textContent = `${name} ${filterOperators[filter.type as keyof typeof filterOperators]} ${filter.filter ?? ''} ×`;
            remove.setAttribute('aria-label', `Remove filter for ${name}`);
            remove.onclick = () => { const filters = { ...state.filters }; delete filters[field]; request(0, state.sort, filters); };
            chips.append(remove);
        }
    }
    function update(): void {
        tableHost.hidden = textMode; tools.hidden = textMode; pager.hidden = textMode;
        filtersButton.hidden = reset.hidden = textMode;
        filtersButton.setAttribute('aria-expanded', String(!!state.filterOpen));
        filtersPanel.hidden = !state.filterOpen;
        const disabled = !available || !!pending;
        first.disabled = previous.disabled = disabled || state.start === 0;
        last.disabled = next.disabled = disabled || state.start + state.size >= count() || count() === 0;
        go.disabled = number.disabled = size.disabled = disabled || count() === 0;
        number.value = String(Math.floor(state.start / state.size) + 1); number.max = String(Math.max(1, Math.ceil(count() / state.size)));
        pageCount.textContent = ` of ${Number(number.max).toLocaleString('en-US')}`; size.value = String(state.size);
        for (const control of Array.from(filtersPanel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button'))) { control.disabled = disabled; }
        updateValue(); apply.disabled ||= !filterColumn.options.length;
        for (const control of Array.from(tableHost.querySelectorAll<HTMLButtonElement>('[data-sort]'))) { control.disabled = disabled; }
        const shown = Array.isArray(state.data.rows) ? state.data.rows.length : 0;
        let label = textMode ? 'Printed R output' : pending ? 'Loading rows…' : shown
            ? `Rows ${state.start + 1}–${state.start + shown} of ${count().toLocaleString('en-US')}` : 'No matching rows';
        if (textMode) { label = [label, tableSnapshotSummary(original)].filter(Boolean).join(' · '); }
        else { label = [label, state.live ? 'Live data' : hasFull ? 'Saved preview' : '', Object.keys(state.filters).length ? 'Filtered' : ''].filter(Boolean).join(' · '); }
        status.textContent = [error || label, connectionHint].filter(Boolean).join(' · ');
        status.title = state.live && !textMode ? 'Rows are fetched on demand from the original object. Reference edits may appear. Reset restores the saved preview.'
            : hasFull ? `${tableSnapshotSummary(original)}. Browse beyond these rows, sort or filter to retrieve live data.` : '';
    }
    draw(); buildFilters(); update();
    return {
        setTextMode(text) { textMode = text; update(); },
        reply(message) {
            if (!active || !pending || message.requestId !== pending.id) { return; }
            const query = pending; pending = undefined;
            if (message.error) { error = `${String(message.error)} Use Reset to restore the saved preview.`; update(); return; }
            const result = message.result as Record<string, unknown>;
            state = { ...state, data: { ...state.data, formattedColumns: undefined, ...result }, start: Number(result.startRow ?? query.start),
                size: query.size, live: result.live === true || query.live,
                sort: result.queryReset ? [] : query.sort, filters: result.queryReset ? {} : query.filters };
            if (result.queryReset) { state.order = []; error = 'Columns changed; sorting and filters were cleared.'; }
            remember(state); draw(); buildFilters(result.queryReset === true); update();
        },
        dispose() { active = false; pending = undefined; tableHost.replaceChildren(); tools.replaceChildren(); pager.replaceChildren(); },
    };
}

export const inlineTableStyle = `
.r-inline-table{border-collapse:collapse;font-size:12px;min-width:320px}
.r-inline-table th,.r-inline-table td{padding:4px 14px;border-bottom:1px solid var(--vscode-panel-border);white-space:pre}
.r-inline-table th{position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
.r-inline-heading{font-weight:bold!important;color:inherit;background:transparent;border:0;padding:2px 0;cursor:pointer;text-align:inherit}
.r-inline-pager,.r-inline-panel{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.r-inline-pager{flex-basis:100%;margin-top:4px}
.r-inline-pager input{width:8ch}
.r-inline-panel{padding:8px 0;font-size:12px}
.r-inline-panel select{max-width:180px}.r-inline-panel input{width:160px;max-width:100%}
.r-inline-tools input,.r-inline-tools select,.r-inline-pager input,.r-inline-pager select{font:inherit;color:var(--vscode-input-foreground,inherit);background:var(--vscode-input-background,transparent);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:4px}
.r-inline-chips,.r-inline-hint{flex-basis:100%}.r-inline-hint{opacity:.7}
.r-inline-heading:focus-visible,.r-inline-tools :focus-visible,.r-inline-pager :focus-visible{outline:1px solid var(--vscode-focusBorder,#007acc);outline-offset:1px}
`;
