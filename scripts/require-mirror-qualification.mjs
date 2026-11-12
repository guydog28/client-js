import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'ezclassify/sdk-js';
const WORKFLOW = '.github/workflows/ci.yml';
const REQUIRED = [
    'policy / plan',
    'build-and-test (22)',
    'build-and-test (24)',
    'qualification / accept',
    'ci / accept',
];
const fullEvent = (event) =>
    event === 'workflow_dispatch' || event === 'schedule';
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const refuse = () => {
    throw new Error(
        'Mirror requires complete full qualification of the current official source',
    );
};

/**
 * Select a complete native SDK qualification, or revalidate the same selection.
 * The request adapter returns parsed GitHub REST responses; all authority comes
 * from the fixed official repository and trusted checkout SHA, never caller
 * IDs.
 *
 * @param {object} options - Trusted source and read-only API adapter.
 * @param {string} options.sha - SHA from the trusted publisher event.
 * @param {string} options.checkoutSha - Actual checked-out commit.
 * @param {(path: string) => Promise<object>} options.request - GitHub REST
 *   reader.
 * @param {object} [options.expected] - Previously selected immutable tuple.
 * @returns {Promise<object>} Validated source/run/attempt/job evidence.
 */
export async function requireMirrorQualification({
    sha,
    checkoutSha,
    request,
    expected,
}) {
    if (!/^[a-f0-9]{40}$/.test(sha) || sha !== checkoutSha) refuse();
    const prefix = `/repos/${REPOSITORY}`;
    const main = async () => {
        if ((await request(`${prefix}/commits/main`)).sha !== sha) refuse();
    };
    await main();
    const listing = await request(
        `${prefix}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
    );
    if (
        !Array.isArray(listing.workflow_runs) ||
        !Number.isSafeInteger(listing.total_count) ||
        listing.total_count !== listing.workflow_runs.length ||
        listing.total_count > 100
    )
        refuse();
    const candidates = listing.workflow_runs.filter((run) =>
        fullEvent(run.event),
    );
    if (
        !candidates.length ||
        candidates.some(
            (run) =>
                !positive(run.run_number) ||
                !positive(run.id) ||
                !positive(run.run_attempt),
        )
    )
        refuse();
    candidates.sort(
        (a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt,
    );
    if (
        new Set(candidates.map((run) => run.id)).size !== candidates.length ||
        new Set(candidates.map((run) => run.run_number)).size !==
            candidates.length
    )
        refuse();
    const selected = candidates[0];
    const validate = (run) => {
        if (
            run.id !== selected.id ||
            run.run_attempt !== selected.run_attempt ||
            run.run_number !== selected.run_number ||
            !positive(run.workflow_id) ||
            run.workflow_id !== selected.workflow_id ||
            run.repository?.full_name !== REPOSITORY ||
            run.head_repository?.full_name !== REPOSITORY ||
            run.path !== WORKFLOW ||
            run.head_branch !== 'main' ||
            run.head_sha !== sha ||
            !fullEvent(run.event) ||
            run.event !== selected.event ||
            run.status !== 'completed' ||
            run.conclusion !== 'success'
        )
            refuse();
    };
    validate(selected);
    validate(await request(`${prefix}/actions/runs/${selected.id}`));
    const page = await request(
        `${prefix}/actions/runs/${selected.id}/attempts/${selected.run_attempt}/jobs?per_page=100`,
    );
    if (
        !Array.isArray(page.jobs) ||
        page.total_count !== page.jobs.length ||
        page.jobs.length !== REQUIRED.length
    )
        refuse();
    const names = new Set();
    const ids = new Set();
    for (const job of page.jobs) {
        if (
            !positive(job.id) ||
            ids.has(job.id) ||
            names.has(job.name) ||
            !REQUIRED.includes(job.name) ||
            job.run_id !== selected.id ||
            job.run_attempt !== selected.run_attempt ||
            job.head_sha !== sha ||
            job.status !== 'completed' ||
            job.conclusion !== 'success'
        )
            refuse();
        names.add(job.name);
        ids.add(job.id);
    }
    validate(await request(`${prefix}/actions/runs/${selected.id}`));
    await main();
    const evidence = {
        repository: REPOSITORY,
        sha,
        workflow: WORKFLOW,
        workflowId: selected.workflow_id,
        runId: selected.id,
        runNumber: selected.run_number,
        attempt: selected.run_attempt,
        event: selected.event,
        jobs: page.jobs
            .map(({ id, name }) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
    if (
        expected !== undefined &&
        JSON.stringify(expected) !== JSON.stringify(evidence)
    )
        refuse();
    return evidence;
}

async function main() {
    const env = process.env;
    if (
        env.GITHUB_REPOSITORY !== REPOSITORY ||
        env.GITHUB_REF !== 'refs/heads/main' ||
        !fullEvent(env.GITHUB_EVENT_NAME) ||
        !env.GITHUB_TOKEN ||
        !env.RUNNER_TEMP
    )
        refuse();
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--recheck')) refuse();
    const filename = `${env.RUNNER_TEMP}/sdk-mirror-qualification.json`;
    const expected = args.length
        ? JSON.parse(readFileSync(filename, 'utf8'))
        : undefined;
    const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    const request = async (path) => {
        const response = await fetch(`https://api.github.com${path}`, {
            headers: {
                'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
            throw new Error(
                `Qualification API read failed (${response.status})`,
            );
        return response.json();
    };
    const evidence = await requireMirrorQualification({
        sha: env.GITHUB_SHA,
        checkoutSha,
        request,
        expected,
    });
    if (!args.length)
        writeFileSync(filename, `${JSON.stringify(evidence, null, 2)}\n`, {
            mode: 0o600,
        });
    console.log(
        `Qualified ${evidence.sha} via CI ${evidence.runId} attempt ${evidence.attempt}`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
