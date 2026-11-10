/* eslint-disable @typescript-eslint/no-explicit-any -- these specs assert the
shape of the public contract and reach past it on purpose, which src/ may not
do. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
    CollectedNotice,
    ContextAdapter,
    ExplanationTrace,
    ProcessResult,
    SuggestResultsByCategory,
    ValidateResult,
    RemoteContextAdapter,
    RemoteContextSchemeEngineAdapter,
    RemoteGuideEngineAdapter,
    RemoteAccessEngineAdapter,
    GuideMetaView,
    ProcessingRole,
} from '@ezclassify/types';
import { isContextAdapter } from '@ezclassify/types';
import { EzClassifyClient } from '../src/ezclassify-client';
import { connectContext } from '../src/connect';
import type * as entry from '../src/index';
import type {
    ContextComponentRef,
    ContextDescription,
    PingResult,
} from '../src/ezclassify-client';
import type {
    CtxComponentDescriptor,
    CtxDescribeResponseBody,
    HealthResponseBody,
} from '@ezclassify/openapi/wire';

/**
 * `true` only when `A` and `B` are the same type, optional and nullable members
 * included. Mutual assignability is not enough: it lets an optional member
 * exist on one side only.
 */
type Same<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;

/**
 * Type-level contract check: EzClassifyClient must implement the remote Context
 * contract, and its marking sub-object must implement the Context-bound remote
 * marking contract. The generic scheme adapter retains local composition
 * lifecycle and selector overloads that do not exist on the Context REST
 * surface.
 *
 * `npm run typecheck` compiles this file through `tsconfig.contract.json`,
 * which is the only reason the assignments here pin anything: `tsconfig.json`
 * covers `src/` alone, so a type-level assertion in any other test file is
 * transpiled by Vitest and never checked.
 */

const minimalProfile = {
    id: 'contract-test',
    version: '1.0.0',
    name: 'Contract Test',
    description: '',
    concepts: [
        {
            id: 'ROOT',
            name: 'Root',
            views: { default: 'R' },
            categories: ['level'],
            parents: [],
            aliases: [],
            position: 0,
        },
        {
            id: 'CHILD',
            name: 'Child',
            views: { default: 'C' },
            categories: ['level'],
            parents: ['ROOT'],
            aliases: [],
            position: 1,
        },
    ],
    categories: [
        {
            id: 'level',
            label: 'Level',
            required: false,
            single: false,
            rollup: 'union',
            position: 0,
        },
    ],
    tokens: [],
    normalize: [],
    rollupPipelines: [],
    formats: [
        {
            id: 'default',
            categoryOrder: ['level'],
            separator: '//',
            categorySeparator: '//',
            view: 'default',
        },
    ],
    defaultRenderFormat: 'default',
    parse: { separator: '//', caseSensitive: false, stripWhitespace: true },
} as any;

describe('RemoteContextAdapter contract: EzClassifyClient', () => {
    it('EzClassifyClient satisfies RemoteContextAdapter at compile time', () => {
        const client = new EzClassifyClient('http://localhost:0');
        const contextAdapter: RemoteContextAdapter = client;
        expect(typeof contextAdapter.audit).toBe('function');
        expect(typeof contextAdapter.translate).toBe('function');
        expect(typeof contextAdapter.scheme.suggestForCategories).toBe(
            'function',
        );
    });

    it('the family sub-objects satisfy their Remote narrowings at compile time', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // These are the properties a UI reaches for through ContextAdapter, so
        // a member added to a family contract has to land on the corresponding
        // family sub-object, not merely on an unrelated top-level delegate.
        const scheme: RemoteContextSchemeEngineAdapter = client.scheme;
        const guide: RemoteGuideEngineAdapter = client.guide;
        const access: RemoteAccessEngineAdapter = client.access;
        expect(typeof scheme.suggestForCategories).toBe('function');
        expect(typeof scheme.listCategoriesFlat).toBe('function');
        expect(typeof guide.evaluateMany).toBe('function');
        expect(typeof guide.buildGuideViews).toBe('function');
        expect(typeof access.describeAllAccessRules).toBe('function');
        expect(typeof access.listAccessRuleIds).toBe('function');
    });

    it('declares its own wire views with the OpenAPI component types', () => {
        // The operation results are the contract's own types. These three are
        // the client's, so the compiler holds them to the component each one
        // reads: same members, same optionality, same nullability.
        const componentRef: Same<ContextComponentRef, CtxComponentDescriptor> =
            true;
        // The description normalizes the collections the wire omits into
        // empty arrays and adds `layers`; every other member is the wire's.
        const description: Same<
            Omit<ContextDescription, 'layers' | 'guides' | 'crosswalks'>,
            Omit<CtxDescribeResponseBody, 'guides' | 'crosswalks'>
        > = true;
        const collections: Same<
            Pick<ContextDescription, 'guides' | 'crosswalks'>,
            Required<Pick<CtxDescribeResponseBody, 'guides' | 'crosswalks'>>
        > = true;
        const ping: Same<
            PingResult,
            Pick<HealthResponseBody, 'engineVersion' | 'engineSha' | 'gitTag'>
        > = true;
        expect([componentRef, description, collections, ping]).toEqual([
            true,
            true,
            true,
            true,
        ]);
    });

    it('answers the composition accessors with the shapes the base contract types', () => {
        const client = new EzClassifyClient('http://localhost:0', {
            contextId: 'records',
            contextVersion: '1.2.3',
        });
        client._contextDescription = {
            id: 'records',
            version: '1.2.3',
            scheme: {
                id: 'levels',
                version: '2.0.0',
                resolvedVersion: '2.0.0',
            },
            layers: [],
            guides: [{ id: 'g1', version: 'latest', resolvedVersion: '3.1.0' }],
            crosswalks: [],
            schemes: [
                {
                    selector: 'levels',
                    id: 'levels',
                    version: '2.0.0',
                    roles: ['primary'],
                },
            ],
        };
        // Both are base-contract members typed as plain values, not Promises
        // and not throwing accessors: a UI reads them without knowing whether
        // the adapter it holds is local or remote.
        const schemeId: string = client.access.schemeId;
        const meta: GuideMetaView[] = client.guide.listGuideMeta();
        const one: GuideMetaView | undefined = client.guide.getGuideMeta('g1');
        expect(schemeId).toBe('levels');
        expect(meta).toEqual([]);
        expect(one).toBeUndefined();
    });

    it('declares the marking options a caller may send, not only forwards them', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // These are never called: an options bag reaches the wire by spread, so
        // only the compiler can tell whether the client declares the option or
        // merely passes an unknown one along. An excess-property error here is
        // the point.
        const gated = (): Promise<unknown> =>
            client.scheme.suggest('', { includeGated: true });
        const batched = (): Promise<unknown> =>
            client.scheme.suggestForCategories([], ['level'], {
                outputFormat: 'banner',
                surface: 'portion',
            });
        const translated = (): Promise<unknown> =>
            client.translate({ crosswalkId: 'x', marking: 'HIGH' });
        expect(
            [gated, batched, translated].every((f) => typeof f === 'function'),
        ).toBe(true);
    });

    it('declares the notices list on every result that describes a marking', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // Never called. The contract carries the collected notices on the
        // result itself so a caller does not take a second round trip for
        // them, and only the compiler can tell whether this client declares
        // the member or leaves a caller to widen the type to reach it.
        const processed = async (): Promise<CollectedNotice[]> =>
            (await client.scheme.process('HIGH')).notices;
        const validated = async (): Promise<CollectedNotice[]> =>
            (await client.scheme.validate('HIGH')).notices;
        const rolledUp = async (): Promise<CollectedNotice[]> =>
            (await client.scheme.aggregate(['HIGH'])).notices;
        const scanned = async (): Promise<CollectedNotice[]> =>
            (await client.scheme.scan('a document')).results[0].result.notices;
        expect(
            [processed, validated, rolledUp, scanned].every(
                (f) => typeof f === 'function',
            ),
        ).toBe(true);
    });

    it("splits the reader's call from the author's, on both surfaces", () => {
        const client = new EzClassifyClient('http://localhost:0');
        // Never called. What each operation takes and answers is the whole
        // of the change, and only the compiler can hold the client to it: a
        // refused option still reaches the wire by spread if it is merely
        // forwarded, and a widened return type reads fine at runtime.
        const authored = (): Promise<ProcessResult> =>
            client.scheme.process('high', {
                assertions: [],
                outputs: ['marking/short'],
                suggestFor: ['level'],
            });
        const authoredTop = (): Promise<ProcessResult> =>
            client.process('high', { outputs: [], suggestFor: [] });
        const readText = (): Promise<ValidateResult> =>
            client.scheme.validate('HIGH', {
                context: { role: 'part' },
                parts: ['(H)'],
            });
        const readFacts = (): Promise<ValidateResult> =>
            client.validate([], { surface: 'portion' });
        const explained = (): Promise<ExplanationTrace> =>
            client.scheme.explain([], { assertions: [], parts: [] });
        const explainedTop = (): Promise<ExplanationTrace> =>
            client.explain('HIGH');
        const preset = (): Promise<ValidateResult> =>
            client.scheme.applyPreset('default-label');
        const byCategory = (): Promise<SuggestResultsByCategory> =>
            client.scheme.suggestForCategories([], ['level']);
        const scanned = async (): Promise<ValidateResult> =>
            (await client.scheme.scan('a document')).results[0].result;

        const refused = [
            // @ts-expect-error a reader names no outputs; renders are process's.
            () => client.scheme.validate('HIGH', { outputs: ['x'] }),
            // @ts-expect-error validate takes the marking as its operand only.
            () => client.validate('HIGH', { assertions: [] }),
            // @ts-expect-error picker options only add to a process result.
            () => client.scheme.explain('HIGH', { suggestFor: ['level'] }),
            // @ts-expect-error suggest takes text or facts; both is process's.
            () => client.scheme.suggest('H', { assertions: [] }),
            // @ts-expect-error suggest takes text or facts; both is process's.
            () => client.suggest('H', { assertions: [] }),
            async () =>
                // @ts-expect-error a reader's result carries no fix paths.
                (await client.scheme.validate('HIGH')).proposedFixes,
        ];
        expect(
            [
                authored,
                authoredTop,
                readText,
                readFacts,
                explained,
                explainedTop,
                preset,
                byCategory,
                scanned,
                ...refused,
            ].every((f) => typeof f === 'function'),
        ).toBe(true);
    });

    it('types the role recognition decided and the role each view states', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // Never called. For a scheme that declares surfaces both are the
        // server's answer, and only the compiler can tell whether a caller
        // reaches them without widening the types this client returns.
        const readAs = async (): Promise<ProcessingRole | undefined> =>
            (await client.scheme.validate('HIGH')).recognition?.role;
        const writtenAs = async (): Promise<ProcessingRole | undefined> =>
            (await client.scheme.process('HIGH')).recognition?.role;
        const viewRole = (): ProcessingRole | undefined =>
            client.getSchemeMeta().formats?.[0]?.role;
        expect(
            [readAs, writtenAs, viewRole].every((f) => typeof f === 'function'),
        ).toBe(true);
    });

    it('re-exports the marking result types from its entry point', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // Never called. A consumer types what these calls answer by importing
        // from this package; a result type the index leaves out sends it to
        // @ezclassify/types for that one name.
        const pinned = [
            (): Promise<entry.ValidateResult> => client.scheme.validate('HIGH'),
            (): Promise<entry.ProcessResult> => client.scheme.process('HIGH'),
            (): Promise<entry.ExplanationTrace> =>
                client.scheme.explain('HIGH'),
            (): Promise<entry.AggregateResult> =>
                client.scheme.aggregate(['HIGH']),
            (): Promise<entry.ScanOutcome> => client.scheme.scan('a document'),
            (): Promise<entry.SuggestResult> => client.scheme.suggest('HIGH'),
            (): Promise<entry.SuggestResultsByCategory> =>
                client.scheme.suggestForCategories([], ['level']),
        ];
        expect(pinned.every((f) => typeof f === 'function')).toBe(true);
    });

    it('declares the validation surface on the three ops that evaluate one', () => {
        const client = new EzClassifyClient('http://localhost:0');
        // Same reasoning as the options test above: surface reaches the wire
        // by spread whether or not it is declared, so only the compiler can
        // tell that a caller is allowed to name a surface here. process,
        // validate and aggregate are the three that evaluate against one.
        const processed = (): Promise<unknown> =>
            client.scheme.process('HIGH', { surface: 'portion' });
        const validated = (): Promise<unknown> =>
            client.scheme.validate('HIGH', { surface: 'portion' });
        const rolledUp = (): Promise<unknown> =>
            client.scheme.aggregate(['HIGH'], { surface: 'portion' });
        const rolledUpLossless = (): Promise<unknown> =>
            client.scheme.aggregateAssertions([[]], { surface: 'portion' });
        expect(
            [processed, validated, rolledUp, rolledUpLossless].every(
                (f) => typeof f === 'function',
            ),
        ).toBe(true);
    });

    it('is narrowed to the composed surface by the structural guard', () => {
        const client = new EzClassifyClient('http://localhost:0');
        const injected: ContextAdapter = client;
        expect(isContextAdapter(injected)).toBe(true);
        if (!isContextAdapter(injected)) throw new Error('unreachable');
        expect(typeof injected.checkContextAccess).toBe('function');
    });

    it('EzClassifyClient.getConceptsInCategory returns nested depths from the cached profile', () => {
        const client = new EzClassifyClient('http://localhost:0');
        (client as unknown as { _profile: unknown })._profile = minimalProfile;
        const nested = client.getConceptsInCategory('level', { nested: true });
        expect(nested).toEqual([
            { concept: expect.objectContaining({ id: 'ROOT' }), depth: 0 },
            { concept: expect.objectContaining({ id: 'CHILD' }), depth: 1 },
        ]);
        const flat = client.getConceptsInCategory('level');
        expect(flat.map((c: any) => c.id)).toEqual(['ROOT', 'CHILD']);
    });
});

describe('connectContext', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    it('refuses a connection that names no Context before sending anything', async () => {
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy as any;

        await expect(
            connectContext({
                baseUrl: 'https://api.example.com',
                contextVersion: '1.0.0',
            } as unknown as Parameters<typeof connectContext>[0]),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects when the server is unavailable', async () => {
        globalThis.fetch = vi
            .fn()
            .mockRejectedValue(new TypeError('Network failure')) as any;

        await expect(
            connectContext({
                baseUrl: 'https://api.example.com',
                contextId: 'ctx-1',
                contextVersion: '1.0.0',
            }),
        ).rejects.toThrow(/Network error/);
    });
});
