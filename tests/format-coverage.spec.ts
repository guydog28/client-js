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

import { afterEach, describe, expect, it, vi } from 'vitest';
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
