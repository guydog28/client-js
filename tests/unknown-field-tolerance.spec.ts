/**
 * Unknown-field tolerance on read.
 *
 * The REST contract is open on the way back: every schema reachable from a
 * response allows fields this build has never heard of, because a runtime newer
 * than the client is expected to send some. A field is only ever added as
 * optional, and removing or re-meaning one is a major version. What that buys
 * is only real if the client goes along with it, so this file is this SDK's
 * conformance case for the read half: a response carrying fields that are not
 * in `vendor/spec/openapi.yaml` is accepted, the fields the client does know
 * still read correctly, and nothing the client hands back is narrowed on the
 * way through.
 *
 * The write half is the opposite and is not tested here: requests are closed
 * and the server rejects an unknown field in a body it is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ctxSchemeResourceBody, mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

const BASE_URL = 'https://api.example.com';

/** A field name no version of the contract has ever carried. */
const FUTURE = 'fieldFromALaterRuntime';

function envelope(result: unknown, extra?: Record<string, unknown>) {
    return {
        resolution: {
            contextId: 'records',
            requestedVersion: 'latest',
            resolvedVersion: '1.2.3',
            artifacts: [],
            [FUTURE]: 'on the resolution',
        },
        result,
        [FUTURE]: 'on the envelope',
        ...extra,
    };
}

describe('unknown fields on a response', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function ctxClient() {
        return new EzClassifyClient(BASE_URL, {
            contextId: 'records',
            contextVersion: '1.2.3',
            disableCache: true,
        });
    }

    it('are carried through a raw response untouched', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({ known: 'value', [FUTURE]: { nested: 1 } }),
            ),
        );

        await expect(
            ctxClient()._request('GET', '/v1/ctx/records/1.2.3'),
        ).resolves.toEqual({
            known: 'value',
            [FUTURE]: { nested: 1 },
        });
    });

    it('do not make a Context envelope invalid', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope({
                        ...corpusResult('ctx-scheme-process.ok'),
                        marking: 'LEVEL-HIGH',
                        [FUTURE]: 'on the result',
                    }),
                ),
            ),
        );

        const result = await ctxClient().scheme.process('LEVEL-HIGH');

        expect(result).toMatchObject({ marking: 'LEVEL-HIGH' });
        // The envelope hands the projected result back as the server sent it,
        // so a field added after this build still reaches the caller.
        expect((result as Record<string, unknown>)[FUTURE]).toBe(
            'on the result',
        );
    });

    it('do not make a response projection invalid', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope(
                        {
                            ...corpusResult('ctx-document-audit.ok'),
                            [FUTURE]: 'on the result',
                        },
                        {
                            responseProjection: {
                                profile: 'summary',
                                detailsComplete: false,
                                omittedFields: [],
                                counts: {
                                    nominations: 0,
                                    evidenceSpans: 0,
                                    guideUnits: 0,
                                    [FUTURE]: 3,
                                },
                                [FUTURE]: 'on the projection',
                            },
                        },
                    ),
                ),
            ),
        );

        const audited = await ctxClient().context.audit({
            text: 'a document',
        } as never);

        expect(audited.responseProjection).toMatchObject({
            profile: 'summary',
            detailsComplete: false,
        });
    });

    it('do not stop a Context description from being read', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({
                    id: 'records',
                    version: '1.2.3',
                    scheme: {
                        id: 'levels',
                        version: 'latest',
                        resolvedVersion: '2.0.0',
                        [FUTURE]: 'on the component ref',
                    },
                    guides: [],
                    schemes: [],
                    [FUTURE]: 'on the description',
                }),
            ),
        );

        const description = await ctxClient().describeContext();

        expect(description.id).toBe('records');
        expect(description.scheme.id).toBe('levels');
    });

    it('do not stop a scheme profile from being assembled', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            const body = ctxSchemeResourceBody(url);
            if (body === undefined) {
                return mockResponse(
                    200,
                    JSON.stringify({
                        id: 'records',
                        version: '1.2.3',
                        scheme: {
                            id: 'levels',
                            version: 'latest',
                            resolvedVersion: '2.0.0',
                        },
                        guides: [],
                        schemes: [],
                    }),
                );
            }
            // Every sub-resource answers with a field this build predates.
            const decorated =
                body !== null &&
                !Array.isArray(body) &&
                typeof body === 'object'
                    ? { ...(body as Record<string, unknown>), [FUTURE]: true }
                    : body;
            return mockResponse(200, JSON.stringify(decorated));
        });

        const client = ctxClient();
        const profile = await client.scheme.fetchProfile();

        expect(profile.id).toBe('levels');
        expect(profile.version).toBe('1.0.0');
    });

    it('do not stop an error body from being classified', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                409,
                JSON.stringify({
                    code: 'SCHEME_CONFLICT',
                    error: 'clash',
                    [FUTURE]: 'on the error',
                }),
            ),
        );

        await expect(
            ctxClient()._request('GET', '/v1/ctx/records/1.2.3'),
        ).rejects.toMatchObject({ code: 'SCHEME_CONFLICT', status: 409 });
    });
});
