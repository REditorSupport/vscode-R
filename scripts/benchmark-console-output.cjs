// Run after TypeScript compilation: node scripts/benchmark-console-output.cjs
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { StreamText } = require('../out/interactive/streamText');
const { NotebookOutputState, prepareNotebookStream, updateNotebookOutputs } = require('../out/interactive/notebookOutput');

async function measure(incremental, writes) {
    const stream = new StreamText('');
    const state = new NotebookOutputState();
    const outputs = [];
    let delivered = 0;
    const normalize = value => 'mime' in value ? [value] : [...value];
    const execution = {
        replaceOutput: value => { outputs.splice(0, outputs.length, ...value); return Promise.resolve(); },
        appendOutput: value => { delivered += value.flatMap(output => output.items).reduce((sum, item) => sum + item.data.length, 0); outputs.push(...value); return Promise.resolve(); },
        replaceOutputItems: (value, output) => { const items = normalize(value); delivered += items.reduce((sum, item) => sum + item.data.length, 0); output.items = items; return Promise.resolve(); },
        appendOutputItems: (value, output) => { const items = normalize(value); delivered += items.reduce((sum, item) => sum + item.data.length, 0); output.items = [{ mime: items[0].mime, data: Buffer.concat([...output.items, ...items].map(item => item.data)) }]; return Promise.resolve(); },
    };
    const started = performance.now();
    for (let write = 0; write < writes; write++) {
        stream.append('x'.repeat(32768));
        const output = { metadata: { rStreamId: 'console' }, items: [{ mime: 'application/vnd.code.notebook.stdout', data: incremental ? Buffer.alloc(0) : Buffer.from(stream.snapshot().text()) }] };
        if (incremental) prepareNotebookStream(output, stream.snapshot());
        await updateNotebookOutputs(execution, [...outputs], [output], state);
    }
    assert.equal(outputs[0].items[0].data.length, writes * 32768);
    return { incremental, writes, finalMiB: writes / 32, deliveredMiB: delivered / 1024 / 1024, elapsedMs: +(performance.now() - started).toFixed(3) };
}

async function main() {
    for (const writes of [32, 128, 512]) {
        const before = await measure(false, writes);
        const after = await measure(true, writes);
        assert.equal(after.deliveredMiB, after.finalMiB);
        console.log(JSON.stringify({ before, after }));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
