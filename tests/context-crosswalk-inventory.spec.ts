/**
 * The crosswalk inventory a context-bound client reads from `GET
 * crosswalk/describe`: every crosswalk the Context holds, named by the scheme
 * selectors `describeSchemes()` reports, with the mappings and selections a
 * translation applies. The read is in the cached set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextCrosswalkDescriptor } from '@ezclassify/types';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ErrorCodes, EzClassifyError } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';

const LEVELS_TO_HANDLING: ContextCrosswalkDescriptor = {
    id: 'levels-to-handling',
    version: '1.0.0',
    name: 'Levels to handling',
    source: 'levels@2.0.0',
    target: 'handling@1.0.0',
    guidance: 'Review every proposed handling caveat before release.',
    mappings: [
        {
            id: 'open-carries',
            source: { categoryId: 'level', conceptId: 'OPEN' },
            targets: [{ categoryId: 'handling', conceptId: 'PUBLIC' }],
            disposition: 'carry',
            reason: 'OPEN material is public in the handling scheme.',
        },
        {
            id: 'restricted-forbids',
            source: { categoryId: 'level', conceptId: 'RESTRICTED' },
            disposition: 'forbid',
            reason: 'RESTRICTED material has no handling equivalent.',
        },
    ],
    selections: [
        {
            id: 'release-scope',
            strategy: 'first-match',
            candidates: [
                {
                    id: 'internal',
                    when: {
                        any: [{ categoryId: 'audience', conceptId: 'STAFF' }],
                    },
                    targets: [
                        { categoryId: 'handling', conceptId: 'INTERNAL' },
                    ],
                    disposition: 'carry',
                    reason: 'Staff-only audiences map to internal handling.',
                },
                {
                    id: 'fallback',
                    disposition: 'review',
                    reason: 'Anything else needs a reviewer.',
                },
            ],
        },
    ],
};

const DESCRIBE_URL =
    'https://api.example.com/v1/ctx/records/1.2.3/crosswalk/describe';

describe('describeCrosswalks', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function ctxClient(options?: { disableCache?: boolean }) {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
            disableCache: options?.disableCache ?? false,
        });
    }

    function answer(body: unknown) {
        fetchMock.mockResolvedValue(mockResponse(200, JSON.stringify(body)));
    }

    it('reads every crosswalk the Context holds off GET crosswalk/describe', async () => {
        answer({ crosswalks: [LEVELS_TO_HANDLING] });

        const crosswalks = await ctxClient().describeCrosswalks();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(DESCRIBE_URL);
        expect(fetchMock.mock.calls[0][1].method).toBe('GET');
        expect(crosswalks).toEqual([LEVELS_TO_HANDLING]);
    });

    it('answers an empty list for a Context that declares no crosswalk', async () => {
        answer({ crosswalks: [] });

        await expect(ctxClient().describeCrosswalks()).resolves.toEqual([]);
    });

    it('answers a repeat from the cache, through either entry point', async () => {
        answer({ crosswalks: [LEVELS_TO_HANDLING] });
        const client = ctxClient();

        await client.describeCrosswalks();
        const again = await client.context.describeCrosswalks();

        expect(again).toEqual([LEVELS_TO_HANDLING]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('asks the server every time when the cache is off', async () => {
        answer({ crosswalks: [LEVELS_TO_HANDLING] });
        const client = ctxClient({ disableCache: true });

        await client.describeCrosswalks();
        await client.describeCrosswalks();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['the crosswalk list', {}],
        [
            'the source selector of a crosswalk',
            {
                crosswalks: [{ ...LEVELS_TO_HANDLING, source: undefined }],
            },
        ],
        [
            'the disposition of a selection candidate',
            {
                crosswalks: [
                    {
                        ...LEVELS_TO_HANDLING,
                        selections: [
                            {
                                ...LEVELS_TO_HANDLING.selections[0],
                                candidates: [
                                    {
                                        id: 'fallback',
                                        reason: 'Anything else needs a reviewer.',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    ])(
        'refuses a response missing %s and does not file it',
        async (_member, body) => {
            answer(body);
            const client = ctxClient();

            const failure = await client.describeCrosswalks().catch((e) => e);
            expect(failure).toBeInstanceOf(EzClassifyError);
            expect((failure as EzClassifyError).code).toBe(
                ErrorCodes.MALFORMED_RESPONSE,
            );

            answer({ crosswalks: [LEVELS_TO_HANDLING] });
            await expect(client.describeCrosswalks()).resolves.toEqual([
                LEVELS_TO_HANDLING,
            ]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    it('refuses a client that is not bound to a Context', async () => {
        const unbound = new EzClassifyClient('https://api.example.com');

        await expect(unbound.describeCrosswalks()).rejects.toMatchObject({
            code: ErrorCodes.INVALID_INPUT,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
