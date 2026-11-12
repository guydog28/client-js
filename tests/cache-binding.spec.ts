/**
 * What the client's binding does to the response cache: entry lifetime under a
 * pinned Context version, the opt-in that lets access decisions be cached at
 * all, the per-category suggestions that have to be as cheap on a repeat as the
 * fan-out they replace, and the request fields every key has to carry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assertion } from '@ezclassify/types';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { DEFAULT_CACHE_TTL_MS } from '../src/request-cache';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusBody, corpusResult } from './contract-fixtures';

const ASSESSMENT = {
    emitted: [],
    omitted: [],
    collapsed: [],
    conflicts: [],
    unrepresentable: [],
};

const PROCESS_RESULT = {
    assertions: [],
    rendered: 'PRINCIPAL',
    assessment: ASSESSMENT,
    valid: true,
    inputWasValid: true,
    errors: [],
    warnings: [],
    appliedFixes: [],
    proposedFixes: [],
    renders: {},
    notices: [],
};

const VALIDATE_RESULT = {
    assertions: [],
    rendered: 'PRINCIPAL',
    assessment: ASSESSMENT,
    valid: true,
    inputWasValid: true,
    errors: [],
    warnings: [],
    appliedFixes: [],
    notices: [],
};

const EXPLANATION = {
    input: 'principal only',
    schemeId: 'records',
    entries: [],
    repairs: [],
    validationErrors: [],
    inferences: [],
    finalAssertions: [],
    rendered: 'PRINCIPAL',
};

const DECISION = corpusResult('ctx-access-check.assertions');

const DATA: Assertion[] = [
    { categoryId: 'level', conceptId: 'LEVEL-HIGH' },
] as Assertion[];

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

/** Move the clock the cache reads, without touching the event loop. */
function withClock<T>(run: (advance: (ms: number) => void) => Promise<T>) {
    const realNow = Date.now;
    let now = realNow();
    Date.now = (): number => now;
    return run((ms) => {
        now += ms;
    }).finally(() => {
        Date.now = realNow;
    });
}

describe('cache lifetime by binding', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Past the default five-minute lifetime of an entry on a moving binding. */
    const DEFAULT_TTL_PAST = 6 * 60 * 1000;

    /** An hour past any TTL this client could have been given. */
    const WELL_PAST_ANY_TTL = 60 * 60 * 1000;

    it('holds an engine-op answer forever on a client pinned to a version', async () => {
        // A published version is immutable, so the same request answers the
        // same on Tuesday as it did on Monday. Expiring the entry would buy a
        // round trip that returns exactly what the client already holds.
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });

        await withClock(async (advance) => {
            await c.scheme.process('principal only');
            advance(WELL_PAST_ANY_TTL);
            await c.scheme.process('principal only');
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('overrides an op that asked for a shorter TTL of its own', async () => {
        // `scan` keeps a two-minute TTL because result currency usually beats
        // repeat text. Under a pin there is no currency to lose: the binding
        // decides the lifetime, not the operation.
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(corpusResult('ctx-scheme-scan.ok'))),
            ),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });

        await withClock(async (advance) => {
            await c.scheme.scan('a document');
            advance(WELL_PAST_ANY_TTL);
            await c.scheme.scan('a document');
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('expires on a `latest` binding, which resolves anew every time', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: 'latest',
        });

        await withClock(async (advance) => {
            await c.scheme.process('principal only');
            advance(DEFAULT_TTL_PAST);
            await c.scheme.process('principal only');
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['a token-defaulted version', { contextToken: 'signed-envelope' }],
        ['an omitted version with no token', {}],
    ])(
        'expires on %s, which the server picks per request',
        async (_label, token) => {
            fetchMock.mockResolvedValue(
                mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
            );
            const c = new EzClassifyClient('https://api.example.com', {
                contextId: 'records',
                ...token,
            });

            await withClock(async (advance) => {
                await c.scheme.process('principal only');
                advance(DEFAULT_TTL_PAST);
                await c.scheme.process('principal only');
            });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    it('names the Context binding as the composition component of the key', () => {
        // A context-bound client never holds the layer ids: the composition
        // belongs to the Context, so the binding is the most specific thing
        // the key can say about what answered. Ports need the same component
        // or their keys collide across bindings.
        const pinned = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
        const tokenBound = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextToken: 'signed-envelope',
        });
        expect(pinned._stackCacheKey()).toBe('ctx:records@1.2.3');
        expect(tokenBound._stackCacheKey()).toBe('ctx:records');
    });
});

describe('render and normalize cache the coerced string, not the raw body', () => {
    // Both operations promise a plain marking string, but the server can answer
    // with a bare string or a `{result}`/`{rendered}` wrapper. Coercion has to
    // run inside the cached call so the entry holds the string every caller
    // expects, not a raw wire body. On a
    // pinned client the entry never expires, so whatever it holds is what every
    // later caller gets, forever.
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function pinnedClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    it('caches a wrapped render response as the coerced string', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope({
                        result: 'TOP SECRET//NF',
                        assessment: {
                            emitted: [],
                            omitted: [],
                            collapsed: [],
                            conflicts: [],
                            unrepresentable: [],
                        },
                    }),
                ),
            ),
        );
        const c = pinnedClient();

        const first = await c.scheme.render([{ conceptId: 'TS' }]);
        const second = await c.scheme.render([{ conceptId: 'TS' }]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(first.rendered).toBe('TOP SECRET//NF');
        expect(second).toEqual(first);
    });

    it('keeps projection and full-preservation renders in separate cache entries', async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as {
                preservation?: string;
                signal?: unknown;
            };
            return Promise.resolve(
                mockResponse(
                    200,
                    JSON.stringify(
                        envelope({
                            result: body.preservation ?? 'projection',
                            assessment: {
                                emitted: [],
                                omitted: [],
                                collapsed: [],
                                conflicts: [],
                                unrepresentable: [],
                            },
                        }),
                    ),
                ),
            );
        });
        const c = pinnedClient();
        const assertions = [{ conceptId: 'TS', categoryId: 'level' }];

        const projection = await c.scheme.render(assertions, 'short', {
            preservation: 'projection',
        });
        const full = await c.scheme.render(assertions, 'short', {
            preservation: 'full',
        });
        const fullAgain = await c.scheme.render(assertions, 'short', {
            preservation: 'full',
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(projection.rendered).toBe('projection');
        expect(full.rendered).toBe('full');
        expect(fullAgain).toEqual(full);
        const bodies = fetchMock.mock.calls.map(([, init]) =>
            JSON.parse(String((init as RequestInit).body)),
        );
        expect(bodies).toEqual([
            expect.objectContaining({
                assertions,
                outputFormat: 'short',
                preservation: 'projection',
            }),
            expect.objectContaining({
                assertions,
                outputFormat: 'short',
                preservation: 'full',
            }),
        ]);
        expect(bodies[0]).not.toHaveProperty('signal');
        expect(bodies[1]).not.toHaveProperty('signal');
        // The contract names the output `outputFormat` and closes the body.
        expect(bodies[0]).not.toHaveProperty('format');
    });

    it('forwards render options through the top-level delegate', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(
                    envelope({
                        result: 'full',
                        assessment: {
                            emitted: [],
                            omitted: [],
                            collapsed: [],
                            conflicts: [],
                            unrepresentable: [],
                        },
                    }),
                ),
            ),
        );
        const c = pinnedClient();
        const controller = new AbortController();

        await c.scheme.render(
            [{ conceptId: 'TS', categoryId: 'level' }],
            'short',
            {
                preservation: 'full',
                signal: controller.signal,
            },
        );

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init.body))).toMatchObject({
            outputFormat: 'short',
            preservation: 'full',
        });
        expect(JSON.parse(String(init.body))).not.toHaveProperty('signal');
    });
});

describe('access decisions are never cached', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function pinnedClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    it('sends every check to the wire by default, because the trip is the audit record', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(DECISION))),
        );
        const c = pinnedClient();

        await c.access.check(DATA, { clearance: 'HIGH' });
        await c.access.check(DATA, { clearance: 'HIGH' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends every composed check to the wire by default too', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(DECISION))),
        );
        const c = pinnedClient();

        await c.context.checkAccess(DATA, { clearance: 'HIGH' });
        await c.context.checkAccess(DATA, { clearance: 'HIGH' });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends the adapter-named checkContextAccess to the wire every time too', async () => {
        // `checkContextAccess` is the name the ContextAdapter contract uses and
        // what a UI holding the adapter calls.
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(DECISION))),
        );
        const c = pinnedClient();

        await c.checkContextAccess(DATA, { clearance: 'HIGH' });
        await c.checkContextAccess(DATA, { clearance: 'HIGH' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('a malformed response is not held', () => {
    // An entry settles on whatever the cached call returns, so a response
    // checked after the cache files the bad body as a good answer. Under a pin
    // that entry never expires, which turns one server hiccup into a client
    // that throws until it is thrown away. Every check runs inside the call.
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const RULE = (corpusBody('ctx-access-rules.ok') as { rules: unknown[] })
        .rules[0];

    function pinnedClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    /** Answer the first call with `bad`, every call after it with `good`. */
    function thenRecovers(bad: string, good: string) {
        let served = false;
        fetchMock.mockImplementation(() => {
            const body = served ? good : bad;
            served = true;
            return Promise.resolve(mockResponse(200, body));
        });
    }

    it('retries access/rules after a response with no `rules` array', async () => {
        thenRecovers('{}', JSON.stringify({ rules: [RULE] }));
        const c = pinnedClient();

        await expect(c.access.describeAllAccessRules()).rejects.toThrow(
            /Malformed response from GET access\/rules: \/rules/,
        );
        await expect(c.access.describeAllAccessRules()).resolves.toEqual([
            RULE,
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a decision after an unparseable envelope', async () => {
        thenRecovers('{}', JSON.stringify(envelope(DECISION)));
        const c = pinnedClient();

        await expect(
            c.context.checkAccess(DATA, { clearance: 'HIGH' }),
        ).rejects.toThrow(EzClassifyError);
        const recovered = await c.context.checkAccess(DATA, {
            clearance: 'HIGH',
        });

        expect(recovered.result).toEqual(DECISION);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([null, {}])(
        'retries process after an incomplete result %j',
        async (badResult) => {
            thenRecovers(
                JSON.stringify(envelope(badResult)),
                JSON.stringify(envelope(PROCESS_RESULT)),
            );
            const c = pinnedClient();

            await expect(c.scheme.process('PRINCIPAL')).rejects.toThrow(
                EzClassifyError,
            );
            await expect(c.scheme.process('PRINCIPAL')).resolves.toEqual(
                PROCESS_RESULT,
            );
            expect(fetchMock).toHaveBeenCalledTimes(2);
        },
    );

    it('retries suggest after an empty result object', async () => {
        const good = { suggestions: [], warnings: [] };
        thenRecovers(
            JSON.stringify(envelope({})),
            JSON.stringify(envelope(good)),
        );
        const c = pinnedClient();

        await expect(c.scheme.suggest('PRINCIPAL')).rejects.toThrow(
            EzClassifyError,
        );
        await expect(c.scheme.suggest('PRINCIPAL')).resolves.toEqual(good);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('suggestForCategories caching', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    const SUGGEST_RESULT = { suggestions: [], warnings: [] };

    const COMMITTED: Assertion[] = [
        { categoryId: 'level', conceptId: 'LEVEL-HIGH' },
        { categoryId: 'audience', conceptId: 'AUD-A' },
    ] as Assertion[];

    it('memoizes a repeated request', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope({ level: SUGGEST_RESULT })),
            ),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });

        await c.scheme.suggestForCategories(COMMITTED, ['level']);
        await c.scheme.suggestForCategories(COMMITTED, ['level']);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('every request field that changes the answer is part of the key', () => {
    // The client is the only caching authority in the stack, so a key that
    // ignored one of these would hand a caller another request's answer: the
    // renders of different outputs, the options for different categories,
    // facts read as a whole when they were a part. Each pair below differs in
    // one field and must reach the wire twice; the repeat of either must not.
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
        fetchMock.mockImplementation((url: string) =>
            Promise.resolve(
                mockResponse(
                    200,
                    JSON.stringify(
                        envelope(
                            url.endsWith('/scheme/explain')
                                ? EXPLANATION
                                : url.endsWith('/scheme/validate')
                                  ? VALIDATE_RESULT
                                  : PROCESS_RESULT,
                        ),
                    ),
                ),
            ),
        );
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function pinnedClient() {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
    }

    const CHOSEN: Assertion[] = [
        { categoryId: 'audience', conceptId: 'AUD-A' },
    ] as Assertion[];

    it.each([
        [
            'outputs',
            { outputs: ['records/short'] },
            { outputs: ['records/long'] },
        ],
        ['suggestFor', { suggestFor: ['level'] }, { suggestFor: ['audience'] }],
        [
            'outputFormat',
            { outputFormat: 'records/short' },
            { outputFormat: 'records/long' },
        ],
        ['inputFormat', { inputFormat: 'short' }, { inputFormat: 'long' }],
        ['assertions', {}, { assertions: CHOSEN }],
        ['surface', {}, { surface: 'portion' }],
        ['parts', { parts: ['(P)'] }, { parts: ['(P)', '(Q)'] }],
        ['context', {}, { context: { role: 'part' as const } }],
    ])('process keeps %s apart', async (_field, first, second) => {
        const c = pinnedClient();

        await c.scheme.process('principal only', first);
        await c.scheme.process('principal only', second);
        await c.scheme.process('principal only', first);
        await c.scheme.process('principal only', second);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the order of named outputs, which the answer follows', async () => {
        const c = pinnedClient();

        await c.scheme.process('principal only', {
            outputs: ['records/short', 'records/long'],
        });
        await c.scheme.process('principal only', {
            outputs: ['records/long', 'records/short'],
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps validating text apart from validating the facts it states', async () => {
        const c = pinnedClient();

        await c.scheme.validate('principal only');
        await c.scheme.validate(DATA);
        await c.scheme.validate('principal only');
        await c.scheme.validate(DATA);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        [
            'outputFormat',
            { outputFormat: 'records/short' },
            { outputFormat: 'records/long' },
        ],
        ['inputFormat', { inputFormat: 'short' }, { inputFormat: 'long' }],
        ['surface', {}, { surface: 'portion' }],
        ['parts', {}, { parts: ['(P)'] }],
        ['context', {}, { context: { role: 'part' as const } }],
    ])('validate keeps %s apart', async (_field, first, second) => {
        const c = pinnedClient();

        await c.scheme.validate('principal only', first);
        await c.scheme.validate('principal only', second);
        await c.scheme.validate('principal only', first);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        [
            'outputFormat',
            { outputFormat: 'records/short' },
            { outputFormat: 'records/long' },
        ],
        ['inputFormat', { inputFormat: 'short' }, { inputFormat: 'long' }],
        ['assertions', {}, { assertions: CHOSEN }],
        ['surface', {}, { surface: 'portion' }],
        ['parts', {}, { parts: ['(P)'] }],
        ['context', {}, { context: { role: 'part' as const } }],
    ])('explain keeps %s apart', async (_field, first, second) => {
        const c = pinnedClient();

        await c.scheme.explain('principal only', first);
        await c.scheme.explain('principal only', second);
        await c.scheme.explain('principal only', first);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('files explain apart from process, though the two send the same body', async () => {
        const c = pinnedClient();

        const processed = await c.scheme.process('principal only');
        const explained = await c.scheme.explain('principal only');
        await c.scheme.explain('principal only');

        expect(processed).toEqual(PROCESS_RESULT);
        expect(explained).toEqual(EXPLANATION);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('the default entry lifetime', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /**
     * The client names no TTL of its own, so an unpinned entry lives exactly as
     * long as the cache's own default. The number lives in one place; a second
     * copy in the client would let the documented default and the real one
     * drift apart without anything noticing.
     */
    it('is the cache constant when the caller names no TTL', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: 'latest',
        });

        await withClock(async (advance) => {
            await c.scheme.process('principal only');
            advance(DEFAULT_CACHE_TTL_MS - 1);
            await c.scheme.process('principal only');
            expect(fetchMock).toHaveBeenCalledTimes(1);

            advance(2);
            await c.scheme.process('principal only');
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('an unpinned entry expires with the default lifetime', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('expires an entry once the default lifetime has passed', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        );
        const c = new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: 'latest',
        });

        await withClock(async (advance) => {
            await c.scheme.process('principal only');
            advance(DEFAULT_CACHE_TTL_MS - 1);
            await c.scheme.process('principal only');
            expect(fetchMock).toHaveBeenCalledTimes(1);

            advance(2);
            await c.scheme.process('principal only');
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('cache identity and authorization refusal', () => {
    const PROCESS_RESULT = {
        assertions: [],
        rendered: 'OPEN',
        assessment: ASSESSMENT,
        valid: true,
        inputWasValid: true,
        errors: [],
        warnings: [],
        appliedFixes: [],
        proposedFixes: [],
        renders: {},
        notices: [],
    };

    function client(
        fetchImpl: typeof fetch,
        options: Record<string, unknown> = {},
    ) {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
            fetchImpl,
            ...options,
        });
    }

    it.each([
        ['explicit 401', 401, { error: 'unauthorized' }],
        ['masked denial', 404, { error: 'not_found' }],
    ])(
        'invalidates a pinned safe read after %s with a static token',
        async (_label, status, denialBody) => {
            const fetchImpl = vi.fn(async (url: string | URL | Request) =>
                String(url).includes('/denied')
                    ? mockResponse(status, JSON.stringify(denialBody))
                    : mockResponse(
                          200,
                          JSON.stringify(envelope(PROCESS_RESULT)),
                      ),
            ) as unknown as typeof fetch;
            const c = client(fetchImpl, { auth: { token: 'static' } });
            try {
                await c.scheme.process('OPEN');
                await expect(
                    c._request('GET', '/v1/denied'),
                ).rejects.toBeInstanceOf(EzClassifyError);
                await c.scheme.process('OPEN');
                expect(fetchImpl).toHaveBeenCalledTimes(3);
            } finally {
                c.destroy();
            }
        },
    );

    it.each([
        ['supplier and explicit 401', 401, false, 1],
        ['supplier and masked denial', 404, false, 2],
        ['caller-owned Authorization and explicit 401', 401, true, 1],
        ['caller-owned Authorization and masked denial', 404, true, 1],
    ])(
        'invalidates a pinned read for %s',
        async (_label, status, owned, expectedDenials) => {
            const fetchImpl = vi.fn(async (url: string | URL | Request) =>
                String(url).includes('/denied')
                    ? mockResponse(
                          status,
                          JSON.stringify(
                              status === 404
                                  ? { error: 'not_found' }
                                  : { error: 'unauthorized' },
                          ),
                      )
                    : mockResponse(
                          200,
                          JSON.stringify(envelope(PROCESS_RESULT)),
                      ),
            ) as unknown as typeof fetch;
            const c = client(
                fetchImpl,
                owned
                    ? {
                          auth: { token: () => 'unused' },
                          headers: { Authorization: 'Bearer caller' },
                      }
                    : { auth: { token: () => 'supplier' } },
            );
            try {
                await c.scheme.process('OPEN');
                await expect(
                    c._request('GET', '/v1/denied'),
                ).rejects.toBeInstanceOf(EzClassifyError);
                await c.scheme.process('OPEN');
                const urls = (
                    fetchImpl as ReturnType<typeof vi.fn>
                ).mock.calls.map(([url]) => String(url));
                expect(
                    urls.filter((url) => url.includes('/scheme/process')),
                ).toHaveLength(2);
                expect(
                    urls.filter((url) => url.includes('/denied')),
                ).toHaveLength(expectedDenials);
            } finally {
                c.destroy();
            }
        },
    );

    it('keeps cached data after a resource-specific 404, not an auth refusal', async () => {
        const fetchImpl = vi.fn(async (url: string | URL | Request) =>
            String(url).includes('/missing')
                ? mockResponse(
                      404,
                      JSON.stringify({ error: 'not_found', id: 'missing' }),
                  )
                : mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        ) as unknown as typeof fetch;
        const c = client(fetchImpl, { auth: { token: 'static' } });
        try {
            await c.scheme.process('OPEN');
            await expect(
                c._request('GET', '/v1/missing'),
            ).rejects.toBeInstanceOf(EzClassifyError);
            await c.scheme.process('OPEN');
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            c.destroy();
        }
    });

    it('keeps cached data when describeConcept names a concept the scheme does not declare', async () => {
        // The contract's answer for an unknown concept: a 404 that carries a
        // code and a detail, unlike the codeless refusal before routing. Its
        // `error` is the refusal's own word here, so the code and the detail
        // are what tell the two apart.
        const unknown = {
            error: 'not_found',
            code: 'NOT_FOUND',
            detail: 'conceptId: NOPE',
        };
        const fetchImpl = vi.fn(async (url: string | URL | Request) =>
            String(url).includes('/scheme/describe-concept')
                ? mockResponse(404, JSON.stringify(unknown))
                : mockResponse(200, JSON.stringify(envelope(PROCESS_RESULT))),
        ) as unknown as typeof fetch;
        const c = client(fetchImpl, { auth: { token: 'static' } });
        try {
            await c.scheme.process('OPEN');
            const refused = await c.scheme
                .describeConcept('NOPE', 'level')
                .catch((err: unknown) => err);
            expect(refused).toBeInstanceOf(EzClassifyError);
            expect(refused).toMatchObject({
                status: 404,
                code: 'NOT_FOUND',
                detail: 'conceptId: NOPE',
                body: unknown,
            });
            expect(
                (refused as EzClassifyError).possiblyUnauthenticated,
            ).toBeUndefined();
            await c.scheme.process('OPEN');
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            c.destroy();
        }
    });
});
