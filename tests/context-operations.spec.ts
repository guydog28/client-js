import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

function envelope(result: unknown, responseProjection?: unknown) {
    return {
        resolution: {
            contextId: 'records',
            requestedVersion: 'latest',
            resolvedVersion: '1.2.3',
            artifacts: [],
            sources: [],
        },
        result,
        operationLimitations: [],
        ...(responseProjection !== undefined ? { responseProjection } : {}),
    };
}

const projection = {
    profile: 'summary',
    detailsComplete: false,
    omittedFields: ['/result/guideAssessment/evaluation'],
    counts: {
        nominations: 1,
        evidenceSpans: 1,
        guideUnits: 1,
        accessRuleResults: 0,
        contentRequirements: 0,
        contextRequirements: 0,
    },
};

describe('EzClassifyClient Context operations', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function client(options?: { contextToken?: string }) {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            ...(options?.contextToken
                ? { contextToken: options.contextToken }
                : { contextVersion: '1.2.3' }),
            disableCache: true,
        });
    }

    it('preserves an audit envelope and projected omission semantics', async () => {
        const wire = envelope(
            corpusResult('ctx-document-audit.ok'),
            projection,
        );
        fetchMock.mockResolvedValue(mockResponse(200, JSON.stringify(wire)));

        const result = await client().audit({
            text: 'record',
            responseProfile: 'summary',
        });

        expect(result).toEqual(wire);
        expect(result.result.proceduralFlags).toEqual(
            wire.result.proceduralFlags,
        );
        expect(result.result.guideAssessment).not.toHaveProperty('evaluation');
        expect(result.responseProjection?.omittedFields).toEqual(
            projection.omittedFields,
        );
        expect(fetchMock.mock.calls[0]![0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/document/audit',
        );
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
            text: 'record',
            responseProfile: 'summary',
        });
    });

    it('supports marking and assertion targets for access checks', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope(corpusResult('ctx-access-check.assertions')),
                ),
            ),
        );
        const c = client();
        await c.checkContextAccess(
            'LEVEL',
            { clearance: 'LEVEL' },
            { tenant: 'a' },
        );
        await c.checkContextAccess(
            [{ categoryId: 'level', conceptId: 'LEVEL' }],
            { clearance: 'LEVEL' },
        );

        expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
            marking: 'LEVEL',
            userAttributes: { clearance: 'LEVEL' },
            context: { tenant: 'a' },
        });
        expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({
            assertions: [{ categoryId: 'level', conceptId: 'LEVEL' }],
            userAttributes: { clearance: 'LEVEL' },
        });
    });

    it('preserves marking and assertion parity for requirements', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope(
                        corpusResult('ctx-access-describe-requirements.ok'),
                    ),
                ),
            ),
        );
        const input = {
            marking: 'LEVEL',
            assertions: [{ categoryId: 'control', conceptId: 'A' }],
        };
        await client().accessRequirements(input);

        expect(fetchMock.mock.calls[0]![0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/access/describe-requirements',
        );
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual(
            input,
        );
    });

    it('applies a crosswalk the Context declares, keeping its envelope', async () => {
        const translation = corpusResult('ctx-crosswalk-translate.translated');
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(translation))),
        );
        const c = client();

        const result = await c.translate({
            crosswalkId: 'state-to-district',
            marking: 'LEVEL-HIGH',
        });

        expect(fetchMock.mock.calls[0]![0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/crosswalk/translate',
        );
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
            crosswalkId: 'state-to-district',
            marking: 'LEVEL-HIGH',
        });
        expect(result.result).toEqual(translation);
        expect(result.resolution.resolvedVersion).toBe('1.2.3');
    });

    it('sends already-parsed source assertions as the assertions field, not marking', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope(
                        corpusResult('ctx-crosswalk-translate.translated'),
                    ),
                ),
            ),
        );
        const assertions = [{ categoryId: 'level', conceptId: 'LEVEL-HIGH' }];

        // The adapter takes one `marking: string | Assertion[]` field; the wire
        // splits it into two optional fields so an array operand goes out as
        // `assertions`, never as `marking`.
        await client().context.translate({
            crosswalkId: 'state-to-district',
            marking: assertions,
        });

        expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
            crosswalkId: 'state-to-district',
            assertions,
        });
    });

    it('refuses a translation without the Context that declares the crosswalk', async () => {
        const flat = new EzClassifyClient('https://api.example.com', {
            heartbeat: false,
        });

        await expect(
            flat.translate({ crosswalkId: 'x', marking: 'LEVEL-HIGH' }),
        ).rejects.toThrow(/requires a context-bound client/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects malformed Context envelopes at the client boundary', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify({ result: { rules: [] } })),
        );
        await expect(
            client().accessRequirements({ marking: 'LEVEL' }),
        ).rejects.toThrow(/Malformed response/);
    });

    it('rejects a document envelope without projection metadata', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(corpusResult('ctx-document-audit.ok'))),
            ),
        );
        await expect(client().audit({ text: 'record' })).rejects.toThrow(
            /responseProjection is required/,
        );
    });

    it('rejects projection metadata on a non-document envelope', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope(
                        corpusResult('ctx-access-describe-requirements.ok'),
                        projection,
                    ),
                ),
            ),
        );
        await expect(
            client().accessRequirements({ marking: 'LEVEL' }),
        ).rejects.toThrow(/responseProjection is not allowed/);
    });

    it('preserves stable server code, detail, status, and body', async () => {
        const body = {
            error: 'Guide determination is stale.',
            code: 'INVALID_INPUT',
            detail: 'stale-guide-determination',
        };
        fetchMock.mockResolvedValue(mockResponse(409, JSON.stringify(body)));
        let error: EzClassifyError | undefined;
        try {
            await client().audit({ text: 'record' });
        } catch (caught) {
            error = caught as EzClassifyError;
        }
        expect(error).toBeInstanceOf(EzClassifyError);
        expect(error).toMatchObject({
            status: 409,
            code: 'INVALID_INPUT',
            detail: 'stale-guide-determination',
            body,
        });
    });

    it('unwraps context envelopes for leaf adapter operations only', async () => {
        const processResult = corpusResult('ctx-scheme-process.ok');
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(processResult))),
        );
        await expect(client().scheme.process('LEVEL')).resolves.toEqual(
            processResult,
        );
    });
});
