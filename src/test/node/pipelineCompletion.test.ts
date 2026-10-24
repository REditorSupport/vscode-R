import * as assert from 'assert';
import { getPipelineSource } from '../../pipelineCompletion';

suite('Session pipeline source', () => {
    const source = (code: string) => getPipelineSource(code.split('<cursor>')[0]);

    for (const pipe of ['%>%', '|>', '%<>%', '%T>%', '%$%']) {
        for (const code of [
            `raw ${pipe} select(<cursor>)`,
            `(raw ${pipe} select(<cursor>))`,
            `(\n  raw ${pipe} select(<cursor>)\n)`,
            `(\n  (\n    raw ${pipe} select(<cursor>)\n  )\n)`,
            `(\n  raw\n  ${pipe} select(<cursor>)\n)`,
            `((raw)) ${pipe}\n select(<cursor>)`,
            `(raw ${pipe} head()) ${pipe} select(<cursor>)`,
            `result <- (\n raw ${pipe} select(<cursor>)\n)`,
            `(\n raw ${pipe} select(<cursor>)\n) -> result`,
            `print(\n raw ${pipe} select(<cursor>)\n)`,
            `raw ${pipe} select(a, <cursor>)`,
            `raw ${pipe} mutate(x = sum(<cursor>))`,
        ]) {
            test(`finds the source in ${JSON.stringify(code)}`, () => {
                assert.strictEqual(source(code), 'raw');
            });
        }
    }

    const nested = [
        'raw %>% mutate(x = other %>% select(<cursor>))',
        'list(raw %>% select(a), other %>% select(<cursor>))',
        'raw %>% mutate(x = (other |> select(<cursor>)))',
        'raw %>% mutate(x = other %>% select(a), y = other2 |> select(<cursor>))',
    ];
    for (const code of nested) {
        test(`selects the nearest pipeline in ${JSON.stringify(code)}`, () => {
            assert.strictEqual(source(code), code.includes('other2') ? 'other2' : 'other');
        });
    }

    for (const code of [
        'raw %>% mutate(x = other %>% select(a), y = sum(<cursor>))',
        'raw %>% mutate(x = other %>% select(a), <cursor>)',
        'raw %>% mutate(x = list(other %>% select(a), sum(<cursor>)))',
        'raw %>% mutate(x = { other %>% select(a); sum(<cursor>) })',
        'raw %>% { . %>% select(<cursor>) }',
        'raw %<>% mutate(x = . %>% select(<cursor>))',
        'raw %T>% { . %>% select(<cursor>) }',
    ]) {
        test(`returns to the surrounding pipeline in ${JSON.stringify(code)}`, () => {
            assert.strictEqual(source(code), 'raw');
        });
    }

    test('binds nested dot placeholders to their nearest magrittr input', () => {
        assert.strictEqual(
            source('raw %>% mutate(x = other %>% { . %>% select(<cursor>) })'),
            'other',
        );
        assert.strictEqual(
            source('raw %>% mutate(x = identity(other) %>% { . %>% select(<cursor>) })'),
            undefined,
        );
    });

    for (const code of [
        '( # grouping\n # another comment\n raw %>% # pipe\n select(<cursor>))',
        'raw %>% mutate(note = "other %>% select(", <cursor>)',
        'raw %>% mutate(note = "escaped \\\" other %>% select(", <cursor>)',
        "raw %>% mutate(note = 'other %>% select(', <cursor>)",
        'raw %>% mutate(note = r"(other %>% select(")", <cursor>)',
        'raw %>% mutate(note = R"--[other %>% select("]--", <cursor>)',
    ]) {
        test(`ignores comments and string contents in ${JSON.stringify(code)}`, () => {
            assert.strictEqual(source(code), 'raw');
        });
    }

    for (const [name, spelling] of [
        ['raw data', '`raw data`'],
        ['数据', '数据'],
        ['a`b', '`a\\`b`'],
        ['a\\b', '`a\\\\b`'],
        ['a\nb', '`a\\nb`'],
        ['ab', '`a\\x62`'],
        ['ab', '`a\\u0062`'],
        ['ab', '`a\\U00000062`'],
        ['ab', '`a\\u{62}`'],
        ['ab', '`a\\U{62}`'],
        ['ab', '`a\\142`'],
    ]) {
        test(`recognizes session symbol ${JSON.stringify(name)}`, () => {
            assert.strictEqual(source(`${spelling} %>% select(<cursor>)`), name);
        });
    }

    for (const code of [
        'raw %>% select(a); select(<cursor>)',
        'raw %>% select(a)\nselect(<cursor>)',
        'list(raw %>% select(a), select(<cursor>))',
        'raw %>% select(a) + select(<cursor>)',
        'raw %>% select(a) %in% select(<cursor>)',
        'identity(raw) %>% select(<cursor>)',
        'raw$other %>% select(<cursor>)',
        'raw[[1]] %>% select(<cursor>)',
        '(raw + other) %>% select(<cursor>)',
        'pkg::raw %>% select(<cursor>)',
        'raw %>% mutate(x = identity(other) %>% select(<cursor>))',
        'raw %>% mutate(x = (other + other2) %>% select(<cursor>))',
        'raw %>% mutate(note = "other %>% select(<cursor>)")',
        'raw %>% mutate(note = r"(other %>% select(<cursor>))")',
        'raw %>% mutate( # other %>% select(<cursor>)\n)',
        'raw %in% select(<cursor>)',
        'raw %*% select(<cursor>)',
        'select(<cursor>); raw %>% select(a)',
        '`a\\q` %>% select(<cursor>)',
        '`a\\UFFFFFFFF` %>% select(<cursor>)',
    ]) {
        test(`does not borrow unrelated session names in ${JSON.stringify(code)}`, () => {
            assert.strictEqual(source(code), undefined);
        });
    }

    test('bounds recovery of deeply nested incomplete input', () => {
        assert.strictEqual(getPipelineSource('('.repeat(1000) + 'raw %>% select('), undefined);
    });

    test('ignores earlier statements and completed function bodies', () => {
        assert.strictEqual(
            source('f <- function(x) { other %>% select(a) }\n(raw\n |> select(<cursor>))'),
            'raw',
        );
        assert.strictEqual(source('other %>% select(a)\nselect(<cursor>)'), undefined);
    });
});
