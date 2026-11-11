/**
 * The view a Context-bound client's `schemes` hands out for each scheme it
 * holds.
 *
 * A Context can hold schemes beside its primary: the two ends of a crosswalk,
 * or a scheme it keeps for marking alongside. `schemes.get(key)` is the view
 * bound to one of them. The key picks the view, never an argument: every
 * operation and profile read on it carries `?scheme=<key>`, its cache entries
 * are its own, and the server decides whether the Context holds the key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { ctxSchemeResourceBody, mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

const BASE = 'https://api.example.com';

/** A Context whose primary is `current`, holding `previous` as a crosswalk end. */
function describeAt(version: string, schemes = HELD) {
    return {
        id: 'records',
        version,
        scheme: { id: 'levels', version: '2.0.0', resolvedVersion: '2.0.0' },
        schemes,
    };
}

const HELD = [
    {
        selector: 'current',
        id: 'levels',
        version: '2.0.0',
        roles: ['primary', 'crosswalk-source'],
    },
    {
        selector: 'previous',
        id: 'levels-legacy',
        version: '1.0.0',
        roles: ['crosswalk-target'],
    },
];

/** Every scheme operation route, as the view method that reaches it. */
const OPERATIONS: ReadonlyArray<
    [
        route: string,
        call: (view: EzClassifyClient['scheme']) => Promise<unknown>,
    ]
> = [
    ['process', (v) => v.process('A')],
    ['validate', (v) => v.validate('A')],
    ['explain', (v) => v.explain('A')],
    ['normalize', (v) => v.normalize('A')],
    ['render', (v) => v.render([])],
    ['diff', (v) => v.diff('A', 'B')],
    ['view', (v) => v.buildSchemeView()],
    ['notices', (v) => v.collectNotices([])],
    ['filter-concepts', (v) => v.filterConcepts('A')],
    ['scan', (v) => v.scan('A')],
    ['aggregate', (v) => v.aggregate(['A'])],
    ['aggregate', (v) => v.aggregateAssertions([[]])],
    ['suggest', (v) => v.suggest('A')],
    ['suggest-for-categories', (v) => v.suggestForCategories([], ['c'])],
    ['check-coverage', (v) => v.checkCoverage(['A'], 'B')],
    ['describe-concept', (v) => v.describeConcept('k', 'c')],
    ['apply-preset', (v) => v.applyPreset('p')],
];

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

/** The server's refusal of a `?scheme=` key the Context does not hold. */
function schemeNotFound(key: string) {
    return mockResponse(
        404,
        JSON.stringify({
            code: 'scheme_not_found',
            error: `Scheme not found in context: ${key}`,
        }),
    );
}

/** The `?scheme=` a request carried, or null when it carried none. */
function schemeParam(url: string): string | null {
    return new URL(url).searchParams.get('scheme');
}

describe('schemes.get', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;
    const state = { version: '1.2.3', schemes: HELD };

    /**
     * Answer the health probe, the description and the seven profile reads,
     * naming each profile after the scheme its `?scheme=` addressed, and answer
     * every operation with a render-shaped envelope. A key the Context does not
     * hold is refused, as the server refuses it.
     */
    function serve(): void {
        fetchMock.mockImplementation((url: string) => {
            const selector = schemeParam(url);
            if (
                selector !== null &&
                !state.schemes.some((held) => held.selector === selector)
            ) {
                return Promise.resolve(schemeNotFound(selector));
            }
            const resource = ctxSchemeResourceBody(
                url,
                selector === 'previous' ? 'levels-legacy' : 'levels',
            );
            const path = new URL(url).pathname;
            const payload =
                resource !== undefined
                    ? resource
                    : path.includes('/scheme/')
                      ? envelope({
                            ...corpusResult('ctx-scheme-render.ok'),
                            result: `from ${selector ?? 'primary'}`,
                        })
                      : path.startsWith('/v1/ctx/')
                        ? describeAt(state.version, state.schemes)
                        : { status: 'ok' };
            return Promise.resolve(
                mockResponse(200, JSON.stringify(payload), {
                    'X-EzClassify-Resolved-Version': state.version,
                }),
            );
        });
    }

    function urls(): string[] {
        return fetchMock.mock.calls.map(([url]) => String(url));
    }

    beforeEach(() => {
        fetchMock = stubFetch();
        state.version = '1.2.3';
        state.schemes = HELD;
        serve();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function connect(contextVersion = '1.2.3') {
        return EzClassifyClient.connect(BASE, {
            contextId: 'records',
            contextVersion,
            heartbeat: false,
        });
    }

    it('warms every held scheme at connect, each read addressed by its selector', async () => {
        const client = await connect();

        const reads = urls().filter((url) =>
            new URL(url).pathname.startsWith('/v1/ctx/records/1.2.3/scheme'),
        );
        expect(reads).toHaveLength(14);
        expect(
            reads.filter((url) => schemeParam(url) === 'previous'),
        ).toHaveLength(7);
        expect(reads.filter((url) => schemeParam(url) === null)).toHaveLength(
            7,
        );

        // Each view answers its synchronous reads from its own scheme.
        expect(client.schemes.get('previous').getSchemeMeta().id).toBe(
            'levels-legacy',
        );
        expect(client.schemes.get('previous').getScheme().id).toBe(
            'levels-legacy',
        );
        expect(client.scheme.getSchemeMeta().id).toBe('levels');
        expect(client.getSchemeMeta().id).toBe('levels');
        client.destroy();
    });

    it('sends ?scheme= on every scheme operation, and the primary sends none', async () => {
        const client = await connect();
        const view = client.schemes.get('previous');

        for (const [route, call] of OPERATIONS) {
            fetchMock.mockClear();
            await call(view).catch(() => undefined);
            const sent = urls();
            expect(sent, route).toHaveLength(1);
            expect(new URL(sent[0]!).pathname, route).toBe(
                `/v1/ctx/records/1.2.3/scheme/${route}`,
            );
            expect(schemeParam(sent[0]!), route).toBe('previous');

            fetchMock.mockClear();
            await call(client.scheme).catch(() => undefined);
            expect(schemeParam(urls()[0]!), route).toBeNull();
        }
        client.destroy();
    });

    it('keeps an operation query of its own beside the selector', async () => {
        const client = await connect();
        fetchMock.mockClear();

        await client.schemes
            .get('previous')
            .describeConcept('k&1', 'c', { view: 'v' })
            .catch(() => undefined);

        const query = new URL(urls()[0]!).searchParams;
        expect(query.get('conceptId')).toBe('k&1');
        expect(query.get('categoryId')).toBe('c');
        expect(query.get('view')).toBe('v');
        expect(query.get('scheme')).toBe('previous');
        client.destroy();
    });

    it('caches per selector: the same request to two schemes is two answers', async () => {
        const client = await connect();
        const view = client.schemes.get('previous');
        fetchMock.mockClear();

        const fromView = await view.render([], 'default');
        const fromPrimary = await client.scheme.render([], 'default');
        const again = await view.render([], 'default');

        expect(fromView.rendered).toBe('from previous');
        expect(fromPrimary.rendered).toBe('from primary');
        expect(again.rendered).toBe('from previous');
        expect(urls()).toHaveLength(2);
        client.destroy();
    });

    it('hands out one view per key, and the primary key is bound to that key', async () => {
        const client = await connect();

        expect(client.schemes.get('previous')).toBe(
            client.schemes.get('previous'),
        );
        const primaryKey = client.schemes.get('current');
        expect(client.schemes.get('current')).toBe(primaryKey);
        expect(primaryKey).not.toBe(client.scheme);
        expect(primaryKey.getSchemeMeta().id).toBe('levels');

        fetchMock.mockClear();
        await primaryKey.render([]);
        expect(schemeParam(urls()[0]!)).toBe('current');
        client.destroy();
    });

    it('leaves an unknown key to the server, and never answers from the primary', async () => {
        const client = await connect();
        fetchMock.mockClear();

        const view = client.schemes.get('elsewhere');
        expect(urls()).toHaveLength(0);

        const refusal = await view.process('A').catch((err: unknown) => err);
        expect(refusal).toBeInstanceOf(EzClassifyError);
        expect(refusal).toMatchObject({
            status: 404,
            code: 'scheme_not_found',
        });
        expect(urls()).toHaveLength(1);
        expect(schemeParam(urls()[0]!)).toBe('elsewhere');

        await expect(view.fetchProfile()).rejects.toMatchObject({
            status: 404,
            code: 'scheme_not_found',
        });
        expect(() => view.getScheme()).toThrow(/No profile cached/);
        client.destroy();
    });

    it('does not read an artifact id as a key', async () => {
        const client = await connect();
        fetchMock.mockClear();

        const byId = client.schemes.get('levels-legacy');
        expect(byId).not.toBe(client.schemes.get('previous'));

        await expect(byId.process('A')).rejects.toMatchObject({
            status: 404,
            code: 'scheme_not_found',
        });
        expect(schemeParam(urls()[0]!)).toBe('levels-legacy');
        client.destroy();
    });

    it.each([
        ['empty', ''],
        ['blank', '   '],
        ['absent', undefined],
        ['not a string', 7],
    ])('refuses a key that is %s', async (_name, key) => {
        const client = await connect();
        fetchMock.mockClear();

        expect(() => client.schemes.get(key as string)).toThrow(
            EzClassifyError,
        );
        expect(urls()).toHaveLength(0);
        client.destroy();
    });

    it('exposes only get', async () => {
        const client = await connect();

        const members = Object.getOwnPropertyNames(
            Object.getPrototypeOf(client.schemes),
        );
        expect(members.sort()).toEqual(['constructor', 'get']);
        client.destroy();
    });

    it('hands out a view before the inventory is read', async () => {
        const client = new EzClassifyClient(BASE, {
            contextId: 'records',
            contextVersion: '1.2.3',
            heartbeat: false,
        });

        const view = client.schemes.get('previous');
        expect(urls()).toHaveLength(0);
        // Not connected, so nothing warmed it; its own fetch does.
        expect(() => view.getScheme()).toThrow(/No profile cached/);
        await view.fetchProfile();
        expect(view.getSchemeMeta().id).toBe('levels-legacy');
        expect(() => client.scheme.getScheme()).toThrow(/No profile cached/);

        await client.describeSchemes();
        expect(client.schemes.get('previous')).toBe(view);
        client.destroy();
    });

    it('keeps one object for the primary key when the view predates the inventory', async () => {
        const client = new EzClassifyClient(BASE, {
            contextId: 'records',
            contextVersion: '1.2.3',
            heartbeat: false,
        });

        const early = client.schemes.get('current');
        await client.describeSchemes();

        expect(client.schemes.get('current')).toBe(early);
        client.destroy();
    });

    it('rebuilds every held scheme when the alias moves, and drops one the Context no longer holds', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        const client = await connect('latest');
        const view = client.schemes.get('previous');
        expect(view.getSchemeMeta().id).toBe('levels-legacy');

        state.version = '1.3.0';
        await client.scheme.process('A').catch(() => undefined);
        await client._settleProfileRewarm();

        const rebuilt = urls().filter(
            (url) =>
                new URL(url).pathname.startsWith(
                    '/v1/ctx/records/1.3.0/scheme',
                ) && schemeParam(url) === 'previous',
        );
        expect(rebuilt).toHaveLength(7);

        // The next version no longer holds `previous`: its view stops answering
        // rather than keep reading the composition it came from.
        state.version = '1.4.0';
        state.schemes = [HELD[0]!];
        await client.scheme.process('A').catch(() => undefined);
        await client._settleProfileRewarm();

        expect(() => view.getScheme()).toThrow(/No profile cached/);
        expect(client.schemes.get('previous')).toBe(view);
        await expect(view.process('A')).rejects.toMatchObject({
            status: 404,
            code: 'scheme_not_found',
        });
        expect(client.scheme.getSchemeMeta().id).toBe('levels');
        warn.mockRestore();
        client.destroy();
    });

    it('keeps the primary key on its scheme when the alias makes another scheme primary', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        const client = await connect('latest');
        const view = client.schemes.get('current');

        state.version = '1.3.0';
        state.schemes = [
            { ...HELD[1]!, roles: ['primary'] },
            { ...HELD[0]!, roles: ['crosswalk-source'] },
        ];
        await client.scheme.process('A').catch(() => undefined);
        await client._settleProfileRewarm();
        fetchMock.mockClear();

        const answer = await view.render([]);
        const fromPrimary = await client.scheme.render([]);

        expect(answer.rendered).toBe('from current');
        expect(fromPrimary.rendered).toBe('from primary');
        expect(schemeParam(urls()[0]!)).toBe('current');
        expect(client.schemes.get('current')).toBe(view);
        expect(view.getSchemeMeta().id).toBe('levels');
        warn.mockRestore();
        client.destroy();
    });

    it('gives a view the primary profile when the alias moves its key to primary', async () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        const client = await connect('latest');
        const view = client.schemes.get('previous');

        state.version = '1.3.0';
        state.schemes = [
            { ...HELD[1]!, roles: ['primary'] },
            { ...HELD[0]!, roles: ['additional'] },
        ];
        await client.scheme.process('A').catch(() => undefined);
        await client._settleProfileRewarm();

        expect(client.schemes.get('previous')).toBe(view);
        expect(view.getSchemeMeta().id).toBe(client.scheme.getSchemeMeta().id);
        warn.mockRestore();
        client.destroy();
    });
});
