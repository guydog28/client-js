/**
 * The guide family on a context-bound client: the plural view accessor, the
 * fan-out evaluation built on it, and the synchronous metadata accessors the
 * resolved Context feeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ctxSchemeResourceBody, mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

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

/** A guide view item the contract accepts, named by id. */
function rule(id: string) {
    return {
        dependsOn: [],
        dependsOnNames: [],
        id,
        isComputed: false,
        keywords: [],
        matcherLabels: [],
        name: id,
        outcomeText: '',
        overrideNames: [],
        overrides: [],
    };
}

const GUIDE_VIEW = {
    id: 'records-guide',
    name: 'Records Guide',
    description: '',
    categories: [],
    uncategorized: [],
};

const RECORDS_GUIDE = {
    id: 'records-guide',
    version: 'latest',
    resolvedVersion: '3.1.0',
};

/**
 * The runtime's answer for a Context with no guide attached: `resolveCtxGuide`
 * returns null and every handler in the family turns that into this 422. It is
 * not a 404, which is what those routes send for a named guide that is not in
 * the Context, or for a route the deployment does not serve at all.
 */
const NO_GUIDES_422 = mockResponse(
    422,
    JSON.stringify({ error: 'Context has no guides attached.' }),
);

/** The decomposition `GET /v1/ctx/records/1.2.3` answers with. */
function describeBody(guides: Array<Record<string, string>>) {
    return {
        id: 'records',
        version: '1.2.3',
        scheme: { id: 'levels', version: '2.0.0', resolvedVersion: '2.0.0' },
        schemes: [
            {
                selector: 'levels',
                id: 'levels',
                version: '2.0.0',
                roles: ['primary'],
            },
        ],
        ...(guides.length > 0 ? { guides } : {}),
    };
}

describe('GuideOps family', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** A client that never resolved its Context: no decomposition cached. */
    function ctxClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
            disableCache: true,
        });
    }

    /** A client holding the decomposition `connect()` would have fetched. */
    function resolvedClient(
        guides: Array<{ id: string; version: string; resolvedVersion: string }>,
    ) {
        const client = ctxClient();
        client._contextDescription = {
            id: 'records',
            version: '1.2.3',
            scheme: {
                id: 'levels',
                version: '2.0.0',
                resolvedVersion: '2.0.0',
            },
            layers: [],
            guides,
            crosswalks: [],
        };
        return client;
    }

    /** Connect for real, answering health, the decomposition, and guide views. */
    async function connectWith(
        guides: Array<Record<string, string>>,
        guideView: () => Response,
    ) {
        fetchMock.mockImplementation((url: string) => {
            if (url.endsWith('/v1/health')) {
                return Promise.resolve(
                    mockResponse(200, JSON.stringify({ status: 'ok' })),
                );
            }
            if (url.endsWith('/guide/view')) {
                return Promise.resolve(guideView());
            }
            // The connect also warms the scheme profile from the ctx surface.
            const resource = ctxSchemeResourceBody(url);
            if (resource !== undefined) {
                return Promise.resolve(
                    mockResponse(200, JSON.stringify(resource)),
                );
            }
            return Promise.resolve(
                mockResponse(200, JSON.stringify(describeBody(guides))),
            );
        });
        return EzClassifyClient.connect('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
            heartbeat: false,
            disableCache: true,
        });
    }

    it('returns the Context guide as a one-element view list', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(GUIDE_VIEW))),
        );

        const views = await ctxClient().guide.buildGuideViews();

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/guide/view',
        );
        expect(views).toEqual([GUIDE_VIEW]);
    });

    it('reports no views when the Context declares no guide', async () => {
        // The shipping runtime sends 422 for this, never 404: a client keyed on
        // 404 rejects here instead of answering empty.
        fetchMock.mockResolvedValue(NO_GUIDES_422);

        await expect(ctxClient().guide.buildGuideViews()).resolves.toEqual([]);
    });

    it('a guide-view server failure propagates', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(500, JSON.stringify({ error: 'boom' })),
        );

        await expect(ctxClient().guide.buildGuideViews()).rejects.toThrow();
    });

    it('a resource 404 propagates', async () => {
        // A Context that does not exist is a real failure, not an empty view
        // list.
        fetchMock.mockResolvedValue(
            mockResponse(
                404,
                JSON.stringify({ error: 'Context not found: records' }),
            ),
        );

        await expect(ctxClient().guide.buildGuideViews()).rejects.toThrow(
            'Context not found: records',
        );
    });

    it('rethrows a 422 whose body is not the no-guide shape, rather than answering empty', async () => {
        // Matching a 422 on status alone would swallow a genuine failure, e.g.
        // a scan request the runtime rejects for a reason unrelated to the
        // Context having no guide.
        fetchMock.mockResolvedValue(
            mockResponse(
                422,
                JSON.stringify({ error: 'Malformed guide selection' }),
            ),
        );

        await expect(ctxClient().guide.buildGuideViews()).rejects.toThrow(
            'Malformed guide selection',
        );
    });

    it('asks for no guide view at all when the resolved Context declares none', async () => {
        const views = await resolvedClient([]).guide.buildGuideViews();

        expect(views).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names every guide the resolved Context declares', async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            const { guideId } = JSON.parse(init.body as string);
            return Promise.resolve(
                mockResponse(
                    200,
                    JSON.stringify(envelope({ ...GUIDE_VIEW, id: guideId })),
                ),
            );
        });

        const views = await resolvedClient([
            RECORDS_GUIDE,
            { id: 'legal-guide', version: '1.0.0', resolvedVersion: '1.0.0' },
        ]).guide.buildGuideViews();

        expect(views.map((v) => v.id)).toEqual([
            'records-guide',
            'legal-guide',
        ]);
    });

    it('asks the server to roll up a selection that spans two guides in one evaluation', async () => {
        const combined = corpusResult('ctx-guide-evaluate.selections');
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(combined))),
        );

        // Both guides use the rule id `shared-rule`; each selection names its
        // guide, so the two go out as two rules.
        const result = await resolvedClient([
            RECORDS_GUIDE,
            { id: 'legal-guide', version: '1.0.0', resolvedVersion: '1.0.0' },
        ]).guide.evaluateMany([
            { guideId: 'records-guide', ruleId: 'shared-rule' },
            { guideId: 'legal-guide', ruleId: 'shared-rule' },
        ]);

        expect(result).toEqual(combined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/guide/evaluate',
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            selections: [
                { guideId: 'records-guide', ruleId: 'shared-rule' },
                { guideId: 'legal-guide', ruleId: 'shared-rule' },
            ],
        });
    });

    it('answers the synchronous metadata accessors empty before anything is loaded', () => {
        const c = ctxClient();

        expect(c.guide.listGuideMeta()).toEqual([]);
        expect(c.guide.listGuides()).toEqual([]);
        expect(c.guide.getGuideMeta()).toBeUndefined();
        expect(c.guide.getGuideMeta('records-guide')).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports loaded guide metadata from the composition and the guide view', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope({
                        id: 'records-guide',
                        name: 'Records Guide',
                        description: 'Retention rules',
                        categories: [
                            {
                                id: 'a',
                                label: 'A',
                                items: [rule('a1'), rule('a2')],
                            },
                            { id: 'b', label: 'B', items: [rule('b1')] },
                        ],
                        uncategorized: [rule('u1')],
                        vocabulary: { guidebook: { singular: 'SGC' } },
                    }),
                ),
            ),
        );
        const c = resolvedClient([RECORDS_GUIDE]);

        await c.guide.buildGuideViews();

        expect(c.guide.listGuideMeta()).toEqual([
            {
                id: 'records-guide',
                version: '3.1.0',
                name: 'Records Guide',
                description: 'Retention rules',
                ruleCount: 4,
                // The guide overrode only the singular; the plural falls back
                // to the generic noun the GuideMetaView contract names.
                referenceSurfaceLabel: {
                    singular: 'SGC',
                    plural: 'Guidebooks',
                },
            },
        ]);
        expect(c.guide.getGuideMeta()?.id).toBe('records-guide');
        expect(c.guide.getGuideMeta('records-guide')?.ruleCount).toBe(4);
        expect(c.guide.getGuideMeta('legal-guide')).toBeUndefined();

        // listGuides() is a metadata-only view of the same warmed cache
        // listGuideMeta() reports from, not a second copy that could go
        // stale or claim "no guides" while listGuideMeta() knows better.
        expect(c.guide.listGuides()).toEqual([
            {
                id: 'records-guide',
                name: 'Records Guide',
                version: '3.1.0',
                description: 'Retention rules',
                schemeId: 'levels',
            },
        ]);
    });

    it('keeps a successfully loaded guide in listGuideMeta and listGuides when a sibling guide fails to load', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const LEGAL_GUIDE = {
            id: 'legal-guide',
            version: 'latest',
            resolvedVersion: '1.0.0',
        };
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            const { guideId } = JSON.parse(init.body as string);
            if (guideId === 'legal-guide') {
                return Promise.resolve(
                    mockResponse(500, JSON.stringify({ error: 'boom' })),
                );
            }
            return Promise.resolve(
                mockResponse(200, JSON.stringify(envelope(GUIDE_VIEW))),
            );
        });
        const c = resolvedClient([RECORDS_GUIDE, LEGAL_GUIDE]);

        await c.guide._warmGuideMeta();

        // The failure was `legal-guide`'s; `records-guide` had already
        // resolved and stays recorded rather than being wiped by the sibling
        // failure.
        expect(c.guide.listGuideMeta().map((g) => g.id)).toEqual([
            'records-guide',
        ]);
        expect(c.guide.listGuides().map((g) => g.id)).toEqual([
            'records-guide',
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [message] = warn.mock.calls[0];
        expect(message).not.toMatch(/stays empty/);
        expect(message).toMatch(/may be missing some guides/);
        warn.mockRestore();
    });

    it('loads guide metadata on connect so a picker has it synchronously', async () => {
        const client = await connectWith([RECORDS_GUIDE], () =>
            mockResponse(200, JSON.stringify(envelope(GUIDE_VIEW))),
        );

        expect(client.guide.listGuideMeta()).toEqual([
            {
                id: 'records-guide',
                version: '3.1.0',
                name: 'Records Guide',
                ruleCount: 0,
                referenceSurfaceLabel: {
                    singular: 'Guidebook',
                    plural: 'Guidebooks',
                },
            },
        ]);
        client.destroy();
    });

    it('keeps the connection when the guide view will not load', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const client = await connectWith([RECORDS_GUIDE], () =>
            mockResponse(500, JSON.stringify({ error: 'boom' })),
        );

        // A caller that only marks text keeps its client; the metadata is
        // absent and says so rather than being invented.
        expect(client.connected).toBe(true);
        expect(client.guide.listGuideMeta()).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('could not load guide metadata'),
        );
        warn.mockRestore();
        client.destroy();
    });
});
