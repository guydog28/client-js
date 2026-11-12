/**
 * `ValidationError` decode, held against a recorded engine answer.
 *
 * An error about a token the engine could not read may carry `didYouMean`: the
 * ids of the concepts the token was likely meant as. It is for a program to act
 * on, so the client has no business reshaping it. Like every other result
 * member it rides through as `@ezclassify/types` declares it, and this file
 * pins that with the one recorded answer that carries the member, rather than
 * with a payload written here to agree with the client.
 *
 * The recording is the conformance answer the runtime gave for validate on a
 * misspelled level. It is read from the vendored spec bundle, so a re-record
 * that drops or reshapes the member fails here instead of passing on a stale
 * copy.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

const RECORDINGS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../vendor/spec/recordings/v1/from-layers.recordings.json',
);

/** The marking the recording was made with: a misspelled level. */
const MISSPELLED = 'CRITCAL';

interface Recording {
    method: string;
    argsSummary: string;
    response: { errors: Array<Record<string, unknown>> };
}

/**
 * The recorded validate answer for {@link MISSPELLED}.
 *
 * @returns The recorded result, exactly as the runtime answered it
 * @throws {Error} When the bundle does not hold exactly one such recording
 */
function recordedAnswer(): Recording['response'] {
    const { responses } = JSON.parse(readFileSync(RECORDINGS, 'utf8')) as {
        responses: Record<string, Recording>;
    };
    const matches = Object.values(responses).filter(
        (entry) =>
            entry.method === 'validate' &&
            entry.argsSummary === JSON.stringify([MISSPELLED]),
    );
    if (matches.length !== 1) {
        throw new Error(
            `expected one recorded validate of ${MISSPELLED}, found ${matches.length}`,
        );
    }
    return matches[0].response;
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

describe('ValidationError decode', () => {
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

    it('hands back didYouMean on an unread token as the server sent it', async () => {
        const recorded = recordedAnswer();
        const hinted = recorded.errors.filter(
            (error) => error['didYouMean'] !== undefined,
        );
        // Without this the comparisons below would also pass on a recording
        // that no longer carries the member at all.
        expect(hinted).toHaveLength(1);
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(recorded))),
        );

        const result = await client().scheme.validate(MISSPELLED);

        expect(result).toEqual(recorded);
        expect(
            result.errors.find(
                (error) => error.constraintId === hinted[0]['constraintId'],
            )?.didYouMean,
        ).toEqual(hinted[0]['didYouMean']);
    });
});
