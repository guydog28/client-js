// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error - native plain ESM guard
import { requireMirrorQualification } from './require-mirror-qualification.mjs';

const sha = 'a'.repeat(40);
const repository = { full_name: 'ezclassify/sdk-js' };
const names = [
    'policy / plan',
    'build-and-test (22)',
    'build-and-test (24)',
    'qualification / accept',
    'ci / accept',
];
const run = {
    id: 51,
    run_number: 12,
    run_attempt: 2,
    workflow_id: 8,
    repository,
    head_repository: repository,
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: sha,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
};
const jobs = names.map((name, index) => ({
    id: 100 + index,
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
}));
type Run = typeof run;
type Job = (typeof jobs)[number];

function fixture(
    options: {
        runs?: Run[];
        jobs?: Job[];
        count?: number;
        jobCount?: number;
        main?: string;
        runRead?: (index: number) => Run;
        mainRead?: (index: number) => string;
    } = {},
) {
    let reads = 0;
    let mains = 0;
    const paths: string[] = [];
    const request = async (path: string) => {
        paths.push(path);
        if (path.endsWith('/commits/main'))
            return { sha: options.mainRead?.(++mains) ?? options.main ?? sha };
        if (path.includes('/workflows/'))
            return {
                total_count: options.count ?? options.runs?.length ?? 1,
                workflow_runs: options.runs ?? [run],
            };
        if (path.includes('/jobs?'))
            return {
                total_count:
                    options.jobCount ?? options.jobs?.length ?? jobs.length,
                jobs: options.jobs ?? jobs,
            };
        return options.runRead?.(++reads) ?? run;
    };
    return { request, paths };
}
const qualify = (
    options: Parameters<typeof fixture>[0] = {},
    extra: Record<string, unknown> = {},
) =>
    requireMirrorQualification({
        sha,
        checkoutSha: sha,
        ...fixture(options),
        ...extra,
    });

describe('exact-source native SDK full qualification', () => {
    it.each(['workflow_dispatch', 'schedule'])(
        'admits complete %s source and pins run, attempt, matrix and job IDs',
        async (event) => {
            const selected = { ...run, event };
            const f = fixture({ runs: [selected], runRead: () => selected });
            const evidence = await requireMirrorQualification({
                sha,
                checkoutSha: sha,
                request: f.request,
            });
            expect(evidence).toMatchObject({
                repository: repository.full_name,
                sha,
                runId: 51,
                attempt: 2,
                runNumber: 12,
            });
            expect(evidence.jobs.map((job: Job) => job.name).sort()).toEqual(
                [...names].sort(),
            );
            expect(f.paths).toContain(
                '/repos/ezclassify/sdk-js/actions/runs/51/attempts/2/jobs?per_page=100',
            );
            await expect(
                requireMirrorQualification({
                    sha,
                    checkoutSha: sha,
                    request: f.request,
                    expected: evidence,
                }),
            ).resolves.toEqual(evidence);
        },
    );
    it.each(['push', 'pull_request'])(
        'refuses routine green %s qualification',
        async (event) => {
            await expect(
                qualify({ runs: [{ ...run, event }] }),
            ).rejects.toThrow('qualification');
        },
    );
    it.each([
        { repository: { full_name: 'someone/sdk-js' } },
        { head_repository: { full_name: 'someone/sdk-js' } },
        { head_branch: 'feature' },
        { head_sha: 'b'.repeat(40) },
        { path: '.github/workflows/other.yml' },
        { workflow_id: 0 },
        { status: 'in_progress' },
        { conclusion: 'failure' },
        { id: 0 },
        { run_attempt: 0 },
        { run_number: 0 },
    ])('refuses wrong run authority/profile %j', async (change) => {
        await expect(
            qualify({ runs: [{ ...run, ...change }] }),
        ).rejects.toThrow();
    });
    it('refuses absent full runs and mismatched checkout/current main', async () => {
        await expect(qualify({ runs: [] })).rejects.toThrow();
        await expect(
            qualify({}, { checkoutSha: 'b'.repeat(40) }),
        ).rejects.toThrow();
        await expect(qualify({ main: 'b'.repeat(40) })).rejects.toThrow();
        await expect(qualify({}, { sha: 'not-a-sha' })).rejects.toThrow();
    });
    it.each(['failure', null])(
        'never falls back from latest unsuccessful full run (%s)',
        async (conclusion) => {
            await expect(
                qualify({
                    runs: [
                        { ...run, id: 50, run_number: 11 },
                        { ...run, conclusion: conclusion as string },
                    ],
                }),
            ).rejects.toThrow();
        },
    );
    it('refuses truncated, duplicate, and malformed run listings', async () => {
        await expect(qualify({ count: 101 })).rejects.toThrow();
        await expect(qualify({ runs: [run, run] })).rejects.toThrow();
        await expect(
            qualify({}, { request: async () => ({}) }),
        ).rejects.toThrow();
    });
    it.each([
        { status: 'in_progress' },
        { conclusion: 'skipped' },
        { conclusion: 'failure' },
        { name: 'build-and-test (20)' },
        { head_sha: 'b'.repeat(40) },
        { run_id: 50 },
        { run_attempt: 1 },
        { id: 0 },
    ])('refuses incomplete or foreign attempt job %j', async (change) => {
        await expect(
            qualify({ jobs: [{ ...jobs[0], ...change }, ...jobs.slice(1)] }),
        ).rejects.toThrow();
    });
    it('refuses missing/duplicate/extra jobs, duplicate IDs and truncated job pages', async () => {
        for (const altered of [
            jobs.slice(1),
            [jobs[0], jobs[0], ...jobs.slice(2)],
            [...jobs, { ...jobs[0], id: 999, name: 'extra' }],
            jobs.map((job) => ({ ...job, id: 100 })),
        ]) {
            await expect(qualify({ jobs: altered })).rejects.toThrow();
        }
        await expect(qualify({ jobCount: 100 })).rejects.toThrow();
    });
    it('refuses rerun attempt drift and main drift during selection', async () => {
        await expect(
            qualify({
                runRead: (index) =>
                    index === 1 ? run : { ...run, run_attempt: 3 },
            }),
        ).rejects.toThrow();
        await expect(
            qualify({
                mainRead: (index) => (index === 1 ? sha : 'b'.repeat(40)),
            }),
        ).rejects.toThrow();
    });
    it('before-write recheck refuses new main, a newer failed run, or replacement successful evidence', async () => {
        const evidence = await qualify();
        await expect(qualify({}, { expected: null })).rejects.toThrow();
        await expect(
            qualify({ main: 'b'.repeat(40) }, { expected: evidence }),
        ).rejects.toThrow();
        await expect(
            qualify(
                {
                    runs: [
                        {
                            ...run,
                            id: 52,
                            run_number: 13,
                            conclusion: 'failure',
                        },
                        run,
                    ],
                },
                { expected: evidence },
            ),
        ).rejects.toThrow();
        await expect(
            qualify(
                { jobs: jobs.map((job) => ({ ...job, id: job.id + 10 })) },
                { expected: evidence },
            ),
        ).rejects.toThrow();
        const next = { ...run, run_attempt: 3 };
        await expect(
            qualify(
                {
                    runs: [next],
                    runRead: () => next,
                    jobs: jobs.map((job) => ({ ...job, run_attempt: 3 })),
                },
                { expected: evidence },
            ),
        ).rejects.toThrow();
    });
});
