import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

function contextEnvelope(result: unknown) {
    return {
        resolution: {
            contextId: 'test',
            resolvedVersion: '0.1.0',
            artifacts: [],
        },
        result,
    };
}

describe('EzClassifyClient: context-bound URL routing', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    describe('option validation', () => {
        it('allows contextId without contextVersion when a signed contextToken is supplied', () => {
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextToken: 'signed-context-envelope',
            });
            expect(c).toBeDefined();
        });

        it('allows contextId+contextVersion alone', () => {
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            expect(c).toBeDefined();
        });
    });

    describe('Context operation routing', () => {
        it('scheme/process uses /v1/ctx/<id>/<ver>/scheme/process', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            await c.scheme.process('TEST', {});
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/scheme/process',
            );
        });

        it('access/check is rewritten', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(
                            corpusResult('ctx-access-check.assertions'),
                        ),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            await c.access.check([], { clearance: 'internal' });
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/access/check',
            );
        });

        it('access/check sends the userAttributes map', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(
                            corpusResult('ctx-access-check.assertions'),
                        ),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            await c.access.check([], { clearance: 'internal' });
            const init = fetchMock.mock.calls[0]![1] as RequestInit;
            const body = JSON.parse(init.body as string);
            expect(body.userAttributes).toEqual({ clearance: 'internal' });
        });

        it('guide scan and evaluation use the Context-bound guide surface', async () => {
            fetchMock
                .mockResolvedValueOnce(
                    mockResponse(
                        200,
                        JSON.stringify(
                            contextEnvelope(corpusResult('ctx-guide-scan.ok')),
                        ),
                    ),
                )
                .mockResolvedValueOnce(
                    mockResponse(
                        200,
                        JSON.stringify(
                            contextEnvelope(
                                corpusResult('ctx-guide-evaluate.ok'),
                            ),
                        ),
                    ),
                );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });

            await c.guide.scan('customer list');
            await c.guide.evaluate('guide-a', ['customer-list']);

            expect(fetchMock.mock.calls[0]![0]).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/guide/scan',
            );
            expect(fetchMock.mock.calls[1]![0]).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/guide/evaluate',
            );
            expect(
                JSON.parse(
                    (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
                ),
            ).toEqual({
                guideId: 'guide-a',
                selectedRuleIds: ['customer-list'],
            });
        });

        it('the guide view preserves the optional guide selection', async () => {
            fetchMock.mockResolvedValueOnce(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-guide-view.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });

            await c.guide.buildGuideView('guide-a');

            for (const call of fetchMock.mock.calls) {
                expect(
                    JSON.parse((call[1] as RequestInit).body as string),
                ).toMatchObject({ guideId: 'guide-a' });
            }
        });

        // Almost every op is the same request at a rewritten URL. This one is
        // not: the Context route is a GET with the arguments in the query, so
        // rewriting the flat POST's URL and leaving the rest alone put a body
        // on a route that serves no POST at all.
        it('describe-concept goes out as a GET with query arguments under a Context', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(
                            corpusResult('ctx-scheme-describe-concept.ok'),
                        ),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });

            await c.scheme.describeConcept('NF', 'caveat', {
                view: 'short',
            });

            const [url, init] = fetchMock.mock.calls[0] as [
                string,
                RequestInit,
            ];
            expect(url).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/scheme/describe-concept' +
                    '?conceptId=NF&categoryId=caveat&view=short',
            );
            expect(init.method).toBe('GET');
            expect(init.body).toBeUndefined();
        });

        it('apply-preset drops the scheme id: the Context names the scheme', async () => {
            // Not the URL rewrite. Prefixing the flat path would produce
            // `/scheme/my-scheme/apply-preset` under the Context, which is a
            // route nothing serves; the ctx surface takes the scheme from the
            // Context and carries no id segment at all.
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            await c.scheme.applyPreset('a-preset', {});
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/0.1.0/scheme/apply-preset',
            );
        });

        it('/v1/health stays unprefixed even in context-bound mode', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify({ status: 'ok', engineVersion: '0.1.0' }),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextVersion: '0.1.0',
            });
            await c.ping();
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toBe('https://api.example.com/v1/health');
        });

        it.each([
            ['an omitted', {}],
            ['an empty', { contextVersion: '' }],
            ['a null', { contextVersion: null as unknown as string }],
        ])(
            'drops the version segment for %s contextVersion with no contextToken',
            async (_label, version) => {
                // The server chooses: the runtime reads a missing segment as
                // the newest published version of the Context.
                fetchMock.mockResolvedValue(
                    mockResponse(
                        200,
                        JSON.stringify(
                            contextEnvelope(
                                corpusResult('ctx-scheme-process.ok'),
                            ),
                        ),
                    ),
                );
                const c = new EzClassifyClient('https://api.example.com', {
                    contextId: 'acme-prod-marking',
                    ...version,
                });
                await c.scheme.process('TEST', {});
                const url = fetchMock.mock.calls[0]![0] as string;
                expect(url).toBe(
                    'https://api.example.com/v1/ctx/acme-prod-marking/scheme/process',
                );
            },
        );

        it('drops the version segment when contextToken is supplied without contextVersion', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                contextToken: 'signed-context-envelope',
            });
            await c.scheme.process('TEST', {});
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toBe(
                'https://api.example.com/v1/ctx/acme-prod-marking/scheme/process',
            );
        });

        it('sends the application id on a Context scheme operation', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                applicationId: 'case-intake-portal',
            });
            await c.scheme.process('TEST', {});
            const headers = fetchMock.mock.calls[0]![1].headers as Record<
                string,
                string
            >;
            expect(headers['x-ezclassify-application-id']).toBe(
                'case-intake-portal',
            );
            expect(headers['Authorization']).toBeUndefined();
            expect(headers['X-EzClassify-Context-Token']).toBeUndefined();
        });

        it('sends caller identity and Context authorization in separate headers', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme-prod-marking',
                auth: { token: 'caller-access-token' },
                contextToken: 'signed-context-envelope',
            });
            await c.scheme.process('TEST', {});
            const init = fetchMock.mock.calls[0]![1] as RequestInit;
            const headers = init.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer caller-access-token');
            expect(headers['X-EzClassify-Context-Token']).toBe(
                'signed-context-envelope',
            );
        });

        it('encodes special characters in contextId and version', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(
                        contextEnvelope(corpusResult('ctx-scheme-process.ok')),
                    ),
                ),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'tenant a/marking',
                contextVersion: '0.1.0+gov',
            });
            await c.scheme.process('TEST', {});
            const url = fetchMock.mock.calls[0]![0] as string;
            expect(url).toContain(
                '/v1/ctx/tenant%20a%2Fmarking/0.1.0%2Bgov/scheme/process',
            );
        });
    });

    describe('error-mode propagation', () => {
        it('propagates 401 from a context-bound op', async () => {
            fetchMock.mockResolvedValue(mockResponse(401, 'Unauthorized'));
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme',
                contextVersion: '0.1.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow();
        });

        it('propagates 404 from a context-bound op', async () => {
            fetchMock.mockResolvedValue(mockResponse(404, 'Not Found'));
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'missing',
                contextVersion: '0.1.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow();
        });

        it('propagates malformed-payload errors from a context-bound op', async () => {
            // Empty body: response.json() rejects with SyntaxError, which the
            // client wraps in EzClassifyError. Mirrors how a misbehaving server
            // (or proxy) that returns empty 200s would fail.
            fetchMock.mockResolvedValue(mockResponse(200, null));
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme',
                contextVersion: '0.1.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow();
        });

        it('propagates network errors from a context-bound op', async () => {
            fetchMock.mockRejectedValue(new TypeError('fetch failed'));
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'acme',
                contextVersion: '0.1.0',
            });
            await expect(c.scheme.process('TEST', {})).rejects.toThrow(
                /Network error/,
            );
        });
    });
});
