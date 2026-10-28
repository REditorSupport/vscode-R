// Run after compiling TypeScript: node scripts/benchmark-journal.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { SessionJournal, readPreviousJournalAsync } = require(process.argv[2] || '../out/interactive/journal');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-journal-benchmark-'));
    try {
        for (const outputMiB of [16, 112]) {
            const directory = path.join(root, String(outputMiB), 'generation');
            const journal = new SessionJournal(directory, 'generation');
            for (let order = 0; order < outputMiB / 4; order++) {
                const record = journal.accept({ id: 'old' + order, code: 'print(large_result)' }).record;
                journal.append('accepted', { record }, record.id);
                for (let chunk = 0; chunk < 128; chunk++) journal.append('stream', { text: 'x'.repeat(32768), channel: 'stdout' }, record.id);
                const final = { ...record, state: 'success', ended: Date.now() };
                journal.update(final); journal.append('finished', { record: final }, record.id);
            }
            const latest = journal.accept({ id: 'latest', code: '1 + 1' }).record;
            journal.append('accepted', { record: latest }, latest.id);
            journal.append('stream', { text: '[1] 2\n', channel: 'stdout' }, latest.id);
            journal.append('finished', { record: { ...latest, state: 'success' } }, latest.id);
            const samples = [];
            for (let run = 0; run < 7; run++) {
                const start = performance.now(), recent = journal.recent(1);
                assert.equal(recent.events.length, 3);
                samples.push(performance.now() - start);
            }
            journal.close();
            const archiveSamples = [];
            for (let run = 0; run < 7; run++) {
                const start = performance.now(), recent = await readPreviousJournalAsync(path.dirname(directory), 'generation', 1);
                assert.equal(recent.events.length, 3);
                archiveSamples.push(performance.now() - start);
            }
            samples.sort((a, b) => a - b); archiveSamples.sort((a, b) => a - b);
            console.log(JSON.stringify({ outputMiB, recentMedianMs: +samples[3].toFixed(3), archivedMedianMs: +archiveSamples[3].toFixed(3) }));
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
