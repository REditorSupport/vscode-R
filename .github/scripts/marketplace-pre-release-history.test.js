const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createGhApi, decidePublication, pagesToItems } = require('./marketplace-pre-release-history');

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
    const eventsQueried = [];
    return {
        eventsQueried,
        api: {
            async getRun(_repository, id) {
                assert.equal(String(id), String(current.id));
                return current;
            },
            async listRuns(_repository, event) {
                eventsQueried.push(event);
                return runs.filter((item) => item.event === event);
            },
            async listJobs(_repository, id) {
                return jobsByRun.get(String(id)) || [];
            },
        },
    };
}

async function decide(current, runs, jobsByRun) {
    const { api, eventsQueried } = harness(current, runs, jobsByRun);
    const result = await decidePublication({ api, repository: 'owner/repo', runId: current.id, sha: current.head_sha });
    assert.deepEqual(eventsQueried.sort(), ['schedule', 'workflow_dispatch']);
    return result;
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
        async listRuns(_repository, event) { return event === 'schedule' ? [current] : []; },
        async listJobs() { throw new Error('Job history unavailable'); },
    };
    await assert.rejects(decidePublication({ api: jobsApi, repository: 'owner/repo', runId: current.id, sha: current.head_sha }), /Job history unavailable/);
});

test('GitHub API adapter uses GET with pagination for run and all-attempt job queries', () => {
    const calls = [];
    const api = createGhApi((_command, args) => {
        calls.push(args);
        if (args.some((arg) => arg.includes('/actions/runs/70/jobs'))) {
            return JSON.stringify([{ jobs: [] }]);
        }
        if (args.some((arg) => arg.includes('/actions/workflows/'))) {
            return JSON.stringify([{ workflow_runs: [] }]);
        }
        return JSON.stringify([{ id: 70, head_sha: 'sha-a', head_branch: 'main' }]);
    });
    api.getRun('owner/repo', 70);
    api.listRuns('owner/repo', 'schedule');
    api.listRuns('owner/repo', 'workflow_dispatch');
    api.listJobs('owner/repo', 70);
    assert.equal(calls.length, 4);
    for (const args of calls) {
        assert.ok(args.includes('--method'));
        assert.equal(args[args.indexOf('--method') + 1], 'GET');
        assert.ok(args.includes('--paginate'));
        assert.ok(args.includes('--slurp'));
    }
    assert.ok(calls[1].includes('event=schedule'));
    assert.ok(calls[2].includes('event=workflow_dispatch'));
    assert.ok(calls[3].includes('filter=all'));
});

test('workflow rechecks eligibility in the publishing job and gates both registries', () => {
    const workflowPath = join(__dirname, '../workflows/marketplace-pre-release.yml');
    const workflow = readFileSync(workflowPath, 'utf8');
    const prepareStart = workflow.indexOf('  prepare:');
    const publishStart = workflow.indexOf('\n  publish:\n    needs:');
    const prepare = workflow.slice(prepareStart, publishStart);
    const helperIndex = prepare.indexOf('.github/scripts/marketplace-pre-release-history.js');
    assert.ok(helperIndex >= 0);
    assert.ok(prepare.slice(0, helperIndex).includes('uses: actions/checkout@'));
    assert.match(prepare.slice(0, helperIndex), /uses: actions\/setup-node@[\s\S]*?node-version: 24/);
    const publish = workflow.slice(publishStart);
    const eligibilityIndex = publish.indexOf('id: eligibility');
    assert.ok(eligibilityIndex >= 0);
    assert.match(publish.slice(eligibilityIndex), /run: node \.github\/scripts\/marketplace-pre-release-history\.js/);
    for (const name of [marketplace, openVsx]) {
        const index = publish.indexOf(`- name: ${name}`);
        assert.ok(index > eligibilityIndex, `${name} must run after the eligibility check`);
        const nextStep = publish.indexOf('\n      - name:', index + 1);
        const step = publish.slice(index, nextStep < 0 ? undefined : nextStep);
        assert.match(step, /if: steps\.eligibility\.outputs\.publish == 'true'/);
    }
});
