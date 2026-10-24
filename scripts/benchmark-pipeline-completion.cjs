// Run after compiling TypeScript: node scripts/benchmark-pipeline-completion.cjs
// Optional argument: absolute path to a compiled earlier resolver for comparison.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const implementation = require(process.argv[2] || '../out/pipelineCompletion');
const createResolver = () => implementation.PipelineSourceCache
    ? new implementation.PipelineSourceCache()
    : { resolve: implementation.getPipelineSource };

async function measure(run) {
    const samples = [];
    let maxBlock = 0;
    for (let i = 0; i < 9; i++) {
        const start = performance.now();
        let previous = start;
        let heartbeat;
        const beat = () => {
            const now = performance.now();
            maxBlock = Math.max(maxBlock, now - previous);
            previous = now;
            heartbeat = setImmediate(beat);
        };
        heartbeat = setImmediate(beat);
        try {
            await run(i);
            maxBlock = Math.max(maxBlock, performance.now() - previous);
        } finally {
            clearImmediate(heartbeat);
        }
        samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
        median_ms: +samples[4].toFixed(3),
        max_ms: +samples[8].toFixed(3),
        max_block_ms: +maxBlock.toFixed(3),
    };
}

async function main() {
    for (const lines of [1000, 10000, 50000]) {
        // An earlier pipeline prevents the benchmark from relying on a global
        // string search to skip ordinary completion requests.
        const prefix = 'other |> head()\n' + 'value <- mean(1:10)\n'.repeat(lines);
        for (const tail of ['select(', '(raw\n |> select(']) {
            const expected = tail.includes('raw') ? 'raw' : undefined;
            const text = prefix + tail;
            const cold = await measure(async () =>
                assert.equal(await createResolver().resolve(text), expected));
            const cache = createResolver();
            await cache.resolve(text);
            const warm = await measure(async () =>
                assert.equal(await cache.resolve(text), expected));
            const edited = await measure(async (i) =>
                assert.equal(await cache.resolve(text + 'column_' + i), expected));
            console.log(JSON.stringify({
                lines, pipeline: expected !== undefined, cold, warm, edited,
            }));
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
