import * as assert from 'node:assert/strict';
import {
    JdvDescriptor,
    JdvRequestError,
    TreeAdapter,
    gridColumnDefs,
    gridPageFromRows,
    isVectorType,
    canRefresh,
    cellOpenParams,
    revealsPanel,
    parseDescriptor,
    parseTracking,
    tableRowsParams,
    toJdvFilter,
} from '../../jdvAdapter';

const capabilities = {
    seek: true,
    sort: true,
    filter: true,
    known_total: true,
    next: false,
    children: false,
    refresh: true,
    track: false,
};

const grid: JdvDescriptor = parseDescriptor({
    view: 'v-1',
    generation: 2,
    kind: 'grid',
    access: 'random',
    encoding: 'jdv-json',
    capabilities,
    title: 'df',
    collation: 'C',
    nrow: 3,
    ncol: 6,
    columns: [
        {
            position: 0,
            name: 'a',
            type: 'number',
            native_type: ['numeric'],
            sortable: true,
            filterable: true,
        },
        {
            position: 1,
            name: 'b',
            type: 'categorical',
            native_type: ['factor'],
            sortable: true,
            filterable: true,
            levels: ['x', 'y'],
        },
        {
            position: 2,
            name: 'd',
            type: 'date',
            native_type: ['Date'],
            sortable: true,
            filterable: true,
        },
        {
            position: 3,
            name: 't',
            type: 'datetime',
            native_type: ['POSIXct', 'POSIXt'],
            sortable: true,
            filterable: true,
            tz: 'UTC',
        },
        {
            position: 4,
            name: 'i',
            type: 'int64',
            native_type: ['integer64'],
            sortable: true,
            filterable: true,
        },
        {
            position: 5,
            name: 'a',
            type: 'other',
            native_type: ['AsIs'],
            sortable: false,
            filterable: false,
            drillable: true,
        },
    ],
});

suite('jdv adapter', () => {
    test('validates descriptors', () => {
        assert.equal(grid.view, 'v-1');
        assert.equal(grid.generation, 2);
        assert.throws(() => parseDescriptor({}));
        assert.throws(() => parseDescriptor({ ...grid, columns: undefined }));
        assert.throws(() => parseDescriptor({ ...grid, view: '' }));
        assert.throws(() => parseDescriptor({ ...grid, generation: 0 }));
        assert.throws(() => parseDescriptor({ ...grid, collation: 'locale-ish' }));
        assert.throws(() => parseDescriptor({ ...grid, collation: undefined }));
        assert.throws(() => parseDescriptor({ ...grid, encoding: 'unsupported-encoding' }));
        assert.throws(() => parseDescriptor({ ...grid, nrow: null }));
        assert.throws(() =>
            parseDescriptor({ ...grid, capabilities: { ...capabilities, seek: false } }),
        );
        assert.throws(() =>
            parseDescriptor({ ...grid, capabilities: { ...capabilities, sort: 'yes' } }),
        );
    });

    test('treats omitted capabilities as false', () => {
        const bare = parseDescriptor({ ...grid, access: 'snapshot', capabilities: undefined });
        assert.deepEqual(Object.values(bare.capabilities), Array(8).fill(false));
    });

    test('requires max_page_rows for sequential views', () => {
        const sequential = {
            view: 'v-3',
            generation: 1,
            kind: 'grid',
            access: 'sequential',
            encoding: 'arrow-ipc',
            capabilities: { next: true },
            nrow: null,
            ncol: 0,
            columns: [],
        };
        assert.throws(() => parseDescriptor(sequential));
        assert.equal(parseDescriptor({ ...sequential, max_page_rows: 10 }).max_page_rows, 10);
    });

    test('reveals the panel unless the update is tracked or a refresh', () => {
        assert.equal(grid.reason, undefined);
        assert.equal(revealsPanel(grid), true);
        for (const reason of ['register', 'child', 'something-new']) {
            assert.equal(revealsPanel(parseDescriptor({ ...grid, reason })), true, reason);
        }
        for (const reason of ['tracked', 'refresh']) {
            const descriptor = parseDescriptor({ ...grid, reason });
            assert.equal(descriptor.reason, reason);
            assert.equal(revealsPanel(descriptor), false, reason);
        }
        // A non-string reason is ignored.
        assert.equal(parseDescriptor({ ...grid, reason: 5 }).reason, undefined);
    });

    test('offers refresh only for refreshable, non-sequential views', () => {
        assert.equal(canRefresh(grid), true);
        assert.equal(canRefresh({ ...grid, access: 'sequential' }), false);
        assert.equal(
            canRefresh({ ...grid, capabilities: { ...capabilities, refresh: false } }),
            false,
        );
        assert.equal(
            canRefresh(
                parseDescriptor({ ...grid, capabilities: { seek: true, known_total: true } }),
            ),
            false,
        );
    });

    test('builds column definitions from the schema', () => {
        const columns = gridColumnDefs(grid);
        assert.deepEqual(
            columns.map((column) => column.field),
            ['0', '1', '2', '3', '4', '5', '6'],
        );
        assert.equal(columns[0].sortable, false);
        assert.equal(columns[1].type, 'numericColumn');
        assert.ok(columns[1].jdv?.filterOptions.includes('inRange'));
        assert.deepEqual(columns[5].jdv?.filterOptions, ['equals', 'inRange']);
        assert.equal(columns[6].sortable, false);
        // Non-filterable columns still offer the NA operators.
        assert.deepEqual(columns[6].jdv, { filterOptions: [], naOptions: true });
        assert.match(columns[2].headerTooltip ?? '', /levels: x, y/);
    });

    test('keeps text operators to strings and factors, and handles durations', () => {
        const descriptor = parseDescriptor({
            ...grid,
            columns: [
                {
                    position: 0,
                    name: 's',
                    type: 'string',
                    class: ['character'],
                    sortable: true,
                    filterable: true,
                },
                {
                    position: 1,
                    name: 'l',
                    type: 'list',
                    class: ['list'],
                    sortable: false,
                    filterable: false,
                },
                {
                    position: 2,
                    name: 'u',
                    type: 'future',
                    class: ['character'],
                    sortable: true,
                    filterable: true,
                },
                {
                    position: 3,
                    name: 'o',
                    type: 'other',
                    class: ['character'],
                    sortable: false,
                    filterable: true,
                },
                {
                    position: 4,
                    name: 'dt',
                    type: 'duration',
                    class: ['difftime'],
                    sortable: true,
                    filterable: true,
                    units: 'mins',
                },
            ],
        });
        const columns = gridColumnDefs(descriptor);
        assert.ok(columns[1].jdv?.filterOptions.includes('contains'));
        // List, other and unknown types are display-only: NA options but no value operators,
        // whatever `class` suggests. They still follow `sortable`.
        for (const index of [2, 3, 4]) {
            assert.deepEqual(
                columns[index].jdv,
                { filterOptions: [], naOptions: true },
                String(index),
            );
        }
        assert.equal(columns[3].sortable, true);
        assert.equal(columns[4].sortable, false);
        for (const field of ['2', '3', '4']) {
            assert.deepEqual(
                toJdvFilter({ [field]: { filterType: 'text', type: 'jdvNotNa' } }, descriptor),
                { op: 'not', arg: { op: 'is_na', col: Number(field) - 1 } },
            );
            assert.throws(
                () =>
                    toJdvFilter(
                        { [field]: { filterType: 'text', type: 'contains', filter: 'x' } },
                        descriptor,
                    ),
                (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
                field,
            );
        }
        // The server may allow an unknown type to be filtered; the host still never guesses.
        assert.throws(
            () =>
                toJdvFilter(
                    { '3': { filterType: 'text', type: 'contains', filter: 'x' } },
                    descriptor,
                ),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
        );

        assert.equal(columns[5].type, 'numericColumn');
        assert.equal(columns[5].filter, 'agNumberColumnFilter');
        assert.ok(columns[5].jdv?.filterOptions.includes('inRange'));
        assert.equal(columns[5].jdv?.units, 'mins');
        assert.match(columns[5].headerTooltip ?? '', /units: mins/);
        assert.deepEqual(
            toJdvFilter(
                { '5': { filterType: 'number', type: 'lessThanOrEqual', filter: 90 } },
                descriptor,
            ),
            { op: 'le', col: 4, value: 90 },
        );
        assert.deepEqual(
            toJdvFilter(
                {
                    '5': {
                        filterType: 'number',
                        type: 'inRange',
                        filter: 1.5,
                        filterTo: '2:00:00',
                    },
                },
                descriptor,
            ),
            { op: 'between', col: 4, lower: 1.5, upper: '2:00:00' },
        );
        assert.throws(
            () =>
                toJdvFilter(
                    { '5': { filterType: 'number', type: 'equals', filter: 'abc' } },
                    descriptor,
                ),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'invalid_request',
        );
    });

    test('parses tracking and drops a malformed one', () => {
        assert.equal(grid.tracking, undefined);
        const lost = { name: 'df', state: 'lost', reason: 'removed', message: 'gone' };
        assert.deepEqual(parseDescriptor({ ...grid, tracking: lost }).tracking, lost);
        assert.deepEqual(
            parseDescriptor({ ...grid, tracking: { name: 'df', state: 'active', extra: 1 } })
                .tracking,
            { name: 'df', state: 'active' },
        );
        for (const tracking of [
            null,
            'df',
            { name: 'df' },
            { name: 'df', state: 'weird' },
            { state: 'active' },
        ]) {
            assert.equal(
                parseDescriptor({ ...grid, tracking }).tracking,
                undefined,
                JSON.stringify(tracking),
            );
        }
        assert.equal(parseTracking([]), undefined);
    });

    test('converts sort and filter models', () => {
        const params = tableRowsParams(
            grid,
            100,
            600,
            [
                { colId: '2', sort: 'desc' },
                { colId: '1', sort: 'asc' },
            ],
            {
                '1': {
                    filterType: 'number',
                    operator: 'OR',
                    conditions: [
                        { filterType: 'number', type: 'inRange', filter: 1, filterTo: 3 },
                        { filterType: 'number', type: 'jdvIsNa' },
                    ],
                },
                '2': { filterType: 'text', type: 'notContains', filter: 'X' },
            },
        );
        assert.equal(params.offset, 100);
        assert.equal(params.limit, 500);
        assert.deepEqual(params.sort, [
            { col: 1, desc: true },
            { col: 0, desc: false },
        ]);
        assert.deepEqual(params.filter, {
            op: 'and',
            args: [
                {
                    op: 'or',
                    args: [
                        { op: 'between', col: 0, lower: 1, upper: 3 },
                        { op: 'is_na', col: 0 },
                    ],
                },
                {
                    op: 'and',
                    args: [
                        { op: 'not', arg: { op: 'contains', col: 1, value: 'X' } },
                        { op: 'not', arg: { op: 'is_na', col: 1 } },
                    ],
                },
            ],
        });
    });

    test('converts empty-string filters for text columns only', () => {
        const textGrid = parseDescriptor({
            ...grid,
            columns: [
                ...grid.columns!.slice(0, 2),
                {
                    position: 2,
                    name: 's',
                    type: 'string',
                    native_type: ['character'],
                    sortable: true,
                    filterable: true,
                },
            ],
        });
        const filter = (field: string, type: string) =>
            toJdvFilter({ [field]: { filterType: 'text', type } }, textGrid);
        const isNa = (col: number) => ({ op: 'is_na', col });
        const empty = (col: number) => ({ op: 'text_equals', col, value: '' });
        // Categorical and string columns; NA stays a separate condition.
        for (const col of [1, 2]) {
            const field = String(col + 1);
            assert.ok(gridColumnDefs(textGrid)[col + 1].jdv?.filterOptions.includes('jdvIsEmpty'));
            assert.deepEqual(filter(field, 'jdvIsEmpty'), empty(col));
            assert.deepEqual(filter(field, 'jdvNotEmpty'), {
                op: 'and',
                args: [
                    { op: 'not', arg: empty(col) },
                    { op: 'not', arg: isNa(col) },
                ],
            });
            assert.deepEqual(filter(field, 'jdvIsNa'), isNa(col));
            // blank and notBlank are no longer mapped to is_na.
            for (const type of ['blank', 'notBlank']) {
                assert.throws(
                    () => filter(field, type),
                    (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
                );
            }
        }
        // Is NA OR Is empty in one AG Grid model.
        assert.deepEqual(
            toJdvFilter(
                {
                    '3': {
                        filterType: 'text',
                        operator: 'OR',
                        conditions: [
                            { filterType: 'text', type: 'jdvIsNa' },
                            { filterType: 'text', type: 'jdvIsEmpty' },
                        ],
                    },
                },
                textGrid,
            ),
            { op: 'or', args: [isNa(2), empty(2)] },
        );
        // A number column has no empty-string filters.
        assert.ok(!gridColumnDefs(textGrid)[1].jdv?.filterOptions.includes('jdvIsEmpty'));
        assert.throws(
            () => filter('1', 'jdvIsEmpty'),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
        );
    });

    test('selects displayed columns by field, excluding the row label', () => {
        const select = (fields: unknown) => tableRowsParams(grid, 0, 10, [], {}, fields);
        assert.deepEqual(select(['0', '3', '1', '3']).cols, [2, 0]);
        assert.deepEqual(select(['0']).cols, []);
        assert.deepEqual(select([]).cols, []);
        for (const fields of [
            undefined,
            null,
            '1',
            ['bad'],
            [1],
            ['01'],
            ['-1'],
            ['7'],
            ['1.5'],
            ['999999999999999999999'],
            ['1', '2', '3', '4', '5', '6'],
            ['0', '1', '2', '3', '4', '5', '6'],
        ]) {
            assert.equal('cols' in select(fields), false, JSON.stringify(fields));
        }
        const wide = {
            ...grid,
            columns: Array.from({ length: 300 }, (_, position) => ({
                ...grid.columns![0],
                position,
            })),
        };
        const fields = Array.from({ length: 257 }, (_, index) => String(index + 1));
        assert.equal('cols' in tableRowsParams(wide, 0, 10, [], {}, fields), false);
        assert.equal(
            tableRowsParams(wide, 0, 10, [], {}, ['0', ...fields.slice(0, 256)]).cols?.length,
            256,
        );
    });

    test('converts boolean filter models', () => {
        const booleanGrid = parseDescriptor({
            ...grid,
            ncol: 1,
            columns: [
                {
                    position: 0,
                    name: 'flag',
                    type: 'boolean',
                    native_type: ['logical'],
                    sortable: true,
                    filterable: true,
                },
            ],
        });
        assert.deepEqual(toJdvFilter({ '1': { filterType: 'text', type: 'true' } }, booleanGrid), {
            op: 'is_true',
            col: 0,
        });
        assert.deepEqual(toJdvFilter({ '1': { filterType: 'text', type: 'false' } }, booleanGrid), {
            op: 'is_false',
            col: 0,
        });
    });

    test('converts date, datetime and integer64 operands', () => {
        assert.deepEqual(
            toJdvFilter(
                {
                    '3': {
                        filterType: 'date',
                        type: 'greaterThan',
                        dateFrom: '2020-01-02 00:00:00',
                    },
                },
                grid,
            ),
            { op: 'gt', col: 2, value: '2020-01-02' },
        );
        assert.deepEqual(
            toJdvFilter(
                { '4': { filterType: 'date', type: 'lessThan', dateFrom: '2020-01-02 10:30:00' } },
                grid,
            ),
            { op: 'lt', col: 3, value: '2020-01-02T10:30:00' },
        );
        for (const [input, expected] of [
            ['2020-01-02T10:30:00.125Z', '2020-01-02T10:30:00.125Z'],
            ['2020-01-02 10:30:00.125+09:00', '2020-01-02T10:30:00.125+09:00'],
            ['2020-01-02T10:30:00-05:30', '2020-01-02T10:30:00-05:30'],
            ['2020-01-02', '2020-01-02T00:00:00'],
        ]) {
            assert.deepEqual(
                toJdvFilter({ '4': { filterType: 'date', type: 'equals', dateFrom: input } }, grid),
                { op: 'eq', col: 3, value: expected },
            );
        }
        for (const input of [
            '2020-01-02T10:30:00garbage',
            '2020-01-02T10:30:00.1Ztail',
            '2020-01-02 10:30',
        ]) {
            assert.throws(
                () =>
                    toJdvFilter(
                        { '4': { filterType: 'date', type: 'equals', dateFrom: input } },
                        grid,
                    ),
                (e: unknown) => e instanceof JdvRequestError && e.code === 'invalid_request',
                input,
            );
        }
        for (const input of ['2020-01-02T10:30:00\n', '2020-01-02T10:30:00\r\n']) {
            assert.throws(
                () =>
                    toJdvFilter(
                        { '4': { filterType: 'date', type: 'equals', dateFrom: input } },
                        grid,
                    ),
                (e: unknown) => e instanceof JdvRequestError && e.code === 'invalid_request',
                JSON.stringify(input),
            );
        }
        assert.deepEqual(
            toJdvFilter(
                { '3': { filterType: 'date', type: 'equals', dateFrom: '2020-01-02' } },
                grid,
            ),
            { op: 'eq', col: 2, value: '2020-01-02' },
        );
        assert.deepEqual(
            toJdvFilter(
                { '3': { filterType: 'date', type: 'equals', dateFrom: '2020-01-02 00:00:00' } },
                grid,
            ),
            { op: 'eq', col: 2, value: '2020-01-02' },
        );
        for (const input of ['2020-01-02 10:30:00', '2020-01-02T00:00:00Z', '2020-01-02garbage']) {
            assert.throws(
                () =>
                    toJdvFilter(
                        { '3': { filterType: 'date', type: 'equals', dateFrom: input } },
                        grid,
                    ),
                (e: unknown) => e instanceof JdvRequestError && e.code === 'invalid_request',
                input,
            );
        }
        for (const input of ['2020-01-02\n', '2020-01-02\r\n']) {
            assert.throws(
                () =>
                    toJdvFilter(
                        { '3': { filterType: 'date', type: 'equals', dateFrom: input } },
                        grid,
                    ),
                (e: unknown) => e instanceof JdvRequestError && e.code === 'invalid_request',
                JSON.stringify(input),
            );
        }
        assert.deepEqual(
            toJdvFilter(
                {
                    '4': {
                        filterType: 'date',
                        type: 'inRange',
                        dateFrom: '2020-01-02 10:30:00.125+09:00',
                        dateTo: '2020-01-03T11:45:00.875-05:30',
                    },
                },
                grid,
            ),
            {
                op: 'between',
                col: 3,
                lower: '2020-01-02T10:30:00.125+09:00',
                upper: '2020-01-03T11:45:00.875-05:30',
            },
        );
        assert.deepEqual(
            toJdvFilter({ '5': { filterType: 'bigint', type: 'equals', filter: '+0012' } }, grid),
            { op: 'eq', col: 4, value: '12' },
        );
        assert.throws(
            () =>
                toJdvFilter({ '5': { filterType: 'bigint', type: 'lessThan', filter: '1' } }, grid),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
        );
        assert.throws(
            () => toJdvFilter({ '6': { filterType: 'text', type: 'contains', filter: '1' } }, grid),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
        );
        assert.throws(
            () => tableRowsParams(grid, 0, 10, [{ colId: '6', sort: 'asc' }], undefined),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unsupported',
        );
    });

    test('converts pages to rows using display text and the NA rows', () => {
        const page = gridPageFromRows(
            {
                view: 'v-1',
                generation: 2,
                total: 3,
                total_unfiltered: 5,
                offset: 0,
                limit: 3,
                data: {
                    source_row: [2, 0, 1],
                    row_labels: ['r3', 'r1', 'r2'],
                    columns: [
                        {
                            schema: grid.columns![0],
                            data: {
                                values: [null, 1, null],
                                display: ['Inf', 'NaN', 'NA'],
                                special: { pos_inf: [0], nan: [1] },
                                na_rows: [1, 2],
                            },
                            errors: [],
                        },
                        {
                            schema: grid.columns![1],
                            data: { values: [null, 'x', 'y'], na_rows: [0] },
                            errors: [],
                        },
                    ],
                },
            },
            0,
            3,
        );
        assert.deepEqual(page.rows, [
            { '0': 'r3', __sourceRow: 2, '1': 'Inf', '2': null },
            { '0': 'r1', __sourceRow: 0, '1': 'NaN', '2': 'x' },
            { '0': 'r2', __sourceRow: 1, '1': null, '2': 'y' },
        ]);
        assert.equal(page.totalRows, 3);
        assert.equal(page.totalUnfiltered, 5);
        const unnamed = gridPageFromRows(
            {
                total: 1,
                total_unfiltered: 1,
                offset: 0,
                limit: 1,
                data: { source_row: [6], row_labels: null, columns: [] },
            },
            0,
            1,
        );
        assert.deepEqual(unnamed.rows, [{ '0': '7', __sourceRow: 6 }]);
    });

    test('opens drillable cells by original source row', () => {
        // Column 5 is the only drillable column; the grid reports children.
        const drillable = parseDescriptor({
            ...grid,
            capabilities: { ...capabilities, children: true },
        });
        assert.equal(
            gridColumnDefs(drillable).filter((column) => column.jdvDrill !== undefined).length,
            1,
        );
        assert.equal(gridColumnDefs(drillable)[6].jdvDrill, 5);
        assert.equal(gridColumnDefs(grid)[6].jdvDrill, undefined);
        assert.deepEqual(cellOpenParams(drillable, 204, 5), {
            view: 'v-1',
            generation: 2,
            path: [{ kind: 'cell', source_row: 204, column: 5 }],
            mode: 'paged',
        });
        const rejected = (code: string) => (e: unknown) =>
            e instanceof JdvRequestError && e.code === code;
        assert.throws(() => cellOpenParams(grid, 0, 5), rejected('unsupported'));
        assert.throws(() => cellOpenParams(drillable, 0, 0), rejected('invalid_request'));
        assert.throws(() => cellOpenParams(drillable, -1, 5), rejected('invalid_request'));
        assert.throws(() => cellOpenParams(drillable, 1.5, 5), rejected('invalid_request'));
        assert.throws(() => cellOpenParams(drillable, 0, 9), rejected('invalid_request'));
    });

    test('maps List Viewer paths to typed tree paths', () => {
        const tree = new TreeAdapter(
            parseDescriptor({
                view: 'v-2',
                generation: 1,
                kind: 'tree',
                access: 'random',
                encoding: 'jdv-json',
                capabilities: { ...capabilities, sort: false, filter: false, children: true },
                path: [],
                class: ['list'],
                type: 'list',
            }),
            'x',
        );
        assert.deepEqual(tree.childrenParams([], 1), {
            view: 'v-2',
            generation: 1,
            path: [],
            offset: 0,
            limit: 200,
            attributes: false,
        });
        const page = tree.children([], {
            path: [],
            offset: 0,
            total_children: 4,
            children: [
                {
                    index: 1,
                    label: 'a',
                    class: ['integer'],
                    type: 'integer',
                    summary: 'integer (3): 1, 2, 3',
                    has_children: true,
                    viewable: true,
                    path: [{ type: 'index', index: 1 }],
                },
                {
                    index: 2,
                    label: 'b',
                    class: ['list'],
                    type: 'list',
                    summary: 'list (1)',
                    has_children: true,
                    viewable: true,
                    path: [{ type: 'index', index: 2 }],
                },
                {
                    index: 3,
                    label: 'df',
                    class: ['data.frame'],
                    type: 'list',
                    summary: 'data.frame',
                    has_children: true,
                    viewable: true,
                    path: [{ type: 'index', index: 3 }],
                },
            ],
        });
        assert.equal(page.next_start, 4);
        assert.deepEqual(page.children[1], {
            label: 'b',
            str: 'list (1)',
            index: 2,
            viewable: true,
            has_children: true,
        });

        const vector = tree.open([], 1);
        assert.equal(vector.kind, 'navigate');
        assert.equal(vector.kind === 'navigate' && vector.navigation.vector, true);
        const elements = tree.children([1], {
            path: [{ type: 'index', index: 1 }],
            offset: 0,
            total_children: 1,
            children: [
                {
                    index: 1,
                    label: '[1]',
                    class: ['integer'],
                    type: 'integer',
                    summary: 'integer (1): 1',
                    has_children: false,
                    viewable: true,
                    path: [
                        { type: 'index', index: 1 },
                        { type: 'index', index: 1 },
                    ],
                },
            ],
        });
        assert.deepEqual(elements.children[0], {
            label: '[1]',
            str: 'integer (1): 1',
            index: 1,
            viewable: false,
            has_children: false,
        });

        const nested = tree.open([], 2);
        assert.deepEqual(nested.kind === 'navigate' && nested.navigation, {
            title: 'x$b',
            path: [2],
            vector: false,
            breadcrumbs: [
                { label: 'x', path: [] },
                { label: 'b', path: [2] },
            ],
        });
        const table = tree.open([], 3);
        assert.deepEqual(table, {
            kind: 'object',
            title: 'x$df',
            params: {
                view: 'v-2',
                generation: 1,
                path: [{ type: 'index', index: 3 }],
                mode: 'paged',
            },
        });
        assert.throws(
            () => tree.open([], 9),
            (e: unknown) => e instanceof JdvRequestError && e.code === 'unavailable',
        );
    });

    test('classifies atomic vectors by type', () => {
        assert.equal(isVectorType('integer', ['factor']), true);
        assert.equal(isVectorType('double', ['numeric']), true);
        assert.equal(isVectorType('integer', ['matrix', 'array']), false);
        assert.equal(isVectorType('list', ['list']), false);
        assert.equal(isVectorType(undefined, []), false);
    });

    test('leaves have nothing to open unless they are tables', () => {
        const tree = new TreeAdapter(
            parseDescriptor({
                view: 'v-2',
                generation: 1,
                kind: 'tree',
                access: 'random',
                encoding: 'jdv-json',
                capabilities: { ...capabilities, children: true },
                path: [],
                class: ['list'],
                type: 'list',
            }),
            'x',
        );
        const page = tree.children([], {
            path: [],
            offset: 0,
            total_children: 2,
            children: [
                {
                    index: 1,
                    label: 'n',
                    native_type: ['numeric'],
                    type: 'double',
                    summary: 'double (1): 1',
                    has_children: false,
                    viewable: true,
                    path: [{ type: 'index', index: 1 }],
                },
                {
                    index: 2,
                    label: 'm',
                    class: ['matrix', 'array'],
                    type: 'integer',
                    summary: 'matrix',
                    has_children: false,
                    viewable: true,
                    path: [{ type: 'index', index: 2 }],
                },
            ],
        });
        assert.deepEqual(
            page.children.map((child) => child.viewable),
            [false, true],
        );
    });
});
