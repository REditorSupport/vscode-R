// Run after npm run compile && npx tsc. See README.md for each suite's packages.
// Output stays in a disposable directory; no downloads or package installations.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { SessionAgent, rString } = require('../../../out/interactive/agent');
const { AgentClient } = require('../../../out/interactive/client');
const { installRuntime } = require('../../../out/interactive/launcher');
const { AssetStore, readAsset } = require('../../../out/interactive/assets');
const exampleSuite = process.env.VSCR_EXAMPLE_SUITE || 'public';
if (!['public', 'public-more', 'research'].includes(exampleSuite)) throw new Error('VSCR_EXAMPLE_SUITE must be public, public-more or research');
const examples = require('./' + exampleSuite + '.json');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.env.VSCR_EXAMPLE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), `r-${exampleSuite}-examples-`));
const provider = process.env.VSCR_TEST_PROVIDER === 'arf' ? 'arf' : 'r';
const backend = process.env.VSCR_TEST_STATIC ? 'standard' : 'jgd';

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-example-session-'));
    const results = [];
    let agent, client;
    try {
        const runtime = await installRuntime(process.cwd(), path.join(root, 'registry'), 'R', () => {});
        const id = randomUUID();
        const storage = path.join(root, id);
        agent = new SessionAgent({ id, generation: randomUUID(), label: `${exampleSuite} example test`, directory: root,
            storage, rPath: 'R', library: runtime.library, resources: runtime.resources, provider,
            arfPath: process.env.ARF_PATH || 'arf', supervision: 'test', plotBackend: backend,
            historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
        client = new AgentClient(await agent.start()); await client.connect();
        const events = []; client.on('event', event => events.push(event)); await client.subscribe(0);
        const until = async predicate => {
            const deadline = Date.now() + 30000;
            while (!predicate()) {
                if (Date.now() > deadline) throw new Error(JSON.stringify(events.slice(-8)));
                await delay(25);
            }
        };
        await until(() => events.some(event => event.type === 'state' && event.data.status === 'idle'));
        for (const example of examples) {
            const folder = path.join(output, example.id); fs.mkdirSync(folder, { recursive: true });
            const code = 'set.seed(42)\noptions(digits=7, scipen=0, OutDec=".")\n' + (example.kinds.includes('plot') ? 'par(mfrow=c(1,1), mar=c(5.1,4.1,4.1,2.1))\n' : '') + example.code;
            fs.writeFileSync(path.join(folder, 'code.R'), code);
            const execution = randomUUID(), started = Date.now();
            await client.request('submit', { submission: { id: execution, code } });
            await until(() => events.some(event => event.type === 'finished' && event.executionId === execution));
            await delay(350);
            const record = await client.request('execution', { id: execution });
            const captured = events.filter(event => event.executionId === execution);
            const displays = captured.filter(event => event.type === 'display').map(event => event.data);
            const kinds = [...new Set(displays.map(data => data.kind))];
            const result = { id: example.id, source: example.source, provider, backend, state: record.state,
                ms: Date.now() - started, kinds, warnings: captured.filter(event => event.type === 'condition').map(event => event.data.message) };
            results.push(result);
            fs.writeFileSync(path.join(folder, 'events.json'), JSON.stringify(captured, null, 2));
            fs.writeFileSync(path.join(folder, 'outputs.json'), JSON.stringify(displays, null, 2));
            const pages = [...new Map(displays.filter(data => data.kind === 'plot' || data.kind === 'image')
                .map(data => [data.displayId || data.asset, data])).values()];
            for (const [index, page] of pages.entries()) {
                const name = page.svg || page.asset;
                fs.writeFileSync(path.join(folder, `interactive-${String(index + 1).padStart(2, '0')}.${name.includes('.png') ? 'png' : 'svg'}`),
                    readAsset(path.join(storage, 'assets'), name));
            }
            const plot = pages.at(-1);
            if (plot) {
                const name = plot.svg || plot.asset;
                const bytes = readAsset(path.join(storage, 'assets'), name);
                const extension = name.includes('.png') ? 'png' : 'svg';
                fs.writeFileSync(path.join(folder, 'interactive.' + extension), bytes);
                // Independent R renders the same expressions and RNG seed to PNG.
                const reference = `png(${rString(path.join(folder, 'reference-%02d.png'))}, width=800, height=600, res=96)
local({
  for (expression in parse(${rString(path.join(folder, 'code.R'))})) {
    result <- withVisible(eval(expression, .GlobalEnv))
    if (result$visible) print(result$value)
  }
})
dev.off()`;
                await run('R', ['--vanilla', '--slave', '-e', reference], { cwd: root, timeout: 30000 });
            }
            const html = displays.filter(data => data.kind === 'html').at(-1);
            if (html) {
                const assets = new AssetStore(path.join(storage, 'assets'));
                assets.exportTo(path.join(folder, 'widget'), [html.asset]);
                result.widget = path.join(example.id, 'widget', html.asset);
            }
            assert.strictEqual(record.state, 'success', JSON.stringify(result));
            assert.ok(!result.warnings.some(message => /jgd:.*unclosed group/.test(message)), JSON.stringify(result));
            // Static graphics uses the image MIME instead of the retained JGD plot type.
            const expected = example.kinds.map(kind => backend === 'standard' && kind === 'plot' ? 'image' : kind);
            assert.deepStrictEqual([...kinds].sort(), expected.sort(), JSON.stringify(result));
            const consoleText = captured.filter(event => event.type === 'stream').map(event => event.data.text).join('');
            for (const text of example.textIncludes || []) {
                assert.ok(consoleText.includes(text), `${example.id}: missing printed result ${text}`);
            }
            if (example.plotPages) {
                assert.strictEqual(pages.length, example.plotPages, `${example.id}: wrong number of plot pages`);
            }
            if (example.table) {
                const table = displays.find(data => data.kind === 'table');
                const columns = table.columns.filter(column => column.headerName.trim());
                assert.strictEqual(table.totalRows, example.table.rows.length);
                assert.deepStrictEqual(columns.map(column => column.headerName), example.table.headers);
                assert.deepStrictEqual(table.rows.map(row => columns.map(column => row[column.field])), example.table.rows);
                if (example.table.formatted) {
                    assert.deepStrictEqual(table.rows.map((_, index) => columns.map(column => table.formattedColumns[column.field][index])), example.table.formatted);
                }
            }
            console.log(JSON.stringify(result));
        }
    } finally {
        client?.close(); agent?.close(); await delay(200);
        fs.rmSync(root, { recursive: true, force: true });
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        console.log('Results: ' + output);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
