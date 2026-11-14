const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createGhApi, createGitChangedFiles, decidePublication, isRelevantPath, pagesToItems, completePagesToItems, didAttemptPublication, completedBothRegistries } = require('./marketplace-pre-release-history');

const marketplace = 'Publish to Visual Studio Marketplace';
const openVsx = 'Publish to Open VSX Registry';

function run(id, date, sha, event = 'schedule') {
    return { id, created_at: `${date}T03:23:00Z`, head_sha: sha, head_branch: 'main', event };
}

function publishJob({ attempt = 1, marketplaceConclusion, openVsxConclusion, marketplaceStatus, openVsxStatus } = {}) {
    const attempted = (conclusion, status) => ({
        status: status || 'completed',
        conclusion: conclusion === undefined ? 'success' : conclusion,
    });
    return {
        name: 'publish',
        run_attempt: attempt,
        steps: [
            { name: marketplace, ...attempted(marketplaceConclusion, marketplaceStatus) },
            { name: openVsx, ...attempted(openVsxConclusion, openVsxStatus) },
        ],
    };
}

function harness(current, runs, jobsByRun) {
    let historyQueries = 0;
    const jobsQueried = [];
    return {
        get historyQueries() { return historyQueries; },
        jobsQueried,
        api: {
            async getRun(_repository, id) {
                assert.equal(String(id), String(current.id));
                return current;
            },
            async listRuns() {
                historyQueries += 1;
                return runs;
            },
            async listJobs(_repository, id) {
                jobsQueried.push(String(id));
                return jobsByRun.get(String(id)) || [];
            },
        },
    };
}

async function evaluate(current, runs, jobsByRun, listChangedFiles) {
    const state = harness(current, runs, jobsByRun);
    const { api, jobsQueried } = state;
    const result = await decidePublication({ api, repository: 'owner/repo', runId: current.id, sha: current.head_sha, listChangedFiles });
    assert.equal(state.historyQueries, 1);
    return { result, jobsQueried, historyQueries: state.historyQueries };
}

async function decide(current, runs, jobsByRun, listChangedFiles) {
    return (await evaluate(current, runs, jobsByRun, listChangedFiles)).result;
}

test('manual publication consumes the date for a scheduled run, then allows the next date', async () => {
    const manual = run(10, '2026-10-05', 'sha-a', 'workflow_dispatch');
    const sameDay = run(11, '2026-10-05', 'sha-b');
    const nextDay = run(12, '2026-10-06', 'sha-b');
    const jobs = new Map([
        ['10', [publishJob()]],
        ['11', []],
        ['12', []],
    ]);
    assert.deepEqual(await decide(sameDay, [manual, sameDay], jobs), {
        publish: false, date: '2026-10-05', reason: 'date-reserved',
    });
    assert.deepEqual(await decide(nextDay, [manual, sameDay, nextDay], jobs), {
        publish: true, date: '2026-10-06', reason: 'new-sha',
    });
});

test('preparation-only runs do not reserve dates or replace the last published SHA', async () => {
    const actual = run(20, '2026-10-03', 'sha-a');
    const noop = run(21, '2026-10-04', 'sha-b');
    const current = run(22, '2026-10-05', 'sha-a');
    const jobs = new Map([
        ['20', [publishJob()]],
        ['21', [{ name: 'prepare', conclusion: 'success', steps: [] }]],
        ['22', []],
    ]);
    assert.deepEqual(await decide(current, [actual, noop, current], jobs), {
        publish: false, date: '2026-10-05', reason: 'unchanged',
    });
    const laterSameSha = run(23, '2026-10-06', 'sha-a');
    jobs.set('23', []);
    assert.deepEqual(await decide(laterSameSha, [actual, noop, current, laterSameSha], jobs), {
        publish: false, date: '2026-10-06', reason: 'unchanged',
    });
});

test('partial publication reserves the day for other runs but the original run may retry', async () => {
    const original = run(30, '2026-10-05', 'sha-a', 'workflow_dispatch');
    const other = run(31, '2026-10-05', 'sha-b');
    const partial = publishJob({ openVsxConclusion: 'failure' });
    const jobs = new Map([['30', [partial]], ['31', []]]);
    assert.deepEqual(await decide(other, [original, other], jobs), {
        publish: false, date: '2026-10-05', reason: 'date-reserved',
    });
    assert.deepEqual(await decide(original, [original], jobs), {
        publish: true, date: '2026-10-05', reason: 'no-prior-publication',
    });
});

test('an old run retry is blocked by a publication attempt on a newer date', async () => {
    const old = run(40, '2026-10-03', 'sha-a');
    const newer = run(41, '2026-10-05', 'sha-b');
    assert.deepEqual(await decide(old, [old, newer], new Map([['41', [publishJob()]]])), {
        publish: false, date: '2026-10-03', reason: 'date-reserved',
    });
});

test('queued jobs and skipped registry steps do not reserve a date', async () => {
    const skippedRun = run(50, '2026-10-05', 'sha-old', 'workflow_dispatch');
    const current = run(51, '2026-10-05', 'sha-new');
    const queued = { name: 'publish', status: 'queued', steps: [] };
    const skipped = publishJob({ marketplaceConclusion: 'skipped', openVsxConclusion: 'skipped' });
    assert.deepEqual(await decide(current, [skippedRun, current], new Map([['50', [queued, skipped]]])), {
        publish: true, date: '2026-10-05', reason: 'no-prior-publication',
    });
});

test('an in-progress registry step reserves the date', async () => {
    const prior = run(55, '2026-10-05', 'sha-old', 'workflow_dispatch');
    const current = run(56, '2026-10-05', 'sha-new');
    const inProgress = publishJob({
        marketplaceStatus: 'in_progress',
        marketplaceConclusion: null,
        openVsxStatus: 'queued',
        openVsxConclusion: null,
    });
    assert.deepEqual(await decide(current, [prior, current], new Map([['55', [inProgress]]])), {
        publish: false, date: '2026-10-05', reason: 'date-reserved',
    });
});

test('all attempts from all paginated job pages are considered', async () => {
    const prior = run(60, '2026-10-05', 'sha-old', 'workflow_dispatch');
    const current = run(61, '2026-10-05', 'sha-new');
    assert.deepEqual(pagesToItems([{ jobs: [{ name: 'verify' }] }, { jobs: [{ name: 'publish' }] }], 'jobs'), [
        { name: 'verify' }, { name: 'publish' },
    ]);
    const attemptOnePartial = publishJob({ attempt: 1, openVsxConclusion: 'cancelled' });
    const attemptTwoQueued = { ...publishJob({ attempt: 2 }), status: 'queued', steps: [] };
    assert.deepEqual(await decide(current, [prior, current], new Map([['60', [attemptOnePartial, attemptTwoQueued]]])), {
        publish: false, date: '2026-10-05', reason: 'date-reserved',
    });
});

test('hundreds of unchanged no-op runs require only one publication-history job lookup', async () => {
    const published = run(100, '2026-01-01', 'sha-a');
    const noops = Array.from({ length: 250 }, (_, index) => {
        const date = new Date(Date.parse('2026-01-02T03:23:00Z') + index * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        return run(101 + index, date, 'sha-a', index % 2 === 0 ? 'schedule' : 'workflow_dispatch');
    });
    const current = run(500, '2026-10-06', 'sha-a');
    const jobs = new Map([['100', [publishJob()]]]);
    const { result, jobsQueried } = await evaluate(current, [published, ...noops, current], jobs);
    assert.deepEqual(result, { publish: false, date: '2026-10-06', reason: 'unchanged' });
    assert.deepEqual(jobsQueried, ['100']);
});

test('same-day publication attempts still reserve a date among many same-SHA no-ops', async () => {
    const current = run(600, '2026-10-06', 'sha-a');
    const noops = Array.from({ length: 12 }, (_, index) =>
        run(601 + index, '2026-10-06', 'sha-a', index % 2 === 0 ? 'schedule' : 'workflow_dispatch'));
    const attempted = noops[7];
    const jobs = new Map([[String(attempted.id), [publishJob({ openVsxConclusion: 'failure' })]]]);
    const { result, jobsQueried } = await evaluate(current, [...noops, current], jobs);
    assert.deepEqual(result, { publish: false, date: '2026-10-06', reason: 'date-reserved' });
    assert.ok(jobsQueried.includes(String(attempted.id)));
    assert.ok(jobsQueried.length < noops.length);
});

test('a newest SHA group without a publication searches an older SHA group', async () => {
    const published = run(700, '2026-10-01', 'sha-a');
    const latestNoop = run(701, '2026-10-04', 'sha-b', 'workflow_dispatch');
    const current = run(702, '2026-10-06', 'sha-b');
    const jobs = new Map([['700', [publishJob()]], ['701', []], ['702', []]]);
    assert.deepEqual(await decide(current, [published, latestNoop, current], jobs), {
        publish: true, date: '2026-10-06', reason: 'new-sha',
    });
});

test('only main schedule and manual runs participate in publication history', async () => {
    const unrelated = { ...run(705, '2026-10-05', 'sha-a'), event: 'push' };
    const otherBranch = { ...run(706, '2026-10-05', 'sha-a'), head_branch: 'feature' };
    const current = run(707, '2026-10-06', 'sha-a');
    const jobs = new Map([['705', [publishJob()]], ['706', [publishJob()]], ['707', []]]);
    assert.deepEqual(await decide(current, [unrelated, otherBranch, current], jobs), {
        publish: true, date: '2026-10-06', reason: 'no-prior-publication',
    });
});

test('non-contiguous repeated SHAs do not substitute an older publication for the latest SHA', async () => {
    const oldA = run(710, '2026-10-01', 'sha-a');
    const publishedB = run(711, '2026-10-03', 'sha-b', 'workflow_dispatch');
    const latestA = run(712, '2026-10-05', 'sha-a');
    const current = run(713, '2026-10-06', 'sha-a');
    const jobs = new Map([
        ['710', [publishJob()]],
        ['711', [publishJob()]],
        ['712', []],
        ['713', []],
    ]);
    assert.deepEqual(await decide(current, [oldA, publishedB, latestA, current], jobs), {
        publish: true, date: '2026-10-06', reason: 'new-sha',
    });
});

test('a later successful run in the same SHA group proves publication after an earlier partial run', async () => {
    const partial = run(720, '2026-10-01', 'sha-a');
    const success = run(721, '2026-10-02', 'sha-a', 'workflow_dispatch');
    const current = run(722, '2026-10-06', 'sha-a');
    const jobs = new Map([
        ['720', [publishJob({ openVsxConclusion: 'failure' })]],
        ['721', [publishJob()]],
        ['722', []],
    ]);
    assert.deepEqual(await decide(current, [partial, success, current], jobs), {
        publish: false, date: '2026-10-06', reason: 'unchanged',
    });
});

test('API errors fail closed', async () => {
    const current = run(70, '2026-10-05', 'sha-a');
    const api = {
        async getRun() { return current; },
        async listRuns() { throw new Error('API unavailable'); },
        async listJobs() { return []; },
    };
    await assert.rejects(decidePublication({ api, repository: 'owner/repo', runId: current.id, sha: current.head_sha }), /API unavailable/);
    assert.throws(() => pagesToItems([], 'workflow_runs'), /no pages/);

    const jobsApi = {
        async getRun() { return current; },
        async listRuns() { return [current]; },
        async listJobs() { throw new Error('Job history unavailable'); },
    };
    await assert.rejects(decidePublication({ api: jobsApi, repository: 'owner/repo', runId: current.id, sha: current.head_sha }), /Job history unavailable/);
});

test('GitHub API adapter pages through more than 1,000 unfiltered runs and paginates compact job history', () => {
    const calls = [];
    const api = createGhApi((_command, args) => {
        calls.push(args);
        if (args.some((arg) => arg.includes('/actions/runs/70/jobs'))) {
            return `${JSON.stringify({ total_count: 0, jobs: [] })}\n`;
        }
        if (args.some((arg) => arg.includes('/actions/workflows/'))) {
            const page = Number(args.find((arg) => arg.startsWith('page='))?.slice('page='.length));
            const start = (page - 1) * 100;
            const count = Math.min(100, 1201 - start);
            const runs = Array.from({ length: count }, (_, index) => ({
                    id: start + index + 1,
                    created_at: '2026-01-01T03:23:00Z',
                    head_sha: `sha-${start + index}`,
                    head_branch: 'main',
                    event: start + index === 1200 ? 'workflow_dispatch' : 'schedule',
                }));
            return `${JSON.stringify({ total_count: 1201, workflow_runs: runs })}\n`;
        }
        return JSON.stringify({ id: 70, head_sha: 'sha-a', head_branch: 'main' });
    });
    assert.deepEqual(api.getRun('owner/repo', 70), { id: 70, head_sha: 'sha-a', head_branch: 'main' });
    const runs = api.listRuns('owner/repo');
    api.listJobs('owner/repo', 70);
    assert.equal(runs.length, 1201);
    assert.equal(calls.length, 15);
    for (const args of calls) {
        assert.ok(args.includes('--method'));
        assert.equal(args[args.indexOf('--method') + 1], 'GET');
    }
    assert.ok(!calls[0].includes('--paginate'));
    assert.ok(!calls[0].includes('--slurp'));
    assert.ok(calls[1].includes('page=1'));
    assert.ok(calls[13].includes('page=13'));
    assert.ok(calls.slice(1).every((args) => args.includes('--jq')));
    assert.ok(calls.slice(1).every((args) => !args.includes('--slurp')));
    assert.ok(calls.slice(1, 14).every((args) => !args.some((arg) => arg.startsWith('event=') || arg.startsWith('branch='))));
    assert.ok(calls[1][calls[1].indexOf('--jq') + 1].includes('workflow_runs:'));
    assert.ok(calls[1][calls[1].indexOf('--jq') + 1].includes('head_sha'));
    assert.ok(calls[1][calls[1].indexOf('--jq') + 1].includes('event'));
    assert.ok(calls[1][calls[1].indexOf('--jq') + 1].endsWith('| tojson'));
    assert.ok(calls[14].includes('--paginate'));
    assert.ok(calls[14][calls[14].indexOf('--jq') + 1].includes('steps:'));
    assert.ok(calls[14][calls[14].indexOf('--jq') + 1].endsWith('| tojson'));
    assert.ok(calls[14].includes('filter=all'));
    assert.throws(() => completePagesToItems([{ total_count: 2, workflow_runs: [{ id: 1 }] }], 'workflow_runs'), /incomplete/);
});

test('getRun accepts one object and rejects malformed current-run responses', () => {
    const validRun = { id: 80, created_at: '2026-10-05T03:23:00Z', head_sha: 'sha-a', head_branch: 'main' };
    const validApi = createGhApi(() => JSON.stringify(validRun));
    assert.deepEqual(validApi.getRun('owner/repo', 80), validRun);

    for (const response of ['null', '[]', '[{}]', '{}', '{"head_sha":"sha-a"}']) {
        const api = createGhApi(() => response);
        assert.throws(() => api.getRun('owner/repo', 80), /invalid current workflow run/);
    }

    const apiFailure = createGhApi(() => {
        throw new Error('GitHub API unavailable');
    });
    assert.throws(() => apiFailure.getRun('owner/repo', 80), /GitHub API unavailable/);
});

test('run pagination fails closed on empty, inconsistent, or duplicate pages', () => {
    const item = (id) => ({ id, created_at: '2026-01-01T03:23:00Z', head_sha: `sha-${id}`, head_branch: 'main', event: 'schedule' });
    function apiFor(responseForPage) {
        return createGhApi((_command, args) => {
            const page = Number(args.find((arg) => arg.startsWith('page='))?.slice('page='.length));
            return `${JSON.stringify(responseForPage(page))}\n`;
        });
    }

    assert.throws(() => apiFor(() => ({ total_count: 1001, workflow_runs: [] })).listRuns('owner/repo'), /incomplete/);

    const firstHundred = Array.from({ length: 100 }, (_, index) => item(index + 1));
    assert.throws(() => apiFor((page) => page === 1
        ? { total_count: 101, workflow_runs: firstHundred }
        : { total_count: 102, workflow_runs: [item(101), item(102)] }).listRuns('owner/repo'), /changing workflow run total_count/);

    assert.throws(() => apiFor((page) => page === 1
        ? { total_count: 101, workflow_runs: firstHundred }
        : { total_count: 101, workflow_runs: [item(100)] }).listRuns('owner/repo'), /duplicate workflow runs/);
});

test('consolidated release workflow configures trusted publishing and rechecks pre-release eligibility', () => {
    const workflow = readFileSync(join(__dirname, '../workflows/release.yml'), 'utf8');
    assert.ok(!workflow.includes('VSCE_PAT'));
    assert.ok(!workflow.includes('OVSX_PAT'));
    assert.ok(!workflow.includes('VSCE_TOKEN'));
    assert.ok(!workflow.includes('OPEN_VSX_TOKEN'));
    assert.ok(workflow.includes("format('stable-publishing-{0}', github.ref)"));
    assert.ok(!workflow.includes("format('release-{0}', github.ref)"));

    for (const [job, envName, command] of [
        ['publish-vs-marketplace', 'vs-marketplace', 'vsce publish --oidc'],
        ['publish-open-vsx', 'open-vsx', 'ovsx publish --trusted-publishing'],
    ]) {
        const start = workflow.indexOf(`\n  ${job}:`);
        assert.ok(start >= 0);
        const nextJob = workflow.slice(start + 1).search(/\n  [a-z-]+:/);
        const body = nextJob < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
        assert.ok(body.includes(`environment: ${envName}`));
        assert.ok(body.includes('id-token: write'));
        assert.ok(body.includes(command));
    }

    for (const [job, name, envName, command] of [
        ['prerelease-publish-vs-marketplace', marketplace, 'vs-marketplace', 'vsce publish --oidc --pre-release'],
        ['prerelease-publish-open-vsx', openVsx, 'open-vsx', 'ovsx publish --trusted-publishing'],
    ]) {
        const start = workflow.indexOf(`\n  ${job}:`);
        assert.ok(start >= 0);
        const nextJob = workflow.slice(start + 1).search(/\n  [a-z-]+:/);
        const body = nextJob < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJob);
        assert.ok(body.includes(`environment: ${envName}`));
        assert.ok(body.includes('id-token: write'));
        assert.ok(body.includes('actions: read'));
        const eligibility = body.indexOf('id: eligibility');
        assert.ok(eligibility >= 0);
        assert.ok(body.indexOf('.github/scripts/marketplace-pre-release-history.js', eligibility) > eligibility);
        const publication = body.indexOf(`- name: ${name}`);
        assert.ok(publication > eligibility);
        assert.ok(body.slice(publication).includes("if: steps.eligibility.outputs.publish == 'true'"));
        assert.ok(body.slice(publication).includes(command));
    }
});

test('canonical repository run lookup includes retired marketplace-pre-release workflow ID', () => {
    const queriedPaths = [];
    const api = createGhApi((_command, args) => {
        const path = args.find((arg) => arg.startsWith('repos/'));
        queriedPaths.push(path);
        const id = path.includes('/376461048/') ? 10 : 20;
        return `${JSON.stringify({
            total_count: 1,
            workflow_runs: [run(id, '2026-11-10', 'sha-a')],
        })}\n`;
    });
    const runs = api.listRuns('REditorSupport/vscode-R');
    assert.deepEqual(queriedPaths, [
        'repos/REditorSupport/vscode-R/actions/workflows/release.yml/runs',
        'repos/REditorSupport/vscode-R/actions/workflows/376461048/runs',
    ]);
    assert.deepEqual(runs.map((item) => item.id), [20, 10]);

    const purgedLegacyApi = createGhApi((_command, args) => {
        const path = args.find((arg) => arg.startsWith('repos/'));
        if (path.includes('/376461048/')) {
            throw new Error('gh: Not Found (HTTP 404)');
        }
        return `${JSON.stringify({
            total_count: 1,
            workflow_runs: [run(20, '2026-11-10', 'sha-a')],
        })}\n`;
    });
    assert.deepEqual(purgedLegacyApi.listRuns('REditorSupport/vscode-R').map((item) => item.id), [20]);

    const transientFailureApi = createGhApi((_command, args) => {
        const path = args.find((arg) => arg.startsWith('repos/'));
        if (path.includes('/376461048/')) {
            throw new Error('gh: Bad Gateway (HTTP 502)');
        }
        return `${JSON.stringify({ total_count: 0, workflow_runs: [] })}\n`;
    });
    assert.throws(() => transientFailureApi.listRuns('REditorSupport/vscode-R'), /HTTP 502/);
});

function splitJobs(options) {
    return publishJob(options).steps.map((step, index) => ({
        name: ['publish-vs-marketplace', 'publish-open-vsx'][index], steps: [step],
    }));
}

function prereleaseSplitJobs(options) {
    return publishJob(options).steps.map((step, index) => ({
        name: ['prerelease-publish-vs-marketplace', 'prerelease-publish-open-vsx'][index], steps: [step],
    }));
}

test('split jobs: re-running only the failed registry job completes the publication', async () => {
    const prior = run(820, '2026-10-05', 'sha-a');
    const current = run(821, '2026-10-06', 'sha-a');
    const firstAttempt = prereleaseSplitJobs({ openVsxConclusion: 'failure' });
    const retriedOpenVsx = { ...prereleaseSplitJobs()[1], run_attempt: 2 };
    const jobs = [...firstAttempt, retriedOpenVsx];
    assert.equal(completedBothRegistries(firstAttempt), false);
    assert.equal(completedBothRegistries(jobs), true);
    assert.deepEqual(await decide(current, [prior, current], new Map([['820', jobs]])), {
        publish: false, date: '2026-10-06', reason: 'unchanged',
    });
});

for (const [format, jobsFor] of [
    ['prerelease split jobs', prereleaseSplitJobs],
    ['legacy split jobs', splitJobs],
    ['old combined job', (options) => [publishJob(options)]],
]) {
    test(`${format}: both registries succeeded suppress unchanged SHA`, async () => {
        const prior = run(800, '2026-10-05', 'sha-a');
        const current = run(801, '2026-10-06', 'sha-a');
        const jobs = jobsFor();
        assert.equal(didAttemptPublication(jobs), true);
        assert.equal(completedBothRegistries(jobs), true);
        assert.deepEqual(await decide(current, [prior, current], new Map([['800', jobs]])), {
            publish: false, date: '2026-10-06', reason: 'unchanged',
        });
    });
    test(`${format}: partial publication reserves date without completing publication`, async () => {
        const prior = run(810, '2026-10-05', 'sha-a');
        const current = run(811, '2026-10-05', 'sha-a');
        const jobs = jobsFor({ openVsxConclusion: 'failure' });
        assert.equal(didAttemptPublication(jobs), true);
        assert.equal(completedBothRegistries(jobs), false);
        assert.deepEqual(await decide(current, [prior, current], new Map([['810', jobs]])), {
            publish: false, date: '2026-10-05', reason: 'date-reserved',
        });
    });
}

test('path classification ignores development-only files but keeps packaging inputs', () => {
    for (const path of [
        '.github/workflows/workflow-helpers.yml',
        '.github/scripts/marketplace-pre-release-history.js',
        'src/test/node/plot.test.ts',
        'sess/tests/test_sess.R',
        'R/tests/attach_sess.R',
        'scripts/benchmark-journal.cjs',
        'scripts/sess-source.test.js',
        '.vscode/settings.json',
        '.vscode-test.mjs',
        'CONTRIBUTING.md',
        'cliff.toml',
    ]) {
        assert.equal(isRelevantPath(path), false, path);
    }
    for (const path of [
        '.github/scripts/extension-version.js',
        '.github/workflows/main.yml',
        '.github/workflows/release.yml',
        '.gitattributes',
        'src/extension.ts',
        'src/testing.ts',
        'sess/R/session.R',
        'R/sess_source.R',
        'scripts/prepare-sess.js',
        'package.json',
        'pnpm-lock.yaml',
        'esbuild.js',
        'README.md',
        'CHANGELOG.md',
    ]) {
        assert.equal(isRelevantPath(path), true, path);
    }
});

function pathFilterRuns(currentEvent = 'schedule') {
    const published = run(900, '2026-10-01', 'sha-a');
    const skipped = run(901, '2026-10-02', 'sha-b');
    const current = run(902, '2026-10-03', 'sha-c', currentEvent);
    const jobs = new Map([['900', [publishJob()]], ['901', [{ name: 'prerelease-prepare', steps: [] }]], ['902', []]]);
    return { current, runs: [published, skipped, current], jobs };
}

test('scheduled runs compare against the last published SHA and skip ignored-only changes', async () => {
    const { current, runs, jobs } = pathFilterRuns();
    const diffs = [];
    const ignoredOnly = async (base, head) => {
        diffs.push([base, head]);
        return ['.github/workflows/main.yml.bak', 'src/test/node/a.test.ts', 'sess/tests/test_a.R'];
    };
    assert.deepEqual(await decide(current, runs, jobs, ignoredOnly), {
        publish: false, date: '2026-10-03', reason: 'no-relevant-changes',
    });
    // The skipped run's SHA is not a baseline: changes accumulate from sha-a.
    assert.deepEqual(diffs, [['sha-a', 'sha-c']]);
    assert.deepEqual(await decide(current, runs, jobs, async () => []), {
        publish: false, date: '2026-10-03', reason: 'no-relevant-changes',
    });
    assert.deepEqual(await decide(current, runs, jobs, async () => ['src/test/a.ts', 'src/extension.ts']), {
        publish: true, date: '2026-10-03', reason: 'new-sha',
    });
    assert.deepEqual(await decide(current, runs, jobs, async () => ['.github/scripts/extension-version.js']), {
        publish: true, date: '2026-10-03', reason: 'new-sha',
    });
});

test('diff failures publish, while date reservation and unchanged SHA take precedence', async () => {
    const { current, runs, jobs } = pathFilterRuns();
    assert.deepEqual(await decide(current, runs, jobs, async () => { throw new Error('fetch failed'); }), {
        publish: true, date: '2026-10-03', reason: 'diff-unavailable',
    });

    let diffCalls = 0;
    const counting = async () => { diffCalls += 1; return ['src/extension.ts']; };
    const sameDay = run(903, '2026-10-03', 'sha-b', 'workflow_dispatch');
    const reserved = new Map([...jobs, ['903', [publishJob({ openVsxConclusion: 'failure' })]]]);
    assert.deepEqual(await decide(current, [...runs, sameDay], reserved, counting), {
        publish: false, date: '2026-10-03', reason: 'date-reserved',
    });
    const unchanged = run(904, '2026-10-04', 'sha-a');
    assert.deepEqual(await decide(unchanged, [runs[0], unchanged], new Map([['900', [publishJob()]]]), counting), {
        publish: false, date: '2026-10-04', reason: 'unchanged',
    });
    assert.equal(diffCalls, 0);
});

test('a full rerun after a partial publication bypasses the path filter', async () => {
    const { current, runs, jobs } = pathFilterRuns();
    const ignoredOnly = async () => ['src/test/a.ts'];
    // Attempt 1: the diff fails, so the run publishes, but Open VSX fails.
    assert.deepEqual(await decide(current, runs, jobs, async () => { throw new Error('fetch failed'); }), {
        publish: true, date: '2026-10-03', reason: 'diff-unavailable',
    });
    const partial = new Map([...jobs, ['902', prereleaseSplitJobs({ openVsxConclusion: 'failure' })]]);
    // Attempt 2 (re-run all jobs): the diff now succeeds with ignored-only
    // changes, but the run must stay eligible to complete Open VSX.
    let diffCalls = 0;
    const counting = async (...args) => { diffCalls += 1; return ignoredOnly(...args); };
    assert.deepEqual(await decide(current, runs, partial, counting), {
        publish: true, date: '2026-10-03', reason: 'retry-after-attempt',
    });
    assert.equal(diffCalls, 0);
    // Another run on the same date stays blocked by the partial attempt.
    const sameDay = run(905, '2026-10-03', 'sha-c', 'workflow_dispatch');
    assert.deepEqual(await decide(sameDay, [...runs, sameDay], partial, ignoredOnly), {
        publish: false, date: '2026-10-03', reason: 'date-reserved',
    });
    // Without a prior attempt, the same rerun still skips ignored-only changes.
    const prepared = new Map([...jobs, ['902', [{ name: 'prerelease-prepare', steps: [] }]]]);
    assert.deepEqual(await decide(current, runs, prepared, ignoredOnly), {
        publish: false, date: '2026-10-03', reason: 'no-relevant-changes',
    });
});

test('manual runs and runs without a diff source bypass the path filter', async () => {
    const manual = pathFilterRuns('workflow_dispatch');
    let diffCalls = 0;
    const ignoredOnly = async () => { diffCalls += 1; return ['src/test/a.ts']; };
    assert.deepEqual(await decide(manual.current, manual.runs, manual.jobs, ignoredOnly), {
        publish: true, date: '2026-10-03', reason: 'new-sha',
    });
    assert.equal(diffCalls, 0);
    const scheduled = pathFilterRuns();
    assert.deepEqual(await decide(scheduled.current, scheduled.runs, scheduled.jobs), {
        publish: true, date: '2026-10-03', reason: 'new-sha',
    });
});

test('git adapter fetches the baseline and lists NUL-separated changes without rename detection', () => {
    const calls = [];
    const listChangedFiles = createGitChangedFiles((command, args, options) => {
        calls.push({ command, args, options });
        return args[0] === 'diff' ? 'src/test/a b.ts\0sess/R/new\nline.R\0' : '';
    });
    assert.deepEqual(listChangedFiles('sha-a', 'sha-c'), ['src/test/a b.ts', 'sess/R/new\nline.R']);
    assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
        ['git', 'fetch', '--no-tags', '--depth=1', 'origin', 'sha-a'],
        ['git', 'diff', '--no-renames', '--name-only', '-z', 'sha-a', 'sha-c', '--'],
    ]);
    assert.ok(calls.every(({ options }) => options.timeout > 0));

    const failing = createGitChangedFiles(() => { throw new Error('fatal: remote error'); });
    assert.throws(() => failing('sha-a', 'sha-c'), /remote error/);
});

test('only the preparation job enables the pre-release path filter', () => {
    const workflow = readFileSync(join(__dirname, '../workflows/release.yml'), 'utf8');
    const matches = workflow.match(/PRERELEASE_PATH_FILTER: 'true'/g) || [];
    assert.equal(matches.length, 1);
    const prepare = workflow.indexOf('\n  prerelease-prepare:');
    const verify = workflow.indexOf('\n  prerelease-verify:');
    const position = workflow.indexOf("PRERELEASE_PATH_FILTER: 'true'");
    assert.ok(prepare >= 0 && prepare < position && position < verify);
});
