/**
 * Format coverage, answered from the profile a Context-bound client already
 * holds.
 *
 * A UI asks which categories a field's format writes so it can carry a
 * committed value the format cannot write beside the text it reads back. An
 * adapter with no answer leaves the UI nothing to carry, and the value is
 * dropped on the next edit. The engine computes the same coverage from the same
 * scheme; the expected answers below are the engine's for the documents these
 * recordings were made from, except where the client cannot see what the engine
 * sees, which each case says.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FormatCoverage, SchemePublicView } from '@ezclassify/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemeProfileState } from '../src/client-ops';
import { connectContext } from '../src/connect';
import { ErrorCodes } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusBody } from './contract-fixtures';

type Resources = Array<[suffix: string, caseId: string]>;

/** The unlayered `ez-test` scheme, as the `ez-full` Context serves it. */
const UNLAYERED: Resources = [
    ['/scheme/concepts', 'ctx-scheme-concepts.full'],
    ['/scheme/categories', 'ctx-scheme-categories.full'],
    ['/scheme/formats', 'ctx-scheme-formats.full'],
    ['/scheme/scopes', 'ctx-scheme-scopes.full'],
    ['/scheme/label-presets', 'ctx-scheme-label-presets.full'],
    ['/scheme', 'ctx-scheme-summary.full'],
];

/**
 * `ez-test` composed with the `ez-layer` layer, which adds a `caveats` category
 * and its NOFORN concept and declares no format. The corpus records the
 * composed summary, concepts and categories; the composed formats are the base
 * scheme's, which the unlayered recording holds.
 */
const LAYERED: Resources = [
    ['/scheme/concepts', 'ctx-scheme-concepts.layered'],
    ['/scheme/categories', 'ctx-scheme-categories.layered'],
    ['/scheme/formats', 'ctx-scheme-formats.full'],
    ['/scheme/scopes', 'ctx-scheme-scopes.full'],
    ['/scheme/label-presets', 'ctx-scheme-label-presets.full'],
    ['/scheme', 'ctx-scheme-summary.layered'],
];

describe('getFormatCoverage on a Context-bound scheme', () => {
    const originalFetch = globalThis.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    async function connectOver(resources: Resources) {
        fetchMock = stubFetch();
        fetchMock.mockImplementation((url: string) => {
            const path = url.split('?')[0] ?? '';
            const resource = resources.find(([suffix]) =>
                path.endsWith(suffix),
            );
            const payload = resource
                ? corpusBody(resource[1])
                : path.endsWith('/v1/health')
                  ? { status: 'ok' }
                  : corpusBody('ctx-describe.ok');
            return Promise.resolve(mockResponse(200, JSON.stringify(payload)));
        });
        return connectContext({
            baseUrl: 'https://api.example.com',
            contextId: 'ez-full',
            contextVersion: '1.0.0',
        });
    }

    it('reports a category the format never writes, so its concept can be carried', async () => {
        const client = await connectOver(LAYERED);
        try {
            const noforn = client.scheme
                .getScheme()
                .concepts.find((concept) => concept.id === 'NOFORN');
            expect(noforn?.categories).toEqual(['caveats']);
            const requests = fetchMock.mock.calls.length;

            const coverage = client.scheme.getFormatCoverage('default');

            // The engine's answer for the composed scheme, member for member.
            expect(coverage).toEqual({
                formatId: 'default',
                coveredCategories: ['level'],
                valueLossyCategories: [],
                reconstruction: {
                    status: 'unknown',
                    reasons: ['Categories this format never writes: caveats.'],
                },
            });
            expect(coverage.coveredCategories).not.toContain('caveats');
            expect(fetchMock.mock.calls.length).toBe(requests);
        } finally {
            client.destroy();
        }
    });

    it("answers for the scheme's default render format when none is named", async () => {
        const client = await connectOver(LAYERED);
        try {
            expect(client.scheme.getScheme().defaultRenderFormat).toBe(
                'default',
            );
            expect(client.scheme.getFormatCoverage()).toEqual(
                client.scheme.getFormatCoverage('default'),
            );
        } finally {
            client.destroy();
        }
    });

    it('covers every category of a format that writes them all, without claiming a proof it cannot make', async () => {
        const client = await connectOver(UNLAYERED);
        try {
            const requests = fetchMock.mock.calls.length;
            const coverage = client.scheme.getFormatCoverage('default');

            expect(coverage.formatId).toBe('default');
            expect(coverage.coveredCategories).toEqual(['level']);
            expect(coverage.valueLossyCategories).toEqual([]);
            // The engine reports `supported` here, from the format's field
            // tree. The profile carries the layout only, so the client says it
            // cannot establish the proof rather than asserting one.
            expect(coverage.reconstruction.status).toBe('unknown');
            expect(coverage.reconstruction.reasons).toHaveLength(1);
            expect(fetchMock.mock.calls.length).toBe(requests);
        } finally {
            client.destroy();
        }
    });

    it('refuses a format the scheme does not declare', async () => {
        const client = await connectOver(UNLAYERED);
        try {
            expect(() => client.scheme.getFormatCoverage('missing')).toThrow(
                expect.objectContaining({ code: ErrorCodes.INVALID_INPUT }),
            );
        } finally {
            client.destroy();
        }
    });
});

/** One case of the vendored `format-coverage` conformance plan. */
interface PlanCase {
    name: string;
    method: string;
    args: unknown[];
    fixture: string;
}

/** One recorded engine answer, keyed as every SDK runner keys it. */
interface RecordedAnswer {
    method: string;
    response: unknown;
}

const SPEC = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/spec');

function readSpec<T>(...segments: string[]): T {
    return JSON.parse(readFileSync(resolve(SPEC, ...segments), 'utf8')) as T;
}

/** Key-sorted compact JSON, the form a recording key is computed over. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(
                ([key, member]) =>
                    `${JSON.stringify(key)}:${canonical(member)}`,
            );
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * The recording key of a case: the SHA-256 of its method, arguments, fixture,
 * mode, Context id and version, and guide and access fixtures, joined by `|`.
 * This plan's cases name no mode, Context, guide or access fixture.
 */
function recordingKey(planCase: PlanCase): string {
    const parts = [
        planCase.method,
        canonical(planCase.args),
        canonical(planCase.fixture),
        'fromJSON',
        '',
        '',
        '',
        '',
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** The client's coverage for `formatId`, over a published profile. */
function clientCoverage(
    profile: SchemePublicView,
    formatId?: string,
): FormatCoverage {
    const state = new SchemeProfileState();
    state._setActiveProfile({ view: profile });
    return state.getFormatCoverage(formatId);
}

/**
 * What the client can match of the engine's answer. The categories and the
 * format id must be the engine's. The client never claims a reconstruction
 * proof, which takes the field tree; when a category goes unwritten its one
 * reason is the engine's first.
 */
function expectEngineAnswer(client: FormatCoverage, engine: FormatCoverage) {
    expect(client.formatId).toBe(engine.formatId);
    expect(client.coveredCategories).toEqual(engine.coveredCategories);
    expect(client.valueLossyCategories).toEqual(engine.valueLossyCategories);
    expect(client.reconstruction.status).toBe('unknown');
    const unwritten = engine.reconstruction.reasons.find((reason) =>
        reason.startsWith('Categories this format never writes: '),
    );
    if (unwritten) expect(client.reconstruction.reasons).toEqual([unwritten]);
}

describe('getFormatCoverage against the engine, for every recorded output', () => {
    const plan = readSpec<{ cases: PlanCase[] }>(
        'plans',
        'v1',
        'format-coverage.json',
    );
    const { responses } = readSpec<{
        responses: Record<string, RecordedAnswer>;
    }>('recordings', 'v1', 'format-coverage.recordings.json');

    function answer<T>(planCase: PlanCase): T {
        const recorded = responses[recordingKey(planCase)];
        if (!recorded || recorded.method !== planCase.method) {
            throw new Error(`no recorded answer for ${planCase.name}`);
        }
        return recorded.response as T;
    }

    const profiles = plan.cases.filter((c) => c.method === 'getScheme');
    const coverages = plan.cases.filter(
        (c) => c.method === 'getFormatCoverage',
    );

    it('records a profile and coverage cases to check', () => {
        expect(profiles.length).toBeGreaterThan(0);
        expect(coverages.length).toBeGreaterThan(profiles.length);
    });

    describe.each(profiles.map((c) => [c.fixture, c] as const))(
        '%s',
        (fixture, profileCase) => {
            const profile = answer<SchemePublicView>(profileCase);
            const recorded = coverages.filter((c) => c.fixture === fixture);

            it('records the coverage of every output the profile publishes, and of the default', () => {
                const named = recorded.map((c) => c.args[0]);
                expect(new Set(named)).toEqual(
                    new Set([...profile.formats.map((f) => f.id), undefined]),
                );
            });

            it.each(recorded.map((c) => [c.name, c] as const))(
                '%s answers what the engine answers',
                (_name, coverageCase) => {
                    const formatId = coverageCase.args[0] as string | undefined;
                    expectEngineAnswer(
                        clientCoverage(profile, formatId),
                        answer<FormatCoverage>(coverageCase),
                    );
                },
            );
        },
    );

    it("a layout that listed a case format's categories would not answer what the engine does (negative control)", () => {
        const profileCase = profiles.find(
            (c) => c.fixture === 'ref-surfaces-1',
        );
        const coverageCase = coverages.find(
            (c) =>
                c.fixture === 'ref-surfaces-1' &&
                c.args[0] === 'sensitivity/short',
        );
        if (!profileCase || !coverageCase) {
            throw new Error('the plan no longer records the view with a case');
        }
        const profile = structuredClone(answer<SchemePublicView>(profileCase));
        const engine = answer<FormatCoverage>(coverageCase);
        const view = profile.formats.find((f) => f.id === 'sensitivity/short');
        const added = profile.categories
            .map((c) => c.id)
            .find((id) => !view?.categoryOrder.includes(id));
        if (!view || !added) throw new Error('the view writes every category');
        view.categoryOrder.push(added);

        expect(
            clientCoverage(profile, 'sensitivity/short').coveredCategories,
        ).not.toEqual(engine.coveredCategories);
    });
});
