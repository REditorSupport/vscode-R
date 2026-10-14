const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const WORKFLOW = 'marketplace-pre-release.yml';
const PUBLISH_JOB = 'publish';
const REGISTRY_STEPS = [
    'Publish to Visual Studio Marketplace',
    'Publish to Open VSX Registry',
];
const RUN_JQ = '{total_count, workflow_runs: [.workflow_runs[] | {id, created_at, head_sha, head_branch, event}]}';
const JOBS_JQ = '{total_count, jobs: [.jobs[] | {name, run_attempt, steps: [(.steps // [])[] | select(.name == "Publish to Visual Studio Marketplace" or .name == "Publish to Open VSX Registry") | {name, status, conclusion}]}]}';

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

function completePagesToItems(pages, property) {
    const items = pagesToItems(pages, property);
    const totalCount = pages[0].total_count;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
        throw new Error(`GitHub API response is missing a valid total_count for ${property}`);
    }
    if (items.length !== totalCount) {
        throw new Error(`GitHub API returned incomplete ${property} history (${items.length} of ${totalCount})`);
    }
    return items;
}

function createGhApi(execFile = execFileSync) {
    function call(args, { jq, paginate = true } = {}) {
        const ghArgs = ['api', '--method', 'GET'];
        if (paginate) {
            ghArgs.push('--paginate');
        }
        if (jq) {
            // Serialize each projected page as one compact JSON line, then parse
            // those lines independently.
            ghArgs.push('--jq', `(${jq}) | tojson`);
        }
        const stdout = execFile('gh', [...ghArgs, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!jq) {
            return JSON.parse(stdout);
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
            throw new Error('GitHub API returned no paginated JSON results');
        }
        return trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
    }
    return {
        getRun(repository, runId) {
            const run = call([`repos/${repository}/actions/runs/${runId}`], { paginate: false });
            if (!run || typeof run !== 'object' || Array.isArray(run) || run.id === undefined || run.id === null) {
                throw new Error('GitHub API returned an invalid current workflow run');
            }
            return run;
        },
        listRuns(repository) {
            const path = `repos/${repository}/actions/workflows/${WORKFLOW}/runs`;
            const allRuns = [];
            let totalCount;
            let page = 1;
            do {
                const pages = call([
                    path,
                    '-f', 'per_page=100',
                    '-f', `page=${page}`,
                ], { jq: RUN_JQ, paginate: false });
                if (pages.length !== 1) {
                    throw new Error(`GitHub API returned an invalid workflow runs page ${page}`);
                }
                const pageTotal = pages[0].total_count;
                if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (totalCount !== undefined && pageTotal !== totalCount)) {
                    throw new Error('GitHub API returned an invalid or changing workflow run total_count');
                }
                totalCount = pageTotal;
                const pageRuns = pagesToItems(pages, 'workflow_runs');
                if (pageRuns.length === 0 && allRuns.length < totalCount) {
                    throw new Error(`GitHub API returned incomplete workflow run history (${allRuns.length} of ${totalCount})`);
                }
                allRuns.push(...pageRuns);
                page += 1;
            } while (allRuns.length < totalCount);
            if (allRuns.length !== totalCount) {
                throw new Error(`GitHub API returned incomplete workflow run history (${allRuns.length} of ${totalCount})`);
            }
            if (new Set(allRuns.map((run) => String(run.id))).size !== allRuns.length) {
                throw new Error('GitHub API returned duplicate workflow runs across pages');
            }
            return allRuns;
        },
        listJobs(repository, runId) {
            const pages = call([
                `repos/${repository}/actions/runs/${runId}/jobs`,
                '-f', 'filter=all',
                '-f', 'per_page=100',
            ], { jq: JOBS_JQ });
            return completePagesToItems(pages, 'jobs');
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
    const history = await api.listRuns(repository);
    const uniqueRuns = new Map();
    for (const run of history) {
        if (!run || run.id === undefined) {
            throw new Error('GitHub API returned an invalid workflow run history entry');
        }
        if (run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)) {
            continue;
        }
        uniqueRuns.set(String(run.id), run);
    }
    const runs = [...uniqueRuns.values()].sort((a, b) =>
        utcDate(b).localeCompare(utcDate(a)) || new Date(b.created_at) - new Date(a.created_at));
    const jobsByRun = new Map();
    async function jobsFor(run) {
        const key = String(run.id);
        if (!jobsByRun.has(key)) {
            jobsByRun.set(key, await api.listJobs(repository, run.id));
        }
        return jobsByRun.get(key);
    }

    // Check every run that could reserve the current date before considering
    // publication history. Those responses are reused by the search below.
    let dateReserved = false;
    for (const run of runs) {
        const isCurrentRun = String(run.id) === String(runId);
        if (!isCurrentRun && utcDate(run) >= runDate) {
            const jobs = await jobsFor(run);
            if (jobs.some(didAttemptPublication)) {
                dateReserved = true;
                break;
            }
        }
    }
    // A date is consumed as soon as either registry step starts. This blocks
    // another run after a partial failure, while allowing the original retry.
    if (dateReserved) {
        return { publish: false, date: runDate, reason: 'date-reserved' };
    }

    // No-op runs often share the SHA of the last published run. Search each
    // contiguous SHA group from oldest to newest: one completed publication
    // proves the group's SHA and ends the search without querying every no-op.
    for (let start = 0; start < runs.length;) {
        let end = start + 1;
        while (end < runs.length && runs[end].head_sha === runs[start].head_sha) {
            end += 1;
        }
        for (let index = end - 1; index >= start; index -= 1) {
            const jobs = await jobsFor(runs[index]);
            if (jobs.some(completedBothRegistries)) {
                return runs[start].head_sha === sha
                    ? { publish: false, date: runDate, reason: 'unchanged' }
                    : { publish: true, date: runDate, reason: 'new-sha' };
            }
        }
        start = end;
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

module.exports = { decidePublication, didAttemptPublication, completedBothRegistries, pagesToItems, completePagesToItems, createGhApi };
