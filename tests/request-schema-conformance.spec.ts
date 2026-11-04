/**
 * Request-shape gate.
 *
 * Every client call that sends a body is driven through the real client with
 * every optional argument supplied, and the body it puts on the wire is
 * validated against that operation's request schema in the vendored contract
 * (vendor/spec/openapi.yaml). The request schemas close their objects
 * (`additionalProperties: false`), so a field the contract renamed or removed
 * fails here instead of as a 400 from a live server.
 *
 * `openapi-contract.spec.ts` validates bodies too, but mostly for calls made
 * with their defaults, so an option the contract does not declare never reached
 * it. The cases below also write out each call's full option set next to the
 * schema it must satisfy, which is where a missing option such as
 * `validate()`'s `inputFormat` and `outputFormat` shows up in review.
 *
 * The same cases also prove the client can set every field the contract
 * declares. Each case supplies every option its call takes, so a top-level
 * field a request schema declares that no case sends is a field the client has
 * no option for, and the coverage check names it by route.
 *
 * AJV validates the OpenAPI 3.1 schemas as JSON Schema 2020-12. Unknown schema
 * keywords fail compilation rather than leaving request checks incomplete.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    Assertion,
    GuideDeterminationInput,
    ProcessingContext,
} from '@ezclassify/types';
import {
    EzClassifyClient,
    type ContextDescription,
} from '../src/ezclassify-client';

// ---------------------------------------------------------------------------
// Contract request schemas and a fail-closed validator
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Schema = boolean | JsonObject;

const CTX_PREFIX = '/v1/ctx/{ctxId}/{version}/';
const SCHEMA_URI = 'https://ezclassify.test/request-schemas';

// js-yaml ships no type declarations. Loading it through require with the one
// signature used here keeps this file inside the typechecked set (see
// tsconfig.contract.json) without adding a types package.
const yaml = createRequire(import.meta.url)('js-yaml') as {
    load(text: string): unknown;
};

function isObject(value: Json | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function show(value: Json | undefined): string {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

class OpenApiRequestSchemas {
    private readonly components: Record<string, Schema>;
    private readonly ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        // Schema predicates such as `if: {properties: ...}` intentionally omit
        // `type`; JSON Schema still evaluates their surrounding object schema.
        strictTypes: false,
        // A `not: {required: [...]}` predicate forbids a field declared by its
        // enclosing union, rather than redeclaring properties inside `not`.
        strictRequired: false,
    });
    private readonly validators = new Map<Schema, ValidateFunction>();
    private nextSchemaId = 0;
    private readonly requestSchemas = new Map<string, Schema>();
    /** Declared query parameter names, keyed `method path-template`. */
    private readonly queryParameters = new Map<string, Set<string>>();

    constructor(specPath: string) {
        const root = yaml.load(readFileSync(specPath, 'utf-8')) as JsonObject;
        const components = (root.components as JsonObject | undefined)?.schemas;
        if (!isObject(components)) {
            throw new Error('The vendored spec has no components.schemas.');
        }
        this.components = components as Record<string, Schema>;
        this.ajv.addKeyword('example');
        // Register the original components under their OpenAPI fragment URIs.
        // AJV resolves local references there without changing literal data.
        for (const [name, schema] of Object.entries(this.components)) {
            this.ajv.addSchema(
                schema,
                `${SCHEMA_URI}#/components/schemas/${name}`,
            );
        }
        for (const [path, item] of Object.entries(root.paths as JsonObject)) {
            for (const [method, operation] of Object.entries(
                item as JsonObject,
            )) {
                const schema = (
                    (
                        (
                            (operation as JsonObject | null)?.requestBody as
                                JsonObject | undefined
                        )?.content as JsonObject | undefined
                    )?.['application/json'] as JsonObject | undefined
                )?.schema;
                if (isObject(schema)) {
                    this.requestSchemas.set(`${method} ${path}`, schema);
                }
                const parameters = (operation as JsonObject | null)?.parameters;
                this.queryParameters.set(
                    `${method} ${path}`,
                    new Set(
                        (Array.isArray(parameters) ? parameters : [])
                            .filter(
                                (parameter): parameter is JsonObject =>
                                    isObject(parameter) &&
                                    parameter.in === 'query',
                            )
                            .map((parameter) => String(parameter.name)),
                    ),
                );
            }
        }
        if (this.requestSchemas.size === 0) {
            throw new Error(
                'Read no request schemas out of vendor/spec/openapi.yaml.',
            );
        }
    }

    /**
     * The query parameter names the contract declares for the operation a
     * concrete request path addresses. Throws when no operation matches, so a
     * request to a route the contract does not have fails loudly.
     */
    declaredQueryParameters(method: string, requestPath: string): Set<string> {
        for (const [key, names] of this.queryParameters) {
            const [operationMethod, template] = key.split(' ') as [
                string,
                string,
            ];
            if (operationMethod !== method.toLowerCase()) continue;
            const pattern = new RegExp(
                `^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`,
            );
            if (pattern.test(requestPath)) return names;
        }
        throw new Error(
            `The contract declares no ${method.toUpperCase()} operation for ${requestPath}.`,
        );
    }

    /** `method path` for every operation the contract gives a request body. */
    get operationsWithBodies(): string[] {
        return [...this.requestSchemas.keys()];
    }

    /**
     * Top-level property names an operation's request schema declares. Follows
     * `$ref` and the `anyOf` and `if`/`then`/`else` branches, so a field
     * declared on any branch counts.
     */
    declaredProperties(method: string, path: string): Set<string> {
        const root = this.requestSchemas.get(`${method} ${path}`);
        if (root === undefined) {
            throw new Error(
                `The contract declares no request body for ${method.toUpperCase()} ${path}.`,
            );
        }
        const names = new Set<string>();
        const pending: Schema[] = [root];
        while (pending.length > 0) {
            const schema = pending.pop()!;
            if (typeof schema === 'boolean') continue;
            if (typeof schema.$ref === 'string') {
                pending.push(this.resolve(schema.$ref));
            }
            if (isObject(schema.properties)) {
                for (const name of Object.keys(schema.properties)) {
                    names.add(name);
                }
            }
            if (Array.isArray(schema.anyOf)) {
                pending.push(...(schema.anyOf as Schema[]));
            }
            for (const key of ['then', 'else'] as const) {
                if (schema[key] !== undefined) {
                    pending.push(schema[key] as Schema);
                }
            }
        }
        return names;
    }

    /** One message per violation; empty when the body is valid. */
    validate(method: string, path: string, body: Json | undefined): string[] {
        const schema = this.requestSchemas.get(`${method} ${path}`);
        if (schema === undefined) {
            throw new Error(
                `The contract declares no request body for ${method.toUpperCase()} ${path}.`,
            );
        }
        let validate = this.validators.get(schema);
        if (!validate) {
            const reference = `${SCHEMA_URI}#/request-bodies/${this.nextSchemaId++}`;
            this.ajv.addSchema(schema, reference);
            validate = this.ajv.compile({ $ref: reference });
            this.validators.set(schema, validate);
        }
        if (validate(body)) return [];
        return (validate.errors ?? []).map((error) => {
            const field =
                error.keyword === 'additionalProperties'
                    ? ` property '${error.params.additionalProperty}'`
                    : '';
            return `${error.instancePath || '$'}:${field} ${error.message}`;
        });
    }

    private resolve(reference: string): Schema {
        const prefix = '#/components/schemas/';
        if (!reference.startsWith(prefix)) {
            throw new Error(`Unsupported $ref '${reference}'.`);
        }
        const target = this.components[reference.slice(prefix.length)];
        if (target === undefined) {
            throw new Error(`Unresolved $ref '${reference}'.`);
        }
        return target;
    }
}

const specPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../vendor/spec/openapi.yaml',
);
const spec = new OpenApiRequestSchemas(specPath);

// ---------------------------------------------------------------------------
// Client and captured requests
// ---------------------------------------------------------------------------

type Captured = {
    method: string;
    path: string;
    /** Names of the query parameters the request carried, in order sent. */
    query: string[];
    body: Json | undefined;
};

const originalFetch = globalThis.fetch;

/**
 * Record every request and answer it with an empty Context envelope. Most
 * result parsers reject the empty result; only the request matters here.
 */
function captureRequests(): Captured[] {
    const captured: Captured[] = [];
    globalThis.fetch = vi.fn(
        async (url: string | URL, init: RequestInit = {}) => {
            const parsed = new URL(url.toString());
            captured.push({
                method: (init.method ?? 'GET').toUpperCase(),
                path: parsed.pathname,
                query: [...parsed.searchParams.keys()],
                body:
                    typeof init.body === 'string'
                        ? (JSON.parse(init.body) as Json)
                        : undefined,
            });
            return {
                ok: true,
                status: 200,
                text: async () =>
                    JSON.stringify({
                        resolution: {
                            contextId: 'acme-marking',
                            resolvedVersion: '1.0.0',
                            artifacts: [],
                            sources: [],
                        },
                        result: {},
                        operationLimitations: [],
                    }),
            } as Response;
        },
    ) as typeof fetch;
    return captured;
}

function makeClient(): EzClassifyClient {
    return new EzClassifyClient('http://api.test', {
        contextId: 'acme-marking',
        contextVersion: '1.0.0',
        disableCache: true,
    });
}

// ---------------------------------------------------------------------------
// One case per body-sending client call, every option set
// ---------------------------------------------------------------------------

const level: Assertion = {
    categoryId: 'level',
    conceptId: 'HIGH',
    confidence: 'certain',
    source: 'parse',
    value: 'H',
};

const partOf: ProcessingContext = {
    role: 'part',
    partOf: { rendered: 'H', assertions: [level] },
};

const determinations: GuideDeterminationInput = {
    findings: [
        {
            findingId: 'finding-1',
            documentDigest: 'sha256:abc',
            decision: 'accepted',
            reason: 'Confirmed by analyst',
            proposalOrigin: 'analyst-authored',
        },
    ],
    manualSelections: [],
};

const signal = new AbortController().signal;

/**
 * Route suffix under the Context prefix, and the call. Each call supplies every
 * optional argument it takes, so the whole option surface reaches the wire. The
 * `client.*` delegates declare their own option types, so they get cases of
 * their own beside the family surfaces they forward to.
 */
const CASES: Record<
    string,
    [route: string, call: (c: EzClassifyClient) => Promise<unknown>]
> = {
    'scheme.process': [
        'scheme/process',
        (c) =>
            c.scheme.process('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                assertions: [level],
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                outputs: ['classification/portion', 'classification/banner'],
                suggestFor: ['level', 'audience'],
                signal,
            }),
    ],
    'scheme.process-assertions': [
        'scheme/process',
        (c) =>
            c.scheme.process([level], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                outputs: ['classification/portion'],
                suggestFor: ['audience'],
            }),
    ],
    'scheme.validate': [
        'scheme/validate',
        (c) =>
            c.scheme.validate('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    // Facts as stated go out as `assertions` with no `input` beside them,
    // and with no `inputFormat`, which the server refuses without text.
    'scheme.validate-assertions': [
        'scheme/validate',
        (c) =>
            c.scheme.validate([level], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    'scheme.explain': [
        'scheme/explain',
        (c) =>
            c.scheme.explain('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                assertions: [level],
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    'scheme.explain-assertions': [
        'scheme/explain',
        (c) =>
            c.scheme.explain([level], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
            }),
    ],
    'scheme.suggest': [
        'scheme/suggest',
        (c) =>
            c.scheme.suggest('H//', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                filter: 'aud',
                surface: 'portion',
                includeGated: true,
                signal,
            }),
    ],
    'scheme.suggest-assertions': [
        'scheme/suggest',
        (c) =>
            c.scheme.suggest([level], {
                outputFormat: 'banner',
                filter: 'aud',
                surface: 'portion',
                includeGated: true,
            }),
    ],
    'scheme.suggest-for-categories': [
        'scheme/suggest-for-categories',
        (c) =>
            c.scheme.suggestForCategories([level], ['level', 'audience'], {
                outputFormat: 'banner',
                surface: 'portion',
                signal,
            }),
    ],
    'scheme.aggregate': [
        'scheme/aggregate',
        (c) =>
            c.scheme.aggregate(['H', 'L'], {
                inputFormat: 'portion',
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                signal,
            }),
    ],
    'scheme.aggregate-assertions': [
        'scheme/aggregate',
        (c) =>
            c.scheme.aggregateAssertions([[level]], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                signal,
            }),
    ],
    'scheme.scan': [
        'scheme/scan',
        (c) =>
            c.scheme.scan('text H text', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                onProgress: () => {},
                signal,
            }),
    ],
    'scheme.render': [
        'scheme/render',
        (c) =>
            c.scheme.render([level], 'banner', {
                preservation: 'full',
                signal,
            }),
    ],
    'scheme.normalize': [
        'scheme/normalize',
        (c) =>
            c.scheme.normalize('h', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                signal,
            }),
    ],
    'scheme.check-coverage': [
        'scheme/check-coverage',
        (c) =>
            c.scheme.checkCoverage(['L'], 'H', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                signal,
            }),
    ],
    'scheme.diff': [
        'scheme/diff',
        (c) => c.scheme.diff('H', 'L', { inputFormat: 'portion', signal }),
    ],
    'scheme.filter-concepts': [
        'scheme/filter-concepts',
        (c) => c.scheme.filterConcepts('hi'),
    ],
    'scheme.notices': [
        'scheme/notices',
        (c) => c.scheme.collectNotices([level]),
    ],
    'scheme.view': ['scheme/view', (c) => c.scheme.buildSchemeView()],
    'scheme.apply-preset': [
        'scheme/apply-preset',
        (c) =>
            c.scheme.applyPreset('default-label', { outputFormat: 'banner' }),
    ],
    'guide.scan': ['guide/scan', (c) => c.guide.scan('secret text', 'g1')],
    'guide.evaluate': ['guide/evaluate', (c) => c.guide.evaluate('g1', ['r1'])],
    'guide.evaluateMany': [
        'guide/evaluate',
        (c) => c.guide.evaluateMany(['r1']),
    ],
    'guide.filter-rules': [
        'guide/filter-rules',
        (c) => c.guide.filterRules('sec', 'g1'),
    ],
    'guide.describe-rule': [
        'guide/describe-rule',
        (c) => c.guide.describeRule('r1', 'g1'),
    ],
    'guide.view': ['guide/view', (c) => c.guide.buildGuideView('g1')],
    'access.check': [
        'access/check',
        (c) =>
            c.access.check([level], { clearance: 'high' }, { project: 'p1' }),
    ],
    'access.describe-rule': [
        'access/describe-rule',
        (c) => c.access.describeAccessRule('rule-1'),
    ],
    'access.describe-requirements': [
        'access/describe-requirements',
        (c) =>
            c.access.describeAccessRequirements({
                marking: 'H',
                assertions: [level],
            }),
    ],
    'context.check-access-marking': [
        'access/check',
        (c) =>
            c.context.checkAccess(
                'H',
                { clearance: 'high' },
                { project: 'p1' },
            ),
    ],
    'context.check-access-assertions': [
        'access/check',
        (c) =>
            c.context.checkAccess(
                [level],
                { clearance: 'high' },
                { project: 'p1' },
            ),
    ],
    'context.access-requirements': [
        'access/describe-requirements',
        (c) =>
            c.context.accessRequirements({ marking: 'H', assertions: [level] }),
    ],
    'context.translate-marking': [
        'crosswalk/translate',
        (c) => c.context.translate({ crosswalkId: 'cw-1', marking: 'H' }),
    ],
    'context.translate-assertions': [
        'crosswalk/translate',
        (c) => c.context.translate({ crosswalkId: 'cw-1', marking: [level] }),
    ],
    'context.audit': [
        'document/audit',
        (c) =>
            c.context.audit({
                text: 'document text',
                guideDeterminations: determinations,
                responseProfile: 'full',
            }),
    ],

    // Client-level delegates.
    'client.process': [
        'scheme/process',
        (c) =>
            c.process('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                assertions: [level],
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                outputs: ['classification/portion'],
                suggestFor: ['audience'],
                signal,
            }),
    ],
    'client.validate': [
        'scheme/validate',
        (c) =>
            c.validate('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    'client.validate-assertions': [
        'scheme/validate',
        (c) =>
            c.validate([level], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    'client.explain': [
        'scheme/explain',
        (c) =>
            c.explain('H//A', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                assertions: [level],
                context: partOf,
                surface: 'portion',
                parts: ['H//A', 'L'],
                signal,
            }),
    ],
    'client.suggest': [
        'scheme/suggest',
        (c) =>
            c.suggest('H//', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                filter: 'aud',
                surface: 'portion',
                includeGated: true,
                signal,
            }),
    ],
    'client.suggest-for-categories': [
        'scheme/suggest-for-categories',
        (c) =>
            c.suggestForCategories([level], ['level'], {
                outputFormat: 'banner',
                surface: 'portion',
                signal,
            }),
    ],
    'client.aggregate': [
        'scheme/aggregate',
        (c) =>
            c.aggregate(['H', 'L'], {
                inputFormat: 'portion',
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                signal,
            }),
    ],
    'client.aggregate-assertions': [
        'scheme/aggregate',
        (c) =>
            c.aggregateAssertions([[level]], {
                outputFormat: 'banner',
                context: partOf,
                surface: 'portion',
                signal,
            }),
    ],
    'client.scan': [
        'scheme/scan',
        (c) =>
            c.scan('text H text', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                signal,
            }),
    ],
    'client.render': [
        'scheme/render',
        (c) => c.render([level], 'banner', { preservation: 'full', signal }),
    ],
    'client.normalize': [
        'scheme/normalize',
        (c) =>
            c.normalize('h', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                signal,
            }),
    ],
    'client.check-coverage': [
        'scheme/check-coverage',
        (c) =>
            c.checkCoverage(['L'], 'H', {
                inputFormat: 'portion',
                outputFormat: 'banner',
                signal,
            }),
    ],
    'client.diff': [
        'scheme/diff',
        (c) => c.diff('H', 'L', { inputFormat: 'portion', signal }),
    ],
    'client.filter-concepts': [
        'scheme/filter-concepts',
        (c) => c.filterConcepts('hi'),
    ],
    'client.notices': ['scheme/notices', (c) => c.collectNotices([level])],
    'client.view': ['scheme/view', (c) => c.buildSchemeView()],
    'client.apply-preset': [
        'scheme/apply-preset',
        (c) => c.applyPreset('default-label', { outputFormat: 'banner' }),
    ],
    'client.check-context-access': [
        'access/check',
        (c) =>
            c.checkContextAccess('H', { clearance: 'high' }, { project: 'p1' }),
    ],
    'client.access-requirements': [
        'access/describe-requirements',
        (c) => c.accessRequirements({ marking: 'H', assertions: [level] }),
    ],
    'client.translate': [
        'crosswalk/translate',
        (c) => c.translate({ crosswalkId: 'cw-1', marking: 'H' }),
    ],
    'client.audit': [
        'document/audit',
        (c) =>
            c.audit({
                text: 'document text',
                guideDeterminations: determinations,
                responseProfile: 'full',
            }),
    ],
};

/**
 * Drive one case through the real client and return the single request it sent.
 * The stub answers with an empty result, which most parsers reject, so a throw
 * from the call is expected and ignored; the request is what matters.
 */
async function send(name: string): Promise<Captured> {
    const [, call] = CASES[name];
    const captured = captureRequests();
    try {
        await call(makeClient());
    } catch {
        // See above: only the request matters.
    }
    expect(captured, `${name} request count`).toHaveLength(1);
    return captured[0];
}

/**
 * Routes whose request schema declares a top-level field that no case sends, as
 * `route: field, field`. Each case supplies every option its call takes, so a
 * declared field no case sends is a field the client has no option for.
 */
function unsentContractFields(sent: Map<string, Set<string>>): string[] {
    const unsent: string[] = [];
    for (const [route, keys] of [...sent].sort(([a], [b]) =>
        a.localeCompare(b),
    )) {
        const missing = [...spec.declaredProperties('post', CTX_PREFIX + route)]
            .filter((name) => !keys.has(name))
            .sort();
        if (missing.length > 0) unsent.push(`${route}: ${missing.join(', ')}`);
    }
    return unsent;
}

describe('request bodies conform to the contract request schemas', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it.each(Object.keys(CASES))('%s', async (name) => {
        const [route] = CASES[name];
        const { method, path, query, body } = await send(name);
        expect(method).toBe('POST');
        expect(path).toBe(`/v1/ctx/acme-marking/1.0.0/${route}`);
        // Requests are closed: an undeclared query parameter is a 400, so a
        // body operation that declares none must go out without a query.
        expect(
            query.filter(
                (name) => !spec.declaredQueryParameters(method, path).has(name),
            ),
            `${name} sent query parameters the contract does not declare`,
        ).toEqual([]);

        const errors = spec.validate('post', CTX_PREFIX + route, body);
        expect(
            errors,
            `${name} sent a body the contract rejects:\n  ${show(body)}`,
        ).toEqual([]);
    });

    it('covers every contract operation that takes a request body', () => {
        const covered = new Set(
            Object.values(CASES).map(([route]) => `post ${CTX_PREFIX}${route}`),
        );
        const missing = spec.operationsWithBodies.filter(
            (op) => !covered.has(op),
        );
        expect(missing, 'no request-schema case for these operations').toEqual(
            [],
        );
    });

    // Without this, the contract can add an option and the client can ship
    // without a way to set it while every body it does send still validates.
    it('every contract request property reaches the wire', async () => {
        const sent = new Map<string, Set<string>>();
        for (const [name, [route]] of Object.entries(CASES)) {
            const { body } = await send(name);
            const keys = sent.get(route) ?? new Set<string>();
            if (isObject(body)) {
                for (const key of Object.keys(body)) keys.add(key);
            }
            sent.set(route, keys);
        }
        expect(
            unsentContractFields(sent),
            'the client never sends these contract fields',
        ).toEqual([]);
    });
});

/**
 * Every GET the client makes, each called with every option it takes. Requests
 * are closed, so the query string of each must hold only parameters the
 * operation declares; the contract says which.
 */
const GET_CALLS: Record<
    string,
    (client: EzClassifyClient) => Promise<unknown>
> = {
    'ping': (c) => c.ping(),
    'listContexts': (c) => c.listContexts(),
    'listContextVersions': (c) => c.listContextVersions('acme-marking'),
    'describeContext': (c) => c.describeContext(),
    'profile resources': (c) =>
        c._fetchProfileFromContext({
            id: 'acme-marking',
            version: '1.0.0',
        } as ContextDescription),
    'describeConcept': (c) =>
        c.scheme.describeConcept('H', 'level', { view: 'default' }),
    'describeAllAccessRules': (c) => c.access.describeAllAccessRules(),
};

describe('GET requests carry only query parameters the contract declares', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it.each(Object.keys(GET_CALLS))('%s', async (name) => {
        const captured = captureRequests();
        try {
            await GET_CALLS[name](makeClient());
        } catch {
            // Only the requests matter, as in `send`.
        }
        expect(captured.length, `${name} sent no request`).toBeGreaterThan(0);
        for (const { method, path, query } of captured) {
            expect(method).toBe('GET');
            const declared = spec.declaredQueryParameters(method, path);
            expect(
                query.filter((param) => !declared.has(param)),
                `${name}: GET ${path} sent query parameters the contract does not declare`,
            ).toEqual([]);
        }
    });

    it('sends the describe-concept arguments the contract declares', async () => {
        const captured = captureRequests();
        try {
            await makeClient().scheme.describeConcept('H', 'level', {
                view: 'default',
            });
        } catch {
            // Only the request matters.
        }
        expect(captured[0].query).toEqual(['conceptId', 'categoryId', 'view']);
    });

    it('the audit bites on a parameter the contract does not declare', () => {
        const declared = spec.declaredQueryParameters(
            'get',
            '/v1/ctx/acme-marking/1.0.0/scheme/label-presets',
        );
        expect(declared.has('scheme')).toBe(false);
        expect(
            spec
                .declaredQueryParameters(
                    'get',
                    '/v1/ctx/acme-marking/1.0.0/scheme/concepts',
                )
                .has('scheme'),
        ).toBe(true);
    });
});

// Negative controls. A gate that cannot fail proves nothing, so pin the
// failure modes it exists for: an undeclared field, a missing required one, a
// wrong type, and a declared field the client never sends.
describe('the request-schema validator bites', () => {
    it.each([
        [
            'scheme/process',
            { input: 'H', notAContractField: true },
            'notAContractField',
        ],
        ['scheme/validate', { input: 'H', outputs: ['x/y'] }, 'outputs'],
        [
            'scheme/validate',
            { input: 'H', suggestFor: ['level'] },
            'suggestFor',
        ],
        ['scheme/explain', { input: 'H', outputs: ['x/y'] }, 'outputs'],
        ['scheme/explain', { input: 'H', suggestFor: ['level'] }, 'suggestFor'],
        [
            'scheme/suggest',
            { input: 'H', notAContractField: true },
            'notAContractField',
        ],
        [
            'scheme/aggregate',
            { inputs: ['H'], notAContractField: true },
            'notAContractField',
        ],
        [
            'scheme/diff',
            { a: 'H', b: 'L', notAContractField: true },
            'notAContractField',
        ],
    ] as Array<[string, Json, string]>)(
        'rejects %s with %j',
        (route, body, field) => {
            const errors = spec.validate('post', CTX_PREFIX + route, body);
            expect(errors.some((e) => e.includes(`'${field}'`))).toBe(true);
        },
    );

    it('rejects a missing required field and a wrong type', () => {
        const missing = spec.validate('post', `${CTX_PREFIX}scheme/process`, {
            surface: 'portion',
        });
        expect(missing.some((e) => e.includes("'input'"))).toBe(true);

        const wrongType = spec.validate('post', `${CTX_PREFIX}scheme/render`, {
            assertions: [
                {
                    categoryId: 'level',
                    conceptId: 'HIGH',
                    confidence: 'sure',
                    source: 'parse',
                },
            ],
        });
        expect(wrongType).not.toEqual([]);
    });

    it('accepts inputFormat, outputFormat and surface', () => {
        for (const route of ['scheme/process', 'scheme/validate']) {
            expect(
                spec.validate('post', CTX_PREFIX + route, {
                    input: 'H',
                    inputFormat: 'portion',
                    outputFormat: 'banner',
                    surface: 'portion',
                }),
            ).toEqual([]);
        }
    });

    it('reports a declared field no case sends', () => {
        // Stand in for a client that lost an option: every field the process
        // schema declares except one. The check must name the route and field.
        const declared = spec.declaredProperties(
            'post',
            `${CTX_PREFIX}scheme/process`,
        );
        expect(declared.has('suggestFor')).toBe(true);
        const sent = new Set(declared);
        sent.delete('suggestFor');
        expect(
            unsentContractFields(new Map([['scheme/process', sent]])),
        ).toEqual(['scheme/process: suggestFor']);
    });

    it('collects declared fields across $ref, anyOf and if/then/else', () => {
        // No request schema in the contract declares a field only on a branch
        // today, so a synthetic one pins the traversal. A field declared on
        // any branch is one the client must be able to send.
        const probe = new OpenApiRequestSchemas(specPath) as unknown as {
            requestSchemas: Map<string, Schema>;
            declaredProperties(method: string, path: string): Set<string>;
        };
        probe.requestSchemas.set('post /probe', {
            properties: { top: {} },
            anyOf: [
                { $ref: '#/components/schemas/CtxAccessCheckRequestBody' },
                { properties: { fromAnyOf: {} } },
            ],
            if: { properties: { top: { const: 'x' } } },
            then: { properties: { fromThen: {} } },
            else: { properties: { fromElse: {} } },
        });
        expect([...probe.declaredProperties('post', '/probe')].sort()).toEqual([
            'assertions',
            'context',
            'fromAnyOf',
            'fromElse',
            'fromThen',
            'marking',
            'top',
            'userAttributes',
        ]);
    });

    it('rejects unknown keywords even in an unchosen union branch', () => {
        const probe = new OpenApiRequestSchemas(specPath) as unknown as {
            requestSchemas: Map<string, Schema>;
            validate(method: string, path: string, body: Json): string[];
        };
        probe.requestSchemas.set('post /probe', {
            anyOf: [{ type: 'string' }, { unknownConstraint: true }],
        });
        expect(() => probe.validate('post', '/probe', 'x')).toThrow(
            /unknown keyword: "unknownConstraint"/,
        );
    });

    it.each(['const', 'enum', 'example'])(
        'preserves literal $ref data in %s',
        (keyword) => {
            const probe = new OpenApiRequestSchemas(specPath) as unknown as {
                requestSchemas: Map<string, Schema>;
                validate(method: string, path: string, body: Json): string[];
            };
            const literal = { $ref: '#/components/schemas/Example' };
            const schema = {
                type: 'object',
                [keyword]: keyword === 'enum' ? [literal] : literal,
            };
            const before = structuredClone(schema);
            probe.requestSchemas.set('post /probe', schema);
            expect(probe.validate('post', '/probe', literal)).toEqual([]);
            expect(schema).toEqual(before);
            if (keyword !== 'example') {
                expect(
                    probe.validate('post', '/probe', { $ref: 'different' }),
                ).not.toEqual([]);
            }
        },
    );

    it('enforces JSON Schema 2020-12 dependent requirements', () => {
        const probe = new OpenApiRequestSchemas(specPath) as unknown as {
            requestSchemas: Map<string, Schema>;
            validate(method: string, path: string, body: Json): string[];
        };
        probe.requestSchemas.set('post /probe', {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            dependentRequired: { a: ['b'] },
        });
        expect(probe.validate('post', '/probe', { a: 'x' })).not.toEqual([]);
        expect(probe.validate('post', '/probe', { a: 'x', b: 'y' })).toEqual(
            [],
        );
    });
});
