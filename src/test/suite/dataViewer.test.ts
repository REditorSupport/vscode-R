import * as assert from 'assert';
import * as vm from 'vm';
import type { ColDef, ColumnState, GridOptions, GridState } from 'ag-grid-community';
import { getDataViewerScript } from '../../dataViewer';

interface SavedViewer {
    schema: string;
    gridState: GridState;
    floatingFilters: boolean;
    sizingMode?: 'fit' | 'content';
}

interface ViewerScript {
    prepareViewerColumns(columns: ColDef[]): string[];
    prepareViewerRows(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[];
    getViewerGridOptions(pageSize: number): GridOptions;
    saveViewerState(): void;
    getAgTheme(): unknown;
    setViewerSizingMode(mode: 'fit' | 'content'): void;
}

function viewerScript(saved?: SavedViewer, gridState: GridState = {}, light = false): {
    script: ViewerScript;
    stored: () => SavedViewer | undefined;
    appliedColumns: () => ColumnState[];
    contentSizingCalls: () => number;
} {
    let stored: SavedViewer | undefined;
    let appliedColumns: ColumnState[] = [];
    let contentSizingCalls = 0;
    const script = vm.runInNewContext(`${getDataViewerScript()}
        ({ prepareViewerColumns, prepareViewerRows, getViewerGridOptions, saveViewerState, getAgTheme, setViewerSizingMode })`, {
        vscode: {
            getState: () => saved,
            setState: (value: SavedViewer) => { stored = value; },
        },
        gridApi: {
            getState: () => gridState,
            getColumns: () => ['0', '1', '2'].map(colId => ({ getColId: () => colId })),
            applyColumnState: ({ state }: { state: ColumnState[] }) => { appliedColumns = state; },
            autoSizeAllColumns: () => { contentSizingCalls++; },
        },
        document: {
            body: { classList: { contains: (name: string) => light && name === 'vscode-high-contrast-light' } },
            createElement: () => ({ className: '', textContent: '' }),
            querySelector: () => ({ setAttribute: () => undefined }),
        },
        window: {
            agGrid: {
                themeBalham: { withPart: (scheme: unknown) => scheme },
                colorSchemeLight: 'light', colorSchemeDark: 'dark',
            },
        },
    }) as ViewerScript;
    return {
        script, stored: () => stored,
        appliedColumns: () => appliedColumns, contentSizingCalls: () => contentSizingCalls,
    };
}

const columns = (): ColDef[] => [
    { field: '0', headerName: ' ', type: 'numericColumn', filter: false, sortable: false },
    { field: '1', headerName: 'Name', type: 'textColumn', filter: 'agTextColumnFilter' },
    { field: '2', headerName: 'Value', type: 'numericColumn', filter: 'agNumberColumnFilter' },
];

suite('Data viewer', () => {
    test('defaults to flexible widths and prevents content sizing on scroll and resize', () => {
        const viewer = viewerScript();
        viewer.script.prepareViewerColumns(columns());
        const options = viewer.script.getViewerGridOptions(500);
        assert.strictEqual(options.defaultColDef?.initialFlex, 1);
        assert.strictEqual(options.autoSizeStrategy, undefined);
        assert.strictEqual(viewer.contentSizingCalls(), 0);
    });

    test('content sizing runs only on request and switching back to fit restores flex', () => {
        const viewer = viewerScript();
        viewer.script.prepareViewerColumns(columns());
        viewer.script.getViewerGridOptions(500);
        viewer.script.setViewerSizingMode('content');
        assert.ok(viewer.appliedColumns().every(column => column.flex === null));
        assert.strictEqual(viewer.contentSizingCalls(), 1);
        assert.strictEqual(viewer.stored()?.sizingMode, 'content');

        viewer.script.setViewerSizingMode('fit');
        assert.strictEqual(viewer.appliedColumns()[0].flex, null);
        assert.ok(viewer.appliedColumns().slice(1).every(column => column.flex === 1));
        assert.strictEqual(viewer.contentSizingCalls(), 1);
        assert.strictEqual(viewer.stored()?.sizingMode, 'fit');
    });

    test('old saved content widths do not disable the new default fit mode', () => {
        const first = viewerScript(undefined, {
            columnSizing: { columnSizingModel: [{ colId: '1', width: 70 }, { colId: '2', width: 80 }] },
            columnVisibility: { hiddenColIds: ['2'] },
        });
        first.script.prepareViewerColumns(columns());
        first.script.saveViewerState();
        const saved = first.stored();
        assert.ok(saved);
        delete saved.sizingMode;
        delete saved.gridState.partialColumnState;
        const next = viewerScript(saved).script;
        next.prepareViewerColumns(columns());
        const options = next.getViewerGridOptions(500);
        assert.strictEqual(options.defaultColDef?.initialFlex, 1);
        assert.strictEqual(options.initialState?.columnSizing, undefined);
        assert.strictEqual(options.initialState?.partialColumnState, true);
        assert.strictEqual(options.initialState?.columnVisibility, saved.gridState.columnVisibility);
        assert.ok(saved.gridState.columnSizing, 'restoring must not mutate the saved view');
    });

    test('restores the chosen sizing mode and its column widths or flex values', () => {
        for (const mode of ['fit', 'content'] as const) {
            const first = viewerScript(undefined, {
                columnSizing: { columnSizingModel: [{ colId: '1', flex: mode === 'fit' ? 1 : undefined, width: 120 }] },
            });
            first.script.prepareViewerColumns(columns());
            first.script.setViewerSizingMode(mode);
            const saved = first.stored();
            const next = viewerScript(saved).script;
            next.prepareViewerColumns(columns());
            const options = next.getViewerGridOptions(500);
            assert.strictEqual(options.defaultColDef?.initialFlex, mode === 'fit' ? 1 : 0);
            assert.strictEqual(options.initialState?.columnSizing, saved?.gridState.columnSizing);
        }
    });

    test('restores sort, filters and layout only for the same R schema', () => {
        const state: GridState = {
            columnVisibility: { hiddenColIds: ['2'] },
            sort: { sortModel: [{ colId: '2', sort: 'desc' }] },
            filter: { filterModel: { '1': { filterType: 'text', type: 'contains', filter: 'apple' } } },
        };
        const first = viewerScript(undefined, state);
        first.script.prepareViewerColumns(columns());
        first.script.saveViewerState();
        const saved = first.stored();
        assert.ok(saved);
        saved.floatingFilters = true;

        const next = viewerScript(saved).script;
        next.prepareViewerColumns(columns());
        const options = next.getViewerGridOptions(500);
        assert.strictEqual(options.initialState?.filter, state.filter);
        assert.strictEqual(options.initialState?.sort, state.sort);
        assert.strictEqual(options.initialState?.columnVisibility, state.columnVisibility);
        assert.strictEqual(options.defaultColDef?.floatingFilter, true);

        const changes: ColDef[][] = [
            columns().map(column => column.field === '1' ? { ...column, headerName: 'Another variable' } : column),
            columns().map(column => column.field === '2' ? { ...column, type: 'textColumn' } : column),
            columns().reverse(),
            columns().slice(0, 2),
        ];
        for (const changed of changes) {
            const refreshed: ViewerScript = viewerScript(saved).script;
            refreshed.prepareViewerColumns(changed);
            assert.strictEqual(refreshed.getViewerGridOptions(500).initialState, undefined);
            assert.strictEqual(refreshed.getViewerGridOptions(500).defaultColDef?.floatingFilter, false);
        }
    });

    test('refresh keeps page size without restoring row positions or selected rows', () => {
        const viewer = viewerScript(undefined, {
            pagination: { page: 12, pageSize: 200 },
            scroll: { top: 5000, left: 0 },
            rowSelection: ['42'],
        });
        viewer.script.prepareViewerColumns(columns());
        viewer.script.saveViewerState();
        const state = viewer.stored()?.gridState;
        assert.strictEqual(state?.pagination?.pageSize, 200);
        assert.strictEqual(state?.pagination?.page, undefined);
        assert.strictEqual(state?.scroll, undefined);
        assert.strictEqual(state?.rowSelection, undefined);
    });

    test('uses native date, datetime, boolean and bigint types in both viewer modes', () => {
        const defs: ColDef[] = [
            ...columns(),
            { field: '3', type: 'dateColumn' },
            { field: '4', type: 'datetimeColumn' },
            { field: '5', type: 'booleanColumn' },
            { field: '6', type: 'bigintColumn' },
            { field: '7', type: 'textColumn', filter: false, sortable: false },
        ];
        const script = viewerScript().script;
        assert.deepStrictEqual(Array.from(script.prepareViewerColumns(defs)), ['6']);
        assert.strictEqual(defs[2].cellDataType, 'number');
        assert.strictEqual(defs[3].cellDataType, 'dateString');
        assert.strictEqual(defs[4].cellDataType, 'dateTimeString');
        assert.strictEqual(defs[4].filter, 'agDateColumnFilter');
        assert.strictEqual(defs[5].cellDataType, 'boolean');
        assert.strictEqual(defs[6].cellDataType, 'bigint');
        assert.strictEqual(defs[6].filter, 'agBigIntColumnFilter');
        assert.strictEqual(defs[7].filter, false);
        assert.strictEqual(defs[7].sortable, false);
        assert.strictEqual(defs[0].pinned, 'left');
        assert.strictEqual(defs[0].lockVisible, true);
    });

    test('keeps integer64 precision and missing values when loading rows', () => {
        const script = viewerScript().script;
        const rows = script.prepareViewerRows([
            { '1': '9007199254740993', '2': '001' },
            { '1': '-9223372036854775807', '2': '' },
            { '1': null },
        ], ['1']);
        assert.strictEqual(rows[0]['1'], 9007199254740993n);
        assert.strictEqual(rows[1]['1'], -9223372036854775807n);
        assert.strictEqual(rows[2]['1'], null);
        assert.strictEqual(rows[0]['2'], '001');
        assert.strictEqual(rows[1]['2'], '');
    });

    test('page-size choices are positive, sorted and unique, including restored sizes', () => {
        for (const pageSize of [0, 20, 50, 75, 500]) {
            const first = viewerScript(undefined, { pagination: { pageSize: 200 } });
            first.script.prepareViewerColumns(columns());
            first.script.saveViewerState();
            const script = viewerScript(first.stored()).script;
            script.prepareViewerColumns(columns());
            const options = script.getViewerGridOptions(pageSize);
            const expected = [...new Set([20, 50, 100, pageSize || 500, 200])].sort((a, b) => a - b);
            assert.deepStrictEqual(Array.from(options.paginationPageSizeSelector as number[]), expected);
            assert.strictEqual(options.pagination, pageSize > 0);
        }
    });

    test('high contrast light uses the light grid theme', () => {
        assert.strictEqual(viewerScript(undefined, {}, true).script.getAgTheme(), 'light');
        assert.strictEqual(viewerScript().script.getAgTheme(), 'dark');
    });
});
