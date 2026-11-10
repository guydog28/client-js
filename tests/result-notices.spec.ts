/**
 * Notices on a result that describes a marking.
 *
 * The contract collects the notices attached to the concepts a marking asserts
 * and carries them on the result itself, always present and empty when there
 * are none. A caller that has just processed, validated, aggregated or scanned
 * therefore has the notices in hand; the standalone `collectNotices` route is
 * for the case where all the caller has is a set of assertions.
 *
 * What this file holds is the pass-through. The client neither collects nor
 * drops notices, so the list a server sends is the list a caller reads, down to
 * the entries and their order. The compile-time half, that the declared return
 * type carries the member at all, is pinned in `contract.spec.ts`, which is one
 * of the few test files `npm run typecheck` actually compiles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

const BASE_URL = 'https://api.example.com';

const NOTICES = [
    {
        conceptId: 'CONCEPT-A',
        conceptName: 'Concept A',
        type: 'handling',
        text: 'Handle per the owning program agreement.',
        required: true,
    },
    {
        conceptId: 'CONCEPT-B',
        conceptName: 'Concept B',
        type: 'info',
        text: 'Review before onward release.',
        required: false,
    },
];

function markingResult(notices: unknown[]) {
    return { ...corpusResult('ctx-scheme-process.ok'), notices };
}

function envelope(result: unknown) {
    return {
        resolution: {
            contextId: 'records',
            resolvedVersion: '1.2.3',
            artifacts: [],
            sources: [],
        },
        result,
        operationLimitations: [],
    };
}

describe('notices on a marking result', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function client() {
        return new EzClassifyClient(BASE_URL, {
            contextId: 'records',
            contextVersion: '1.2.3',
            disableCache: true,
        });
    }

    it('reaches the caller from process in the order the server sent', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(markingResult(NOTICES)))),
        );

        const result = await client().scheme.process('LEVEL-HIGH');

        expect(result.notices).toEqual(NOTICES);
    });

    it('reaches the caller from aggregate', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(markingResult(NOTICES)))),
        );

        const result = await client().scheme.aggregate([
            'LEVEL-HIGH',
            'LEVEL-LOW',
        ]);

        expect(result.notices).toEqual(NOTICES);
    });

    it('reaches the caller from validate', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(markingResult(NOTICES)))),
        );

        const result = await client().scheme.validate('LEVEL-HIGH');

        expect(result.notices).toEqual(NOTICES);
    });

    it('reaches the caller on each span a scan turns up', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope({
                        results: [
                            {
                                marking: 'LEVEL-HIGH',
                                start: 0,
                                end: 10,
                                type: 'default',
                                wrapped: false,
                                role: 'whole',
                                result: markingResult(NOTICES),
                            },
                        ],
                        unread: [],
                        limits: { status: 'complete', regionsFound: 1 },
                    }),
                ),
            ),
        );

        const { results: spans } = await client().scheme.scan('a document');

        expect(spans[0].result.notices).toEqual(NOTICES);
    });

    it('is an empty list, not a missing field, when the marking carries none', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(markingResult([])))),
        );

        const result = await client().scheme.process('LEVEL-HIGH');

        expect(result.notices).toEqual([]);
    });
});
