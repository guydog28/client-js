import { describe, expect, it } from 'vitest';
import { parseContextOperationResult } from '../src/context-envelope';
import { ErrorCodes, EzClassifyError } from '../src/errors';

const envelope = () => ({
    resolution: {
        contextId: 'ctx',
        resolvedVersion: '1.0.0',
        artifacts: [],
    },
    result: { valid: true },
});
const projection = () => ({
    profile: 'standard',
    detailsComplete: true,
    omittedFields: [],
    counts: {
        nominations: 0,
        evidenceSpans: 0,
        guideUnits: 0,
    },
});

function expectInvalid(
    value: unknown,
    mode: 'required' | 'forbidden' = 'forbidden',
) {
    expect(() => parseContextOperationResult(value, mode)).toThrow(
        EzClassifyError,
    );
    try {
        parseContextOperationResult(value, mode);
    } catch (error) {
        expect((error as EzClassifyError).code).toBe(
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
}

describe('Context envelope validation', () => {
    it('preserves the server envelope and unknown fields without copying', () => {
        const value = { ...envelope(), future: { detail: true } };
        expect(parseContextOperationResult(value, 'forbidden')).toBe(value);
    });

    it.each([null, [], 'response', 12])(
        'rejects non-record envelopes: %j',
        (value) => {
            expectInvalid(value);
        },
    );

    it.each([
        { resolution: null },
        { resolution: { contextId: 'ctx' } },
        { result: null },
        { result: undefined },
        { result: {} },
        { responseProjection: projection() },
    ])('rejects malformed required fields: %j', (patch) => {
        expectInvalid({ ...envelope(), ...patch });
    });

    it('permits an empty result only for a route declaring an empty map', () => {
        const value = { ...envelope(), result: {} };
        expect(
            parseContextOperationResult(value, 'forbidden', {
                emptyResult: 'allowed',
            }),
        ).toBe(value);
    });

    it('accepts a valid required projection and rejects a missing one', () => {
        const value = { ...envelope(), responseProjection: projection() };
        expect(parseContextOperationResult(value, 'required')).toBe(value);
        expectInvalid(envelope(), 'required');
    });

    it.each([
        null,
        [],
        { ...projection(), profile: 'unknown' },
        { ...projection(), detailsComplete: 'true' },
        { ...projection(), omittedFields: [42] },
        {
            ...projection(),
            counts: { ...projection().counts, nominations: -1 },
        },
        {
            ...projection(),
            counts: { ...projection().counts, evidenceSpans: 0.5 },
        },
        { ...projection(), counts: {} },
    ])('rejects malformed projection metadata: %j', (responseProjection) => {
        expectInvalid({ ...envelope(), responseProjection }, 'required');
    });
});
