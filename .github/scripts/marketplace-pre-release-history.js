const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const WORKFLOW = 'marketplace-pre-release.yml';
const PUBLISH_JOB = 'publish';
const REGISTRY_STEPS = [
    'Publish to Visual Studio Marketplace',
    'Publish to Open VSX Registry',
];

function pagesToItems(pages, property) {
    if (!Array.isArray(pages) || pages.length === 0) {
        throw new Error(`GitHub API returned no pages for ${property}`);
    }
    return pages.flatMap((page) => {
        if (!page || !Array.isArray(page[property])) {
            throw new Error(`GitHub API response is missing ${property}`);
        }
        return page[property];
    });
}

function createGhApi(execFile = execFileSync) {
    function call(args) {
        const stdout = execFile('gh', ['api', '--method', 'GET', '--paginate', '--slurp', ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(stdout);
    }
    return {
        getRun(repository, runId) {
            const pages = call([`repos/${repository}/actions/runs/${runId}`]);
            if (!Array.isArray(pages) || pages.length !== 1 || !pages[0]?.id) {
                throw new Error('GitHub API returned an invalid current workflow run');
            }
            return pages[0];
        },
        listRuns(repository, event) {
            const pages = call([
                `repos/${repository}/actions/workflows/${WORKFLOW}/runs`,
                '-f', `event=${event}`,
                '-f', 'branch=main',
                '-f', 'per_page=100',
            ]);
            return pagesToItems(pages, 'workflow_runs');
        },
        listJobs(repository, runId) {
            const pages = call([
                `repos/${repository}/actions/runs/${runId}/jobs`,
                '-f', 'filter=all',
                '-f', 'per_page=100',
            ]);
            return pagesToItems(pages, 'jobs');
        },
    };
}

function didAttemptPublication(job) {
    if (job.name !== PUBLISH_JOB || !Array.isArray(job.steps)) {
        return false;
    }
    return job.steps.some((step) => REGISTRY_STEPS.includes(step.name)
        && (step.status === 'in_progress' || step.status === 'completed')
        && step.conclusion !== 'skipped');
}

function completedBothRegistries(job) {
    if (job.name !== PUBLISH_JOB || !Array.isArray(job.steps)) {
        return false;
    }
    return REGISTRY_STEPS.every((name) => job.steps.some((step) =>
        step.name === name && step.status === 'completed' && step.conclusion === 'success'));
}

function utcDate(run) {
    if (typeof run.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(run.created_at)) {
        throw new Error(`Workflow run ${run.id} has an invalid created_at`);
    }
    return run.created_at.slice(0, 10);
}

async function decidePublication({ api, repository, runId, sha }) {
    const currentRun = await api.getRun(repository, runId);
    if (String(currentRun.id) !== String(runId) || currentRun.head_sha !== sha || currentRun.head_branch !== 'main') {
        throw new Error('Current run identity does not match the requested main branch run');
    }
    const runDate = utcDate(currentRun);
    const histories = await Promise.all(['schedule', 'workflow_dispatch'].map((event) => api.listRuns(repository, event)));
    const uniqueRuns = new Map();
    for (const run of histories.flat()) {
        if (!run || run.id === undefined || run.head_branch !== 'main') {
            throw new Error('GitHub API returned an invalid workflow run history entry');
        }
        uniqueRuns.set(String(run.id), run);
    }
    const runs = [...uniqueRuns.values()].sort((a, b) =>
        utcDate(b).localeCompare(utcDate(a)) || new Date(b.created_at) - new Date(a.created_at));
    // Scan newest first. The same pass checks recent reservations and finds the
    // latest completed publication, so old job histories need not be fetched once
    // that publication has been found.
    for (const run of runs) {
        const jobs = await api.listJobs(repository, run.id);
        const isCurrentRun = String(run.id) === String(runId);
        if (!isCurrentRun && utcDate(run) >= runDate && jobs.some(didAttemptPublication)) {
            // A date is consumed as soon as either registry step starts. This blocks
            // another run after a partial failure, while allowing the original retry.
            return { publish: false, date: runDate, reason: 'date-reserved' };
        }
        if (jobs.some(completedBothRegistries)) {
            return run.head_sha === sha
                ? { publish: false, date: runDate, reason: 'unchanged' }
                : { publish: true, date: runDate, reason: 'new-sha' };
        }
    }
    return { publish: true, date: runDate, reason: 'no-prior-publication' };
}

async function main() {
    const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, GITHUB_OUTPUT: outputPath } = process.env;
    if (!repository || !runId || !sha || !outputPath) {
        throw new Error('Required GitHub Actions environment variables are missing');
    }
    const decision = await decidePublication({ api: createGhApi(), repository, runId, sha });
    appendFileSync(outputPath, `date=${decision.date}\npublish=${decision.publish}\n`);
    console.log(decision.publish ? `Publish pre-release for ${decision.date} (${decision.reason}).` : `Skip pre-release (${decision.reason}).`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { decidePublication, didAttemptPublication, completedBothRegistries, pagesToItems, createGhApi };
