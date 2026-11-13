/**
 * Tests for connectContext() and named/versioned context behavior, including
 * 404 context-not-found distinguishability.
 *
 * A missing Context surfaces as `EzClassifyError` with `status` 404: callers
 * check `err instanceof EzClassifyError && err.status === 404`. There is no
 * dedicated subclass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { connectContext } from '../src/connect';
import { CLIENT_SPEC_VERSION } from '../src/spec-version';
import { ctxSchemeResourceBody, mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

/**
 * What `GET /v1/ctx/acme-prod/1.0.0` answers. A context-bound connect asks for
 * it after the health probe: the composition is what the guide and access
 * surfaces read to answer synchronously.
 */
const CTX_DESCRIBE = {
    id: 'acme-prod',
    version: '1.0.0',
    scheme: { id: 'levels', version: '1.0.0', resolvedVersion: '1.0.0' },
    schemes: [
        {
            selector: 'levels',
            id: 'levels',
            version: '1.0.0',
            roles: ['primary'],
        },
    ],
};

/** Answer every request a context-bound connect makes, by path. */
function mockConnectOk(fetchMock: ReturnType<typeof vi.fn>): void {
    fetchMock.mockImplementation((url: string) =>
        Promise.resolve(mockResponse(200, JSON.stringify(connectBody(url)))),
    );
}

/**
 * What a healthy server answers each leg of a context-bound connect with: the
 * health probe, the Context description, then the six scheme sub-resources the
 * profile is assembled from.
 */
function connectBody(url: string): unknown {
    const resource = ctxSchemeResourceBody(url);
    if (resource !== undefined) return resource;
    if (url.includes('/v1/ctx/')) return CTX_DESCRIBE;
    return { status: 'ok' };
}

describe('connectContext: named/versioned context connections', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
        vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    // -----------------------------------------------------------------------
    // Happy-path connections
    // -----------------------------------------------------------------------
    describe('happy-path connect', () => {
        it('connects with contextId + contextVersion and returns EzClassifyClient', async () => {
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            expect(client).toBeInstanceOf(EzClassifyClient);
            expect(client.connected).toBe(true);
            client.destroy();
        });

        it.each([
            [
                'with a contextToken',
                { contextToken: 'signed-context-envelope' },
            ],
            ['without a contextToken', {}],
        ])(
            'connects with no contextVersion %s and lets the server choose',
            async (_label, token) => {
                mockConnectOk(fetchMock);
                const client = await connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: 'acme-prod',
                    ...token,
                });
                const urls = fetchMock.mock.calls.map((call) =>
                    String(call[0]),
                );
                // The description asks for `latest`, which the runtime answers
                // with the token's default or the newest published version;
                // the profile legs then go to the concrete version it named.
                expect(urls).toContain(
                    'https://api.example.com/v1/ctx/acme-prod/latest',
                );
                expect(
                    urls.some((url) =>
                        url.includes('/v1/ctx/acme-prod/1.0.0/'),
                    ),
                ).toBe(true);
                expect(client.connected).toBe(true);
                client.destroy();
            },
        );

        it('reaches the token supplier through the entry point', async () => {
            // The whole point of a supplier is a credential the client can
            // re-resolve, from the entry point nearly every consumer uses.
            mockConnectOk(fetchMock);
            const token = vi.fn().mockReturnValue('fresh-token');

            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
                auth: { token },
            });

            const [, init] = fetchMock.mock.calls[0];
            const headers = init.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer fresh-token');
            expect(token).toHaveBeenCalledWith({ forceRefresh: false });
            client.destroy();
        });

        it('sends the application id on the Context requests it makes', async () => {
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
                applicationId: 'case-intake-portal',
            });
            const sent = fetchMock.mock.calls.map(
                ([url, init]: [string, RequestInit]) => [
                    url,
                    (init.headers as Record<string, string>)[
                        'x-ezclassify-application-id'
                    ],
                ],
            );
            // The health probe is not a Context request.
            expect(sent[0]).toEqual([
                'https://api.example.com/v1/health',
                undefined,
            ]);
            for (const [, id] of sent.slice(1)) {
                expect(id).toBe('case-intake-portal');
            }
            client.destroy();
        });

        it('never answers an access check from memory', async () => {
            // The round trip is the audit record, so a pinned client with the
            // cache on still sends every check.
            fetchMock.mockImplementation((url: string) =>
                Promise.resolve(
                    mockResponse(
                        200,
                        JSON.stringify(
                            url.endsWith('/access/check')
                                ? {
                                      resolution: {
                                          contextId: 'acme-prod',
                                          resolvedVersion: '1.0.0',
                                          artifacts: [],
                                      },
                                      result: corpusResult(
                                          'ctx-access-check.assertions',
                                      ),
                                  }
                                : connectBody(url),
                        ),
                    ),
                ),
            );
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await client.access.check([], { clearance: 'HIGH' });
            await client.access.check([], { clearance: 'HIGH' });
            expect(
                fetchMock.mock.calls.filter((call: [string, RequestInit]) =>
                    call[0].endsWith('/access/check'),
                ),
            ).toHaveLength(2);
            client.destroy();
        });

        describe('a Context held under another id', () => {
            // A held draft reports the Context its documents name, but the
            // server serves it only under the id it holds it under, at that
            // id's own versions. This server answers nothing else.
            const HELD = `sbx-${'0'.repeat(64)}`;
            const DRAFT_DESCRIBE = {
                ...CTX_DESCRIBE,
                id: 'case-records',
                version: '2.1.0',
            };

            function serveHeldAt(version: string): void {
                const held = `https://api.example.com/v1/ctx/${HELD}/${version}`;
                fetchMock.mockImplementation((url: string) => {
                    if (url === 'https://api.example.com/v1/health')
                        return Promise.resolve(
                            mockResponse(200, JSON.stringify({ status: 'ok' })),
                        );
                    if (url === held)
                        return Promise.resolve(
                            mockResponse(200, JSON.stringify(DRAFT_DESCRIBE)),
                        );
                    if (url.startsWith(`${held}/scheme`))
                        return Promise.resolve(
                            mockResponse(
                                200,
                                JSON.stringify(ctxSchemeResourceBody(url)),
                            ),
                        );
                    return Promise.resolve(
                        mockResponse(
                            404,
                            JSON.stringify({
                                error: { code: 'NOT_FOUND', message: url },
                            }),
                        ),
                    );
                });
            }

            function profileUrls(): string[] {
                return fetchMock.mock.calls
                    .map((call) => String(call[0]))
                    .filter((url) => url.includes('/scheme'));
            }

            it('reads the profile under the held id at latest when the binding names no version', async () => {
                serveHeldAt('latest');
                const client = await connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: HELD,
                });
                try {
                    expect(client.connected).toBe(true);
                    expect(client.scheme.getScheme().id).toBe('levels');
                    const urls = profileUrls();
                    expect(urls).toHaveLength(6);
                    for (const url of urls) {
                        expect(url).toContain(`/v1/ctx/${HELD}/latest/scheme`);
                    }
                } finally {
                    client.destroy();
                }
            });

            it('reads the profile under the held id at the version the binding pins', async () => {
                serveHeldAt('0.0.0');
                const client = await connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: HELD,
                    contextVersion: '0.0.0',
                });
                try {
                    const urls = profileUrls();
                    expect(urls).toHaveLength(6);
                    for (const url of urls) {
                        expect(url).toContain(`/v1/ctx/${HELD}/0.0.0/scheme`);
                    }
                } finally {
                    client.destroy();
                }
            });
        });

        it('passes custom headers through', async () => {
            mockConnectOk(fetchMock);
            await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
                headers: { 'X-Tenant-Id': 'tenant-42' },
            });
            const [, init] = fetchMock.mock.calls[0];
            const headers = init.headers as Record<string, string>;
            expect(headers['X-Tenant-Id']).toBe('tenant-42');
        });

        it('reads the caller header map once, at construction', async () => {
            mockConnectOk(fetchMock);
            const headers: Record<string, string> = {
                'X-Tenant-Id': 'tenant-42',
            };
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
                headers,
            });
            headers['Authorization'] = 'Bearer added-later';
            await client.ping();
            const [, init] = fetchMock.mock.calls.at(-1);
            const sent = init.headers as Record<string, string>;
            expect(sent['X-Tenant-Id']).toBe('tenant-42');
            expect(sent['Authorization']).toBeUndefined();
            client.destroy();
        });

        it('refuses a timeout that would abort every request before it left', () => {
            expect(
                () =>
                    new EzClassifyClient('https://api.example.com', {
                        timeout: 0,
                    }),
            ).toThrow(EzClassifyError);
            expect(
                () =>
                    new EzClassifyClient('https://api.example.com', {
                        timeout: -5,
                    }),
            ).toThrow(EzClassifyError);
        });

        it('warms its profile from the ctx surface of the bound Context', async () => {
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            // Health, the Context decomposition, then the six sub-resources
            // the profile is assembled from.
            const urls = fetchMock.mock.calls.map(([url]: [string]) => url);
            expect(urls.slice(0, 2)).toEqual([
                'https://api.example.com/v1/health',
                'https://api.example.com/v1/ctx/acme-prod/1.0.0',
            ]);
            expect(urls.slice(2).sort()).toEqual(
                [
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme',
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme/categories',
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme/concepts',
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme/formats',
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme/label-presets',
                    'https://api.example.com/v1/ctx/acme-prod/1.0.0/scheme/scopes',
                ].sort(),
            );
            client.destroy();
        });

        it("carries a surfaces scheme's outputs, their roles and the role defaults as the server resolved them", async () => {
            // The outputs are surface/view addresses. Each view states the
            // role of the markings it is a view of, and which view a role is
            // written in by default is the server's answer, carried on the
            // summary and on each view as `defaultFor`. `contextFormats` lists
            // the forms each role is read in, which the server works out from
            // the views that state that role; this client carries it as sent.
            const layout = {
                surface: 'record',
                mode: 'inline',
                view: 'short',
                categoryOrder: ['level'],
                separator: ' ',
                syntax: { type: 'text' },
            };
            fetchMock.mockImplementation((url: string) => {
                let body = connectBody(url);
                if (url.endsWith('/scheme')) {
                    body = {
                        ...(body as Record<string, unknown>),
                        defaultRenderFormat: 'record/wide',
                        defaultPartRenderFormat: 'record/compact',
                        defaultWholeRenderFormat: 'record/wide',
                        contextFormats: {
                            part: ['compact_line'],
                            whole: ['wide_line', 'wide_line_2019'],
                        },
                    };
                }
                if (url.endsWith('/scheme/formats')) {
                    body = [
                        {
                            ...layout,
                            id: 'record/compact',
                            outputView: 'compact',
                            defaultFor: ['part'],
                            role: 'part',
                        },
                        {
                            ...layout,
                            id: 'record/wide',
                            outputView: 'wide',
                            defaultFor: ['whole'],
                            role: 'whole',
                        },
                        {
                            ...layout,
                            id: 'record/xml',
                            outputView: 'xml',
                            defaultFor: [],
                        },
                    ];
                }
                return Promise.resolve(mockResponse(200, JSON.stringify(body)));
            });
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });

            const meta = client.scheme.getSchemeMeta();
            expect(meta.defaultRenderFormat).toBe('record/wide');
            expect(meta.defaultPartRenderFormat).toBe('record/compact');
            expect(meta.defaultWholeRenderFormat).toBe('record/wide');
            const views = [
                {
                    id: 'record/compact',
                    outputView: 'compact',
                    defaultFor: ['part'],
                    role: 'part',
                },
                {
                    id: 'record/wide',
                    outputView: 'wide',
                    defaultFor: ['whole'],
                    role: 'whole',
                },
                { id: 'record/xml', outputView: 'xml', defaultFor: [] },
            ];
            expect(
                meta.formats?.map(({ id, outputView, defaultFor, role }) => ({
                    id,
                    outputView,
                    defaultFor,
                    role,
                })),
            ).toEqual(views);
            expect(
                client.scheme
                    .getScheme()
                    .formats.map(({ id, outputView, defaultFor, role }) => ({
                        id,
                        outputView,
                        defaultFor,
                        role,
                    })),
            ).toEqual(views);
            // A view that states no role reports none rather than a guess.
            expect(meta.formats?.[2]).not.toHaveProperty('role');
            expect(client.scheme.getScheme().formats[2]).not.toHaveProperty(
                'role',
            );
            expect(client.scheme.getScheme().contextFormats).toEqual({
                part: ['compact_line'],
                whole: ['wide_line', 'wide_line_2019'],
            });

            // A caller that edits what it was handed edits its own copy.
            meta.formats?.[0]?.defaultFor?.push('whole');
            expect(
                client.scheme.getSchemeMeta().formats?.[0]?.defaultFor,
            ).toEqual(['part']);
            client.destroy();
        });

        it('resolves role defaults from contextFormats for a scheme whose formats are its outputs', async () => {
            fetchMock.mockImplementation((url: string) => {
                let body = connectBody(url);
                if (url.endsWith('/scheme')) {
                    body = {
                        ...(body as Record<string, unknown>),
                        defaultRenderFormat: 'long',
                        contextFormats: { part: ['short'], whole: ['long'] },
                    };
                }
                if (url.endsWith('/scheme/formats')) {
                    body = [
                        {
                            id: 'short',
                            surface: 'record',
                            mode: 'inline',
                            categoryOrder: ['level'],
                            separator: ' ',
                            syntax: { type: 'text' },
                        },
                    ];
                }
                return Promise.resolve(mockResponse(200, JSON.stringify(body)));
            });
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });

            const meta = client.scheme.getSchemeMeta();
            expect(meta.defaultPartRenderFormat).toBe('short');
            expect(meta.defaultWholeRenderFormat).toBe('long');
            // Nothing is invented for a scheme without surfaces: no view
            // name, no `defaultFor`, which would claim a role default, and no
            // `role`, which only a view states.
            expect(meta.formats?.[0]).not.toHaveProperty('defaultFor');
            expect(meta.formats?.[0]).not.toHaveProperty('outputView');
            expect(meta.formats?.[0]).not.toHaveProperty('role');
            expect(client.scheme.getScheme().formats[0]).not.toHaveProperty(
                'defaultFor',
            );
            expect(client.scheme.getScheme().formats[0]).not.toHaveProperty(
                'outputView',
            );
            expect(client.scheme.getScheme().formats[0]).not.toHaveProperty(
                'role',
            );
            client.destroy();
        });

        it('renders in the first declared format when the scheme names no default', async () => {
            // The contract omits `defaultRenderFormat` for a scheme that names
            // no default and states the first declared format as the rule.
            fetchMock.mockImplementation((url: string) => {
                let body = connectBody(url);
                if (url.endsWith('/scheme')) {
                    const { defaultRenderFormat: _omitted, ...summary } =
                        body as Record<string, unknown>;
                    body = summary;
                }
                if (url.endsWith('/scheme/formats')) {
                    body = ['short', 'long'].map((id) => ({
                        id,
                        surface: 'record',
                        mode: 'inline',
                        categoryOrder: ['level'],
                        separator: ' ',
                        syntax: { type: 'text' },
                    }));
                }
                return Promise.resolve(mockResponse(200, JSON.stringify(body)));
            });
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });

            expect(client.scheme.getScheme().defaultRenderFormat).toBe('short');
            client.destroy();
        });

        it('answers the synchronous scheme surface once connected', async () => {
            // The whole point of the warm: EzClassifyUI's constructor asks
            // these before it renders anything.
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            expect(client.scheme.getSchemeMeta().id).toBe('levels');
            expect(client.scheme.getSchemeMeta().defaultRenderFormat).toBe(
                'default',
            );
            expect(client.scheme.getSchemeMeta().formats).toEqual([
                {
                    id: 'default',
                    surface: 'marking',
                    mode: 'inline',
                    view: 'default',
                    categoryOrder: [],
                    separator: ' ',
                },
            ]);
            expect(client.scheme.getScheme().formats).toEqual([
                {
                    id: 'default',
                    surface: 'marking',
                    mode: 'inline',
                    view: 'default',
                    categoryOrder: [],
                    separator: ' ',
                    syntax: { type: 'text' },
                },
            ]);
            expect(client.scheme.getScheme().id).toBe('levels');
            expect(client.scheme.listCategories()).toEqual([]);
            client.destroy();
        });

        it('keeps citation, notices, and value encoding in remote concept views', async () => {
            const notice = {
                type: 'handling',
                required: true,
                text: 'Handle with care.',
            };
            fetchMock.mockImplementation((url: string) =>
                Promise.resolve(
                    mockResponse(
                        200,
                        JSON.stringify(
                            url.endsWith('/scheme/concepts')
                                ? [
                                      {
                                          id: 'dated',
                                          name: 'Dated',
                                          views: { default: 'Dated' },
                                          categories: ['date'],
                                          parents: [],
                                          position: 0,
                                          aliases: [],
                                          citation: 'Source section 3',
                                          notices: [notice],
                                          textInput: {
                                              label: 'Date',
                                              encoding: {
                                                  type: 'text',
                                                  maxLength: 8,
                                              },
                                          },
                                      },
                                  ]
                                : connectBody(url),
                        ),
                    ),
                ),
            );
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            expect(client.scheme.getConceptsInCategory('date')).toMatchObject([
                {
                    citation: 'Source section 3',
                    notices: [notice],
                    textInput: {
                        encoding: { type: 'text', maxLength: 8 },
                    },
                },
            ]);
            client.destroy();
        });

        it('rejects the connect when a profile leg fails', async () => {
            // Opposite posture from the guide warm, which warns and continues.
            // A client with no profile has no synchronous surface at all, so
            // continuing would reproduce the failure this warm exists to
            // remove, with a console line in front of it.
            fetchMock.mockImplementation((url: string) =>
                Promise.resolve(
                    url.endsWith('/scheme/concepts')
                        ? mockResponse(500, JSON.stringify({ error: 'boom' }))
                        : mockResponse(200, JSON.stringify(connectBody(url))),
                ),
            );
            await expect(
                connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: 'acme-prod',
                    contextVersion: '1.0.0',
                }),
            ).rejects.toThrow(/500/);
        });

        it('declares no guide, so it asks for no guide view', async () => {
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            expect(client.guide.listGuideMeta()).toEqual([]);
            await expect(client.guide.buildGuideViews()).resolves.toEqual([]);
            expect(
                fetchMock.mock.calls.some(([url]: [string]) =>
                    String(url).includes('/guide/'),
                ),
            ).toBe(false);
            client.destroy();
        });

        it('health-check stays at /v1/health even with contextId set', async () => {
            mockConnectOk(fetchMock);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            const [url] = fetchMock.mock.calls[0];
            expect(url).toBe('https://api.example.com/v1/health');
            client.destroy();
        });
    });

    // -----------------------------------------------------------------------
    // 404 / context-not-found distinguishability
    //
    // The client surfaces a 404 via EzClassifyError.status: there is no
    // dedicated ContextNotFoundError subclass. Callers check `err instanceof EzClassifyError && err.status === 404`.
    // -----------------------------------------------------------------------
    describe('404 context-not-found handling', () => {
        it('connectContext() throws EzClassifyError when health returns 404', async () => {
            fetchMock.mockResolvedValue(mockResponse(404, 'Not Found'));
            await expect(
                connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: 'missing-ctx',
                    contextVersion: '0.1.0',
                }),
            ).rejects.toThrow(EzClassifyError);
        });

        it('connectContext() 404 error carries .status === 404', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'Context not found: missing-ctx' }),
                ),
            );
            let caught: EzClassifyError | null = null;
            try {
                await connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: 'missing-ctx',
                    contextVersion: '0.1.0',
                });
            } catch (e) {
                caught = e as EzClassifyError;
            }
            expect(caught).not.toBeNull();
            expect(caught).toBeInstanceOf(EzClassifyError);
            expect(caught!.status).toBe(404);
        });

        it('op on missing context returns EzClassifyError with status 404', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'Context not found' }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'missing-ctx',
                contextVersion: '0.1.0',
            });
            let caught: EzClassifyError | null = null;
            try {
                await c.scheme.process('TEST', {});
            } catch (e) {
                caught = e as EzClassifyError;
            }
            expect(caught).toBeInstanceOf(EzClassifyError);
            expect(caught!.status).toBe(404);
        });

        it('404 error message includes the HTTP method and path', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'Context not found' }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'missing-ctx',
                contextVersion: '0.1.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow(/POST/);
        });

        it('404 body from the server is exposed on the error', async () => {
            const body = { error: 'Context not found: missing-ctx' };
            fetchMock.mockResolvedValue(
                mockResponse(404, JSON.stringify(body)),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'missing-ctx',
                contextVersion: '0.1.0',
            });
            let caught: EzClassifyError | null = null;
            try {
                await c.scheme.process('TEST', {});
            } catch (e) {
                caught = e as EzClassifyError;
            }
            expect(caught).not.toBeNull();
            expect(caught!.body).toEqual(body);
        });

        it('callers can distinguish 404 from other errors via err.status', async () => {
            // Pattern the task calls for: `err instanceof EzClassifyError && err.status === 404`
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'Context not found' }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'missing-ctx',
                contextVersion: '0.1.0',
            });
            try {
                await c.scheme.process('TEST', {});
            } catch (e) {
                // This is the canonical caller pattern for distinguishing a missing context
                const isContextNotFound =
                    e instanceof EzClassifyError && e.status === 404;
                expect(isContextNotFound).toBe(true);
                return;
            }
            expect.fail('should have thrown');
        });

        it('connectContext throws EzClassifyError when the server returns 404', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'Context not found: missing' }),
                ),
            );
            await expect(
                connectContext({
                    baseUrl: 'https://api.example.com',
                    contextId: 'missing',
                    contextVersion: '1.0.0',
                }),
            ).rejects.toThrow(EzClassifyError);
        });
    });

    // -----------------------------------------------------------------------
    // Version tracking (ping-level)
    // -----------------------------------------------------------------------
    describe('version tracking across calls', () => {
        it('ping() returns engineVersion from /v1/health response', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify({
                        status: 'ok',
                        engineVersion: '0.1.0',
                        engineSha: 'abc123',
                        gitTag: 'v0.1.0',
                    }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            const result = await c.ping();
            expect(result.engineVersion).toBe('0.1.0');
        });

        it('ping() uses unprefixed /v1/health even in context-bound mode', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify({
                        status: 'ok',
                        engineVersion: '0.1.0',
                        engineSha: '',
                        gitTag: '',
                    }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await c.ping();
            const [url] = fetchMock.mock.calls[0];
            expect(url).toBe('https://api.example.com/v1/health');
        });

        it('version mismatch warning fires exactly once across multiple ping() calls', async () => {
            const healthPayload = JSON.stringify({
                status: 'ok',
                engineVersion: '99.0.0',
                engineSha: '',
                gitTag: '',
            });
            fetchMock.mockResolvedValue(mockResponse(200, healthPayload));
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => {});
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await c.ping();
            await c.ping();
            await c.ping();
            expect(warnSpy).toHaveBeenCalledOnce();
            warnSpy.mockRestore();
        });

        it('no warning when versions match', async () => {
            // Mirror the client's own spec version so this stays correct across
            // version bumps instead of pinning a literal that goes stale.
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify({
                        status: 'ok',
                        engineVersion: CLIENT_SPEC_VERSION,
                        engineSha: '',
                        gitTag: '',
                    }),
                ),
            );
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => {});
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await c.ping();
            expect(warnSpy).not.toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // An unpinned binding whose alias moves under a running client
    //
    // The operations follow a republished composition on their own, because
    // each one re-resolves per request. The cached profile does not, and a UI
    // reading it synchronously would paint categories the server no longer
    // recognizes. X-EzClassify-Resolved-Version is the only thing that says so.
    // -----------------------------------------------------------------------
    describe('resolved-version drift', () => {
        /**
         * Answer a context-bound connect at whichever version `state` names,
         * and stamp every response with that version the way the dispatcher
         * does.
         */
        function mockAt(state: { version: string }): void {
            fetchMock.mockImplementation((url: string) => {
                const resource = ctxSchemeResourceBody(url);
                const payload =
                    resource !== undefined
                        ? resource
                        : url.includes('/scheme/process')
                          ? {
                                resolution: {
                                    contextId: 'acme-prod',
                                    resolvedVersion: state.version,
                                    artifacts: [],
                                },
                                result: corpusResult('ctx-scheme-process.ok'),
                            }
                          : url.includes('/v1/ctx/')
                            ? { ...CTX_DESCRIBE, version: state.version }
                            : { status: 'ok' };
                return Promise.resolve(
                    mockResponse(200, JSON.stringify(payload), {
                        'X-EzClassify-Resolved-Version': state.version,
                    }),
                );
            });
        }

        it('re-warms the profile when latest resolves somewhere new', async () => {
            const warn = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);
            const state = { version: '1.0.0' };
            mockAt(state);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: 'latest',
            });
            expect(
                fetchMock.mock.calls.some(([url]: [string]) =>
                    String(url).includes('/v1/ctx/acme-prod/1.0.0/scheme'),
                ),
            ).toBe(true);

            state.version = '1.1.0';
            await client.scheme.process('OPEN');
            await client._settleProfileRewarm();

            expect(
                fetchMock.mock.calls.filter(([url]: [string]) =>
                    String(url).startsWith(
                        'https://api.example.com/v1/ctx/acme-prod/1.1.0/scheme',
                    ),
                ),
            ).toHaveLength(6);
            expect(
                warn.mock.calls.filter(([message]) =>
                    String(message).includes('resolved to 1.1.0'),
                ),
            ).toHaveLength(1);
            warn.mockRestore();
            client.destroy();
        });

        it('leaves a pinned client alone: its composition cannot move', async () => {
            const warn = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);
            const state = { version: '1.0.0' };
            mockAt(state);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            const afterConnect = fetchMock.mock.calls.length;

            // A header that disagrees with a pin is a server bug, not an alias
            // move, and re-reading the profile would not fix it.
            state.version = '2.0.0';
            await client.scheme.process('OPEN');
            await client._settleProfileRewarm();

            expect(fetchMock.mock.calls.length).toBe(afterConnect + 1);
            expect(warn).not.toHaveBeenCalled();
            warn.mockRestore();
            client.destroy();
        });

        it('keeps the old profile when the re-warm itself fails', async () => {
            const warn = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);
            const state = { version: '1.0.0' };
            mockAt(state);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: 'latest',
            });

            const stale = client.scheme.getScheme();
            state.version = '1.1.0';
            const healthy = fetchMock.getMockImplementation()!;
            fetchMock.mockImplementation((url: string, init: RequestInit) =>
                String(url).includes('/scheme/concepts')
                    ? Promise.resolve(
                          mockResponse(500, JSON.stringify({ error: 'boom' })),
                      )
                    : healthy(url, init),
            );
            await client.scheme.process('OPEN');
            await client._settleProfileRewarm();

            // The synchronous surface still answers, which is the only thing it
            // can do when the replacement did not arrive.
            expect(client.scheme.getScheme()).toBe(stale);
            expect(
                warn.mock.calls.filter(([message]) =>
                    String(message).includes('still in use'),
                ),
            ).toHaveLength(1);
            warn.mockRestore();
            client.destroy();
        });

        it('drops memoized answers built against the composition that moved', async () => {
            const warn = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);
            const state = { version: '1.0.0' };
            mockAt(state);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: 'latest',
            });
            const processCalls = (): number =>
                fetchMock.mock.calls.filter(([url]: [string]) =>
                    String(url).includes('/scheme/process'),
                ).length;

            await client.scheme.process('OPEN');
            await client.scheme.process('OPEN');
            expect(processCalls()).toBe(1);

            // An unpinned binding files both compositions under the same key,
            // so a second request is what carries the new resolved version
            // back and starts the re-warm.
            state.version = '1.1.0';
            await client.scheme.process('OTHER');
            await client._settleProfileRewarm();
            expect(processCalls()).toBe(2);

            // The answer held for 'OPEN' was computed at 1.0.0, so it has to
            // go back to the wire rather than come out of the cache.
            await client.scheme.process('OPEN');
            expect(processCalls()).toBe(3);
            warn.mockRestore();
            client.destroy();
        });

        it('destroy() drops what the cache is holding', async () => {
            const state = { version: '1.0.0' };
            mockAt(state);
            const client = await connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await client.scheme.process('OPEN');
            expect(client._cache?.size).toBe(1);
            client.destroy();
            expect(client._cache?.size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Error propagation from context-bound ops
    // -----------------------------------------------------------------------
    describe('error propagation from context-bound ops', () => {
        it('401 Unauthorized surfaces as EzClassifyError with status 401', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(401, JSON.stringify({ error: 'unauthorized' })),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            let caught: EzClassifyError | null = null;
            try {
                await c.scheme.process('TEST', {});
            } catch (e) {
                caught = e as EzClassifyError;
            }
            expect(caught).toBeInstanceOf(EzClassifyError);
            expect(caught!.status).toBe(401);
        });

        it('network failure throws EzClassifyError with /Network error/ message', async () => {
            fetchMock.mockRejectedValue(new TypeError('connect ECONNREFUSED'));
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod',
                contextVersion: '1.0.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow(
                /Network error/,
            );
        });
    });
});
