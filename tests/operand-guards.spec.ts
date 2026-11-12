/**
 * Guards on the operands a caller hands in and on the bodies a deployment hands
 * back, for the two operations where a silent answer is worse than a failure: a
 * coverage check that reports coverage nobody verified, and a render that
 * reports a marking the server never sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import { coerceRenderedString } from '../src/client-ops';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

/** Wrap an operation result in the Context envelope every ctx route sends. */
function envelope(result: unknown): string {
    return JSON.stringify({
        resolution: {
            contextId: 'records',
            requestedVersion: '1.0.0',
            resolvedVersion: '1.0.0',
            artifacts: [],
        },
        result,
    });
}

describe('checkCoverage operand guards', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function client(): EzClassifyClient {
        return new EzClassifyClient(BASE_URL, {
            contextId: 'records',
            contextVersion: '1.0.0',
        });
    }

    it('refuses children with no parent to check them against', async () => {
        let caught: EzClassifyError | null = null;
        try {
            await client().scheme.checkCoverage(['LEVEL-A'], '');
        } catch (err) {
            caught = err as EzClassifyError;
        }
        expect(caught).toBeInstanceOf(EzClassifyError);
        expect(caught?.code).toBe(ErrorCodes.INVALID_INPUT);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports no children as covered without asking the server', async () => {
        const report = await client().scheme.checkCoverage([], 'LEVEL-HIGH');
        expect(report.covered).toBe(true);
        expect(report.missing).toEqual([]);
        expect(report.missingLabels).toEqual([]);
        expect(report.excess).toEqual([]);
        expect(report.excessLabels).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports children that are all empty strings as covered', async () => {
        const report = await client().scheme.checkCoverage(['', ''], '');
        expect(report.covered).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks the server once both operands are real', async () => {
        const excess = {
            conceptId: 'SHARE-B',
            categoryId: 'share',
            confidence: 'certain',
            source: 'parse',
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                envelope({
                    covered: false,
                    missing: [],
                    missingLabels: [],
                    excess: [excess],
                    excessLabels: ['Share B'],
                    rendered: 'LEVEL-HIGH',
                }),
            ),
        );
        const report = await client().scheme.checkCoverage(
            ['LEVEL-A'],
            'LEVEL-HIGH',
        );
        expect(report.covered).toBe(false);
        expect(report.excess).toEqual([excess]);
        expect(report.excessLabels).toEqual(['Share B']);
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('coerceRenderedString', () => {
    it('passes a bare string through', () => {
        expect(coerceRenderedString('LEVEL-HIGH')).toBe('LEVEL-HIGH');
    });

    it('reads the two documented wrapper shapes', () => {
        expect(coerceRenderedString({ result: 'LEVEL-HIGH' })).toBe(
            'LEVEL-HIGH',
        );
        expect(coerceRenderedString({ rendered: 'LEVEL-HIGH' })).toBe(
            'LEVEL-HIGH',
        );
    });

    it('keeps an empty string the server actually sent', () => {
        expect(coerceRenderedString({ result: '' })).toBe('');
    });

    it('fails on a body carrying no marking string', () => {
        for (const body of [{ marking: 'LEVEL-HIGH' }, {}, null, 42]) {
            expect(() => coerceRenderedString(body)).toThrow(EzClassifyError);
        }
    });
});

describe('render against a deployment that answers off-contract', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('rejects rather than handing back a blank marking', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, envelope({ marking: 'LEVEL-HIGH' })),
        );
        const c = new EzClassifyClient(BASE_URL, {
            contextId: 'records',
            contextVersion: '1.0.0',
        });
        await expect(
            c.scheme.render([{ conceptId: 'A', categoryId: 'levels' }]),
        ).rejects.toBeInstanceOf(EzClassifyError);
    });
});

describe('suggestForCategories category identity', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function client(): EzClassifyClient {
        return new EzClassifyClient(BASE_URL, {
            contextId: 'records',
            contextVersion: '1.0.0',
        });
    }

    const suggestion = { suggestions: [], warnings: [] };

    it('rejects an omitted category whose id is inherited by ordinary objects', async () => {
        // The map answers another category, so the only thing that can
        // make `toString` look answered is the prototype chain.
        fetchMock.mockResolvedValue(
            mockResponse(200, envelope({ level: suggestion })),
        );
        await expect(
            client().scheme.suggestForCategories([], ['level', 'toString']),
        ).rejects.toMatchObject({ code: ErrorCodes.MALFORMED_RESPONSE });
    });

    it('returns prototype-named and ordinary categories as own entries', async () => {
        // Written out by hand because an object literal with a `__proto__`
        // key sets the prototype instead of carrying the key; JSON.parse on
        // the client side makes it an ordinary member, which is the case here.
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                `{"resolution":{"contextId":"records","resolvedVersion":"1.0.0","artifacts":[]},` +
                    `"result":{"__proto__":${JSON.stringify(suggestion)},"level":${JSON.stringify(suggestion)}}}`,
            ),
        );
        const result = await client().scheme.suggestForCategories(
            [],
            ['__proto__', 'level'],
        );
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(result['__proto__']).toEqual(suggestion);
        expect(result.level).toEqual(suggestion);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });

    it('answers the empty map when no category is named', async () => {
        // The result is the map itself, so `{}` is the whole right answer
        // here. Every other route refuses an empty result object; this one
        // must not, or asking about nothing becomes an error.
        fetchMock.mockResolvedValue(mockResponse(200, envelope({})));
        await expect(
            client().scheme.suggestForCategories([], []),
        ).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects the empty map when a category was named', async () => {
        // Letting `{}` through the envelope moves the decision to the
        // client's own key check, which names what is missing.
        fetchMock.mockResolvedValue(mockResponse(200, envelope({})));
        await expect(
            client().scheme.suggestForCategories([], ['level']),
        ).rejects.toMatchObject({
            code: ErrorCodes.MALFORMED_RESPONSE,
            message: expect.stringContaining('answered no result for: level'),
        });
    });

    it.each([
        ['an array', []],
        ['a null result for one category', { level: null }],
        ['an array result for one category', { level: [] }],
    ])('rejects %s', async (_shape, wire) => {
        fetchMock.mockResolvedValue(mockResponse(200, envelope(wire)));
        await expect(
            client().scheme.suggestForCategories([], ['level']),
        ).rejects.toMatchObject({ code: ErrorCodes.MALFORMED_RESPONSE });
    });
});
