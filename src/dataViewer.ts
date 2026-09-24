'use strict';

export function getDataViewerStyle(): string {
    return `
    body {
        display: flex; flex-direction: column; overflow: hidden;
        font: var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif);
    }
    #gridContainer { position: relative; flex: 1; min-height: 0; }
    #viewerToolbar {
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
        padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background); color: var(--vscode-foreground);
        font: var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif);
    }
    #viewerToolbar button {
        padding: 4px 8px; border: 1px solid transparent; border-radius: 3px;
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
        font: inherit; cursor: pointer;
    }
    #viewerToolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #viewerToolbar button[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
    #viewerToolbar button:disabled { opacity: 0.5; cursor: default; }
    #viewerToolbar button:focus-visible, #columnPanel :focus-visible {
        outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
    }
    #viewerRowCount { margin-left: auto; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .dataview-na { color: var(--vscode-descriptionForeground); font-style: italic; opacity: 0.75; }
    `;
}

export function getDataViewerToolbarHtml(): string {
    return `
    <div id="viewerToolbar" role="group" aria-label="Data viewer controls">
        <button id="columnPanelToggle" type="button" aria-controls="columnPanel" aria-expanded="false">Columns</button>
        <button id="viewerFilters" type="button" aria-pressed="false" title="Show filters below the headers. Press Enter to apply text and number filters.">Filters</button>
        <button id="viewerClearFilters" type="button" disabled>Clear filters</button>
        <button id="viewerAutoSize" type="button" aria-pressed="false" title="Size columns to their loaded contents">Size to content</button>
        <button id="viewerFit" type="button" aria-pressed="true" title="Keep columns fitted to the available width">Fit width</button>
        <button id="viewerReset" type="button" title="Reset column layout, sorting, filters and page size">Reset view</button>
        <span id="viewerRowCount" role="status" aria-live="polite"></span>
    </div>
    `;
}

// Shared by the on-demand and file-backed viewers. Kept independent of VS Code so
// column conversion and state restoration can also be exercised outside a webview.
export function getDataViewerScript(): string {
    return `
    let viewerSchema;
    let viewerFloatingFilters = false;
    let viewerInitialState;
    let viewerDefaultPageSize;
    let viewerSizingMode = 'fit';
    const emptyCellRenderer = () => '';
    const naCellRenderer = () => {
        const element = document.createElement('span');
        element.className = 'dataview-na';
        element.textContent = 'NA';
        return element;
    };

    function getAgTheme() {
        const light = document.body.classList.contains('vscode-light') ||
            document.body.classList.contains('vscode-high-contrast-light');
        return window.agGrid.themeBalham.withPart(light
            ? window.agGrid.colorSchemeLight : window.agGrid.colorSchemeDark);
    }

    function prepareViewerColumns(columns) {
        // R uses positional field IDs. Never restore a filter onto a renamed,
        // reordered or differently typed column after a repeated View() call.
        viewerSchema = JSON.stringify(columns.map(column => [
            column.field, column.headerName, column.type, column.cellDataType,
            column.filter, column.sortable, column.headerTooltip
        ]));
        const saved = vscode.getState?.();
        viewerInitialState = saved?.schema === viewerSchema ? saved.gridState : undefined;
        viewerFloatingFilters = saved?.schema === viewerSchema && saved.floatingFilters === true;
        viewerSizingMode = saved?.schema === viewerSchema && saved.sizingMode === 'content' ? 'content' : 'fit';
        if (viewerInitialState && !saved.sizingMode) {
            // Older views saved fixed content widths. Let the new default flex
            // sizing take over without losing their filters or column layout.
            viewerInitialState = { ...viewerInitialState, partialColumnState: true };
            delete viewerInitialState.columnSizing;
        }
        const bigintFields = [];
        for (const column of columns) {
            column.cellRendererSelector = params => {
                if (params.data == null) {
                    return { component: emptyCellRenderer };
                }
                return params.value == null ? { component: naCellRenderer } : undefined;
            };
            if (column.type === 'dateColumn' || column.type === 'datetimeColumn') {
                column.cellDataType = column.type === 'dateColumn' ? 'dateString' : 'dateTimeString';
                column.filter = 'agDateColumnFilter';
                column.filterParams = { browserDatePicker: true };
                column.initialWidth = 200;
            } else if (column.type === 'bigintColumn') {
                column.cellDataType = 'bigint';
                column.filter = 'agBigIntColumnFilter';
                bigintFields.push(column.field);
            } else if (column.type === 'numericColumn') {
                column.cellDataType = 'number';
            } else if (column.type === 'booleanColumn') {
                column.cellDataType = 'boolean';
                column.filterParams = { buttons: ['reset'] };
            }
            if (column.field === '0') {
                column.pinned = 'left';
                column.lockPinned = true;
                column.lockPosition = 'left';
                column.lockVisible = true;
                column.floatingFilter = false;
                column.suppressSizeToFit = true;
                column.flex = 0;
            }
            if (column.type !== 'numericColumn') {
                delete column.type;
            }
        }
        return bigintFields;
    }

    function prepareViewerRows(rows, bigintFields) {
        for (const row of rows) {
            for (const field of bigintFields) {
                if (row[field] != null) {
                    row[field] = BigInt(row[field]);
                }
            }
        }
        return rows;
    }

    function saveViewerState() {
        if (!gridApi || !viewerSchema) {
            return;
        }
        const state = gridApi.getState();
        // A refreshed object can have fewer rows. Preserve page size, but start
        // at the first page instead of restoring an invalid page/scroll offset.
        const gridState = {
            version: state.version,
            columnOrder: state.columnOrder,
            columnSizing: state.columnSizing,
            columnPinning: state.columnPinning,
            columnVisibility: state.columnVisibility,
            sort: state.sort,
            filter: state.filter,
            pagination: { pageSize: state.pagination?.pageSize }
        };
        vscode.setState?.({
            schema: viewerSchema, gridState, floatingFilters: viewerFloatingFilters,
            sizingMode: viewerSizingMode
        });
    }

    function getViewerGridOptions(pageSize) {
        viewerDefaultPageSize = pageSize > 0 ? pageSize : 500;
        const restoredPageSize = viewerInitialState?.pagination?.pageSize;
        return {
            theme: getAgTheme(),
            initialState: viewerInitialState,
            defaultColDef: {
                sortable: true, resizable: true, filter: true, cellDataType: false,
                floatingFilter: viewerFloatingFilters,
                initialWidth: 100, minWidth: 50,
                initialFlex: viewerSizingMode === 'fit' ? 1 : 0,
                filterParams: { buttons: ['reset', 'apply'] },
                // v36.2's tooltip API displays the complete formatted cell value.
                tooltip: true
            },
            // Flex owns fit-width sizing. Content sizing is an explicit toolbar
            // action so scrolling or resizing cannot replace the fitted widths.
            pagination: pageSize > 0,
            paginationPageSize: viewerDefaultPageSize,
            paginationPageSizeSelector: [...new Set([
                20, 50, 100, viewerDefaultPageSize, restoredPageSize
            ].filter(size => Number.isInteger(size) && size > 0))].sort((a, b) => a - b),
            enableCellTextSelection: true,
            ensureDomOrder: true,
            tooltipShowDelay: 300,
            onStateUpdated: saveViewerState
        };
    }

    function updateViewerRowCount(filtered, total) {
        const format = value => new Intl.NumberFormat().format(value);
        document.querySelector('#viewerRowCount').textContent = filtered === total
            ? format(total) + ' rows' : format(filtered) + ' of ' + format(total) + ' rows';
    }

    function updateViewerSizingButtons() {
        document.querySelector('#viewerFit').setAttribute('aria-pressed', String(viewerSizingMode === 'fit'));
        document.querySelector('#viewerAutoSize').setAttribute('aria-pressed', String(viewerSizingMode === 'content'));
    }

    function setViewerSizingMode(mode) {
        viewerSizingMode = mode;
        gridApi.applyColumnState({
            state: gridApi.getColumns().map(column => ({
                colId: column.getColId(),
                flex: mode === 'fit' && column.getColId() !== '0' ? 1 : null
            }))
        });
        if (mode === 'content') {
            gridApi.autoSizeAllColumns({ defaultMaxWidth: 480 });
        }
        updateViewerSizingButtons();
        saveViewerState();
    }

    function initializeViewerToolbar() {
        const filters = document.querySelector('#viewerFilters');
        const clear = document.querySelector('#viewerClearFilters');
        const updateFilters = () => {
            filters.setAttribute('aria-pressed', String(viewerFloatingFilters));
            clear.disabled = Object.keys(gridApi.getFilterModel()).length === 0;
        };
        const setFloatingFilters = visible => {
            viewerFloatingFilters = visible;
            gridApi.setGridOption('defaultColDef', {
                ...gridApi.getGridOption('defaultColDef'), floatingFilter: visible
            });
            updateFilters();
            saveViewerState();
        };
        filters.addEventListener('click', () => setFloatingFilters(!viewerFloatingFilters));
        clear.addEventListener('click', () => gridApi.setFilterModel(null));
        document.querySelector('#viewerAutoSize').addEventListener('click', () => setViewerSizingMode('content'));
        document.querySelector('#viewerFit').addEventListener('click', () => setViewerSizingMode('fit'));
        document.querySelector('#viewerReset').addEventListener('click', () => {
            gridApi.setFilterModel(null);
            gridApi.resetColumnState();
            gridApi.setGridOption('paginationPageSize', viewerDefaultPageSize);
            gridApi.paginationGoToFirstPage();
            setFloatingFilters(false);
            setViewerSizingMode('fit');
        });
        gridApi.addEventListener('filterChanged', updateFilters);
        window.addEventListener('pagehide', saveViewerState);
        updateFilters();
        updateViewerSizingButtons();
        initializeColumnPanel();
    }
    `;
}
