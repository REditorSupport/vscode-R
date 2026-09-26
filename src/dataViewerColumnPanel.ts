'use strict';

export function getDataViewerColumnPanelStyle(): string {
    return `
    #columnPanel {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 30;
        display: none;
        width: min(380px, 100%);
        height: 100%;
        box-sizing: border-box;
        border-left: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
        color: var(--vscode-sideBar-foreground);
        box-shadow: -4px 0 12px rgba(0, 0, 0, 0.2);
    }

    #columnPanel.visible {
        display: flex;
        flex-direction: column;
    }

    #columnPanelHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-weight: 600;
    }

    #columnPanelClose {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
    }

    #columnPanelSearch {
        margin: 8px 12px; padding: 5px; box-sizing: border-box; min-width: 0;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
    }

    .column-panel-item[hidden] { display: none; }
    .column-panel-pin {
        margin-left: auto; max-width: 85px; padding: 2px;
        color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border);
    }

    #columnPanelActions {
        display: flex;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
    }

    #columnPanelActions button {
        border: 0;
        padding: 4px 8px;
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
    }

    #columnPanelActions button:disabled {
        color: var(--vscode-disabledForeground);
        opacity: 0.6;
        cursor: default;
    }

    #columnPanelList {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }

    .column-panel-item {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        padding: 0 12px;
        cursor: grab;
        user-select: none;
    }

    .column-panel-item:hover {
        background-color: var(--vscode-list-hoverBackground);
        color: var(--vscode-list-hoverForeground);
    }

    .column-panel-item.dragging {
        opacity: 0.5;
    }

    .column-panel-item.drag-over {
        border-top: 2px solid var(--vscode-focusBorder);
    }

    .column-panel-item input {
        margin: 0;
        cursor: pointer;
    }

    .column-panel-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    `;
}

export function getDataViewerColumnPanelHtml(): string {
    return `
        <div id="columnPanel" aria-label="Columns panel">
            <div id="columnPanelHeader">
                <span>Columns</span>
                <button id="columnPanelClose" type="button" aria-label="Close columns panel">×</button>
            </div>
            <input id="columnPanelSearch" type="search" aria-label="Search columns" placeholder="Search columns">
            <div id="columnPanelActions">
                <button id="columnSelectAll" type="button">Select all</button>
                <button id="columnDeselectAll" type="button">Deselect all</button>
            </div>
            <div id="columnPanelList"></div>
        </div>
    `;
}

export function getDataViewerColumnPanelScript(): string {
    return `
    function initializeColumnPanel() {
        const panel = document.querySelector('#columnPanel');
        const toggle = document.querySelector('#columnPanelToggle');
        const close = document.querySelector('#columnPanelClose');
        const selectAll = document.querySelector('#columnSelectAll');
        const deselectAll = document.querySelector('#columnDeselectAll');
        const list = document.querySelector('#columnPanelList');
        const search = document.querySelector('#columnPanelSearch');
        if (!gridApi || !panel || !toggle || !close || !selectAll || !deselectAll || !list || !search) {
            return;
        }

        function getSelectableColumns() {
            return gridApi.getAllGridColumns().filter(column => column.getColId() !== '0');
        }

        function matchingColumns() {
            const query = search.value.toLocaleLowerCase();
            return getSelectableColumns().filter(column =>
                String(column.getColDef().headerName ?? column.getColId()).toLocaleLowerCase().includes(query));
        }

        function updateVisibility() {
            if (!panel.classList.contains('visible')) {
                return;
            }
            const matches = new Set(matchingColumns().map(column => column.getColId()));
            let visibleCount = 0;
            for (const item of list.children) {
                const column = gridApi.getColumn(item.dataset.colId);
                item.hidden = !matches.has(item.dataset.colId);
                item.querySelector('input').checked = column.isVisible();
                item.querySelector('select').value = column.getPinned() || '';
                visibleCount += !item.hidden && column.isVisible() ? 1 : 0;
            }
            selectAll.disabled = visibleCount === matches.size;
            deselectAll.disabled = visibleCount === 0;
            selectAll.textContent = search.value ? 'Show matching' : 'Select all';
            deselectAll.textContent = search.value ? 'Hide matching' : 'Deselect all';
        }

        function renderColumns() {
            const scrollTop = list.scrollTop;
            list.replaceChildren();

            for (const column of getSelectableColumns()) {
                const colId = column.getColId();
                const name = String(column.getColDef().headerName ?? colId);
                const item = document.createElement('div');
                item.className = 'column-panel-item';
                item.draggable = true;
                item.dataset.colId = colId;

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.setAttribute('aria-label', 'Show ' + name);

                const label = document.createElement('span');
                label.className = 'column-panel-label';
                label.textContent = name;
                label.title = name;

                const pin = document.createElement('select');
                pin.className = 'column-panel-pin';
                pin.setAttribute('aria-label', 'Pin ' + name);
                for (const [value, text] of [['', 'Unpinned'], ['left', 'Pin left'], ['right', 'Pin right']]) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = text;
                    pin.append(option);
                }
                item.append(checkbox, label, pin);
                list.append(item);
            }

            updateVisibility();
            list.scrollTop = scrollTop;
        }

        function setAllVisible(visible) {
            gridApi.setColumnsVisible(matchingColumns().map(column => column.getColId()), visible);
        }

        gridApi.addEventListener('columnVisible', updateVisibility);
        gridApi.addEventListener('columnPinned', updateVisibility);
        gridApi.addEventListener('columnsReset', () => {
            if (panel.classList.contains('visible')) { renderColumns(); }
        });
        search.addEventListener('input', updateVisibility);
        gridApi.addEventListener('columnMoved', event => {
            if (event.finished !== false && panel.classList.contains('visible')) {
                renderColumns();
            }
        });

        toggle.addEventListener('click', () => {
            const visible = panel.classList.toggle('visible');
            toggle.setAttribute('aria-expanded', String(visible));
            if (visible) {
                renderColumns();
                search.focus();
            }
        });
        close.addEventListener('click', () => {
            panel.classList.remove('visible');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.focus();
        });
        panel.addEventListener('keydown', event => {
            if (event.key === 'Escape') { close.click(); }
        });
        selectAll.addEventListener('click', () => setAllVisible(true));
        deselectAll.addEventListener('click', () => setAllVisible(false));
        list.addEventListener('change', event => {
            const checkbox = event.target;
            if (checkbox.matches('input[type="checkbox"]')) {
                gridApi.setColumnsVisible([checkbox.closest('.column-panel-item').dataset.colId], checkbox.checked);
            } else if (checkbox.matches('select')) {
                gridApi.setColumnsPinned([checkbox.closest('.column-panel-item').dataset.colId], checkbox.value || null);
            }
        });

        let draggedItem;
        let dropTarget;

        function clearDrag() {
            draggedItem?.classList.remove('dragging');
            dropTarget?.classList.remove('drag-over');
            draggedItem = undefined;
            dropTarget = undefined;
        }

        list.addEventListener('dragstart', event => {
            const item = event.target.closest('.column-panel-item');
            if (!item || event.target.closest('input, select')) {
                return;
            }
            draggedItem = item;
            item.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
        });

        list.addEventListener('dragend', clearDrag);

        list.addEventListener('dragover', event => {
            if (!draggedItem) {
                return;
            }
            event.preventDefault();
            const target = event.target.closest('.column-panel-item');
            if (target !== dropTarget) {
                dropTarget?.classList.remove('drag-over');
                dropTarget = target === draggedItem ? undefined : target;
                dropTarget?.classList.add('drag-over');
            }
        });

        list.addEventListener('drop', event => {
            event.preventDefault();
            const target = event.target.closest('.column-panel-item');
            if (!target || !draggedItem || target === draggedItem) {
                clearDrag();
                return;
            }

            const targetRect = target.getBoundingClientRect();
            const insertAfter = event.clientY > targetRect.top + targetRect.height / 2;
            list.insertBefore(draggedItem, insertAfter ? target.nextSibling : target);
            clearDrag();
            gridApi.applyColumnState({
                state: Array.from(list.children, item => ({ colId: item.dataset.colId })),
                applyOrder: true
            });
        });
    }
    `;
}
