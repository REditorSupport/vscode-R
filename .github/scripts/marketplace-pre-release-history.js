const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const WORKFLOW = 'release.yml';
// Retain the retired marketplace-pre-release.yml workflow ID on the canonical
// repository so runs from before the workflow consolidation stay visible.
const LEGACY_WORKFLOW_IDS = {
    'REditorSupport/vscode-R': ['376461048'],
};
// Include former job names when inspecting existing Actions history.
const PUBLISH_JOBS = [
    'publish',
    'publish-vs-marketplace',
    'publish-open-vsx',
    'prerelease-publish-vs-marketplace',
    'prerelease-publish-open-vsx',
];
const REGISTRY_STEPS = [
    'Publish to Visual Studio Marketplace',
    'Publish to Open VSX Registry',
];
const RUN_JQ = '{total_count, workflow_runs: [.workflow_runs[] | {id, created_at, head_sha, head_branch, event}]}';
// Changes limited to these paths do not affect the published extension, so a
// scheduled run skips publication when nothing else changed since the last
// published SHA. Anything not matched here is treated as relevant.
// TODO: This list mirrors the repository layout file by file and is easy to
// let drift. Moving the extension sources into a dedicated subdirectory (for
// example `extensions/vscode-R/`) would let the filter shrink to that
// directory plus a few shared build inputs.
const IGNORED_PATH_PATTERNS = [
    /^\.github\//,
    /^src\/test\//,
    /^sess\/tests\//,
    /^R\/tests\//,
    /^scripts\/benchmark-[^/]*$/,
    /^scripts\/[^/]*\.test\.js$/,
    /^\.vscode\//,
    /^\.vscode-test\.mjs$/,
    /^\.mocharc\.interactive\.cjs$/,
    /^\.oxfmtrc\.jsonc$/,
    /^\.oxlintrc\.jsonc$/,
    /^\.markdownlint\.json$/,
    /^\.gitignore$/,
    /^cliff\.toml$/,
    /^CONTRIBUTING\.md$/,
    /^CHANGELOG\.old\.md$/,
    /^AGENTS\.md$/,
    /^\.(?:agents|claude|codex|roborev)\//,
];
// Files under ignored directories that still determine the packaged VSIX.
const RELEVANT_PATH_EXCEPTIONS = new Set([
    '.github/scripts/extension-version.js',
    '.github/workflows/main.yml',
    '.github/workflows/release.yml',
]);
const GIT_TIMEOUT_MS = 120000;
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
    function listWorkflowRuns(repository, workflow) {
        const path = `repos/${repository}/actions/workflows/${workflow}/runs`;
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
            const runs = listWorkflowRuns(repository, WORKFLOW);
            for (const legacyId of LEGACY_WORKFLOW_IDS[repository] || []) {
                try {
                    runs.push(...listWorkflowRuns(repository, legacyId));
                } catch (error) {
                    const detail = `${error?.stderr || ''}\n${error?.message || ''}`;
                    if (!/HTTP 404\b/.test(detail)) {
                        throw error;
                    }
                }
            }
            return runs;
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

function registrySteps(jobs) {
    return jobs.filter((job) => PUBLISH_JOBS.includes(job.name))
        .flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
}

function didAttemptPublication(jobs) {
    return registrySteps(jobs).some((step) => REGISTRY_STEPS.includes(step.name)
        && (step.status === 'in_progress' || step.status === 'completed')
        && step.conclusion !== 'skipped');
}

function completedBothRegistries(jobs) {
    const steps = registrySteps(jobs);
    return REGISTRY_STEPS.every((name) => steps.some((step) =>
        step.name === name && step.status === 'completed' && step.conclusion === 'success'));
}

function isRelevantPath(path) {
    return RELEVANT_PATH_EXCEPTIONS.has(path) || !IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function createGitChangedFiles(execFile = execFileSync) {
    const git = (args) => execFile('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
    });
    return function listChangedFiles(base, head) {
        // A two-endpoint tree diff needs both commits but not the history
        // between them, so fetching the base into a shallow clone is enough.
        git(['fetch', '--no-tags', '--depth=1', 'origin', base]);
        // Without rename detection, moving a file across the ignore boundary
        // still reports the relevant side.
        const output = git(['diff', '--no-renames', '--name-only', '-z', base, head, '--']);
        return output.split('\0').filter((path) => path !== '');
    };
}

function utcDate(run) {
    if (typeof run.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(run.created_at)) {
        throw new Error(`Workflow run ${run.id} has an invalid created_at`);
    }
    return run.created_at.slice(0, 10);
}

async function decidePublication({ api, repository, runId, sha, listChangedFiles }) {
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
            if (didAttemptPublication(jobs)) {
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
            if (completedBothRegistries(jobs)) {
                const publishedSha = runs[start].head_sha;
                if (publishedSha === sha) {
                    return { publish: false, date: runDate, reason: 'unchanged' };
                }
                // Manual runs are explicit requests and bypass the path filter.
                if (!listChangedFiles || currentRun.event !== 'schedule') {
                    return { publish: true, date: runDate, reason: 'new-sha' };
                }
                // A full rerun repeats this preparation. Once an earlier attempt
                // of this run started publishing, keep it eligible so the retry
                // can complete the other registry, even if the diff now succeeds
                // with a different result than the attempt that published.
                if (didAttemptPublication(await jobsFor(currentRun))) {
                    return { publish: true, date: runDate, reason: 'retry-after-attempt' };
                }
                let changedFiles;
                try {
                    changedFiles = await listChangedFiles(publishedSha, sha);
                } catch (error) {
                    console.warn(`Could not list changes since ${publishedSha}; publishing anyway.`, error);
                    return { publish: true, date: runDate, reason: 'diff-unavailable' };
                }
                return changedFiles.some(isRelevantPath)
                    ? { publish: true, date: runDate, reason: 'new-sha' }
                    : { publish: false, date: runDate, reason: 'no-relevant-changes' };
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
    // Only the preparation job filters by path. Publication rechecks must not
    // repeat it: a fetch that fails in one registry job and succeeds in the
    // other would publish to only one registry.
    const listChangedFiles = process.env.PRERELEASE_PATH_FILTER === 'true' ? createGitChangedFiles() : undefined;
    const decision = await decidePublication({ api: createGhApi(), repository, runId, sha, listChangedFiles });
    appendFileSync(outputPath, `date=${decision.date}\npublish=${decision.publish}\n`);
    console.log(decision.publish ? `Publish pre-release for ${decision.date} (${decision.reason}).` : `Skip pre-release (${decision.reason}).`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { decidePublication, isRelevantPath, createGitChangedFiles, didAttemptPublication, completedBothRegistries, pagesToItems, completePagesToItems, createGhApi };
