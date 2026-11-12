/**
 * `Fix` and `Change` decode.
 *
 * `Fix` describes one way to make a marking valid: what it keeps, what it adds,
 * what it removes, the rendered result, and a message, all required. It only
 * ever appears in a `proposedFixes` list (including `DocumentAuditReport`'s
 * `MarkingValidation.proposedFixes`), since a proposal the caller has not
 * applied has no single rule to point at.
 *
 * `Change` describes a mutation the engine actually made while processing, and
 * lives only in `appliedFixes`. Which of `add`/`remove` are set encodes the
 * action: `add` alone for 'add', `remove` alone for 'remove', both for
 * 'replace', neither for 'reorder' (a tolerant-parse reshuffle with no concept
 * added or removed).
 *
 * The client has no hand-written model, mapper, or validator for either shape;
 * both ride through untouched as `@ezclassify/types` declares them. These tests
 * pin the pass-through so a future field rename or drop shows up here rather
 * than only downstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

const LEVEL_HIGH = {
    categoryId: 'level',
    conceptId: 'LEVEL-HIGH',
    confidence: 'certain',
    source: 'parse',
};

function markingResult(appliedFixes: unknown[], proposedFixes: unknown[]) {
    return {
        assertions: [],
        rendered: 'LEVEL-HIGH',
        valid: true,
        inputWasValid: true,
        errors: [],
        warnings: [],
        appliedFixes,
        proposedFixes,
        assessment: {
            emitted: [],
            omitted: [],
            collapsed: [],
            conflicts: [],
            unrepresentable: [],
        },
        renders: {},
        notices: [],
    };
}

function envelope(result: unknown) {
    return {
        resolution: {
            contextId: 'records',
            resolvedVersion: '1.2.3',
            artifacts: [],
        },
        result,
    };
}

describe('Fix decode on a proposed fix', () => {
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

    it('decodes a fix with two keeps, one add and one remove intact', async () => {
        const fix = {
            message: 'Add the missing control and drop the superseded level.',
            rendered: 'LEVEL-HIGH//CONTROL-A',
            keeps: [
                { conceptId: 'LEVEL-HIGH', categoryId: 'level' },
                { conceptId: 'HANDLING-X', categoryId: 'handling' },
            ],
            adds: [{ conceptId: 'CONTROL-A', categoryId: 'control' }],
            removes: [{ conceptId: 'LEVEL-LOW', categoryId: 'level' }],
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(markingResult([], [fix]))),
            ),
        );

        const result = await client().scheme.process('LEVEL-HIGH');

        expect(result.proposedFixes).toEqual([fix]);
    });
});

describe('Change decode on an applied fix', () => {
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

    it('decodes an add change with only add set', async () => {
        const change = {
            ruleId: 'RULE-INFER-CONTROL',
            action: 'add',
            add: [{ conceptId: 'CONTROL-A', categoryId: 'control' }],
            message: 'Inferred the required control.',
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(markingResult([change], []))),
            ),
        );

        const result = await client().scheme.process('LEVEL-HIGH');

        expect(result.appliedFixes).toEqual([change]);
    });

    it('decodes a remove change with only remove set', async () => {
        const change = {
            ruleId: 'RULE-DROP-SUPERSEDED',
            action: 'remove',
            remove: [{ conceptId: 'LEVEL-LOW', categoryId: 'level' }],
            message: 'Removed the superseded level.',
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(markingResult([change], []))),
            ),
        );

        const result = await client().scheme.process('LEVEL-HIGH');

        expect(result.appliedFixes).toEqual([change]);
    });

    it('decodes a replace change with both add and remove set', async () => {
        const change = {
            ruleId: 'RULE-SUPERSEDE-LEVEL',
            action: 'replace',
            add: [{ conceptId: 'LEVEL-HIGH', categoryId: 'level' }],
            remove: [{ conceptId: 'LEVEL-LOW', categoryId: 'level' }],
            message: 'Replaced the superseded level.',
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(markingResult([change], []))),
            ),
        );

        const result = await client().scheme.process('LEVEL-LOW');

        expect(result.appliedFixes).toEqual([change]);
    });

    it('decodes a reorder change with neither add nor remove set', async () => {
        const change = {
            ruleId: 'RULE-CANONICAL-ORDER',
            action: 'reorder',
            message: 'Reordered tokens into canonical form.',
        };
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(markingResult([change], []))),
            ),
        );

        const result = await client().scheme.process('handling-x level-high');

        expect(result.appliedFixes).toEqual([change]);
        expect(result.appliedFixes[0]).not.toHaveProperty('add');
        expect(result.appliedFixes[0]).not.toHaveProperty('remove');
    });
});

describe('MarkingValidation on a document audit', () => {
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

    function auditEnvelope(wholeValidation: unknown) {
        return {
            resolution: {
                contextId: 'records',
                resolvedVersion: '1.2.3',
                artifacts: [],
            },
            result: {
                markingRequirements: { whole: true, part: false },
                whole: 'LEVEL-HIGH',
                wholes: [],
                wholeValidation,
                parts: [],
                wholeCoversParts: null,
                unmarkedSpans: [],
                proceduralFlags: [],
                overallVerdict: 'pass',
                vocabulary: null,
                documentDigest: 'sha256-deadbeef',
                guideAssessment: null,
                limitations: [],
            },
            responseProjection: {
                profile: 'standard',
                detailsComplete: true,
                omittedFields: [],
                counts: {
                    nominations: 0,
                    evidenceSpans: 0,
                    guideUnits: 0,
                },
            },
        };
    }

    it('decodes the reorder change the engine made reading the whole', async () => {
        const change = {
            ruleId: 'RULE-CANONICAL-ORDER',
            action: 'reorder',
            message: 'Reordered tokens into canonical form.',
        };
        const wholeValidation = {
            assertions: [LEVEL_HIGH],
            recognition: { status: 'complete', unmatched: [] },
            valid: true,
            inputWasValid: false,
            errors: [],
            proposedFixes: [],
            appliedFixes: [change],
            rendered: 'LEVEL-HIGH',
        };
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(auditEnvelope(wholeValidation))),
        );

        const result = await client().audit({ text: 'handling-x level-high' });

        expect(result.result.wholeValidation?.appliedFixes).toEqual([change]);
    });

    it('carries the facts and how recognition read the marking', async () => {
        // A caller that rolls markings up or checks access works from these
        // instead of reading each marking a second time, so they have to
        // reach it exactly as the server sent them.
        const wholeValidation = {
            assertions: [LEVEL_HIGH],
            recognition: {
                status: 'partial',
                unmatched: [{ start: 11, end: 15, text: 'NOPE' }],
            },
            valid: false,
            inputWasValid: false,
            errors: [],
            proposedFixes: [],
            appliedFixes: [],
            rendered: 'LEVEL-HIGH',
        };
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(auditEnvelope(wholeValidation))),
        );

        const result = await client().audit({ text: 'LEVEL-HIGH NOPE' });

        expect(result.result.wholeValidation?.assertions).toEqual([LEVEL_HIGH]);
        expect(result.result.wholeValidation?.recognition).toEqual(
            wholeValidation.recognition,
        );
        expect(result.result.wholeValidation?.inputWasValid).toBe(false);
    });
});
