/**
 * Contract test: verifies that EzClassifyClient's HTTP request bodies match the
 * shapes declared in the public vendor/spec/openapi.yaml contract.
 *
 * For each covered operation this test:
 *
 * 1. Intercepts the fetch call made by the client.
 * 2. Validates the captured body against the spec's requestBody schema via AJV.
 * 3. Asserts Content-Type is application/json on POST requests.
 * 4. Asserts the client can deserialize a minimal valid response without throwing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import type { Assertion } from '@ezclassify/types';
import { EzClassifyClient } from '../src/ezclassify-client';
import { corpusResult } from './contract-fixtures';

// ---------------------------------------------------------------------------
// Spec + AJV setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(__dirname, '../vendor/spec/openapi.yaml');
const spec = yaml.load(readFileSync(specPath, 'utf-8')) as Record<
    string,
    unknown
>;

// Register the full spec so $refs within components.schemas resolve correctly.
// AJV resolves "#/components/schemas/Foo" fragments against the registered spec.
const ajv = new (
    Ajv as unknown as new (opts: Record<string, unknown>) => {
        addSchema(schema: unknown, id: string): void;
        validate(schema: unknown, data: unknown): boolean;
        errors: Array<{ instancePath: string; message?: string }> | null;
        errorsText(errors?: unknown, opts?: { separator?: string }): string;
    }
)({ strict: false, allErrors: true });

ajv.addSchema(spec, 'spec');

function assertValidBody(schemaName: string, body: unknown): void {
    const valid = ajv.validate(
        { $ref: `spec#/components/schemas/${schemaName}` },
        body,
    );
    if (!valid) {
        const msg = ajv.errorsText(ajv.errors, { separator: '\n  - ' });
        throw new Error(`Body does not match ${schemaName}:\n  - ${msg}`);
    }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A copy of one schema with every object that lists its properties closed.
 *
 * Result schemas are open on the wire, so a server can add a member without
 * breaking a client. The same openness lets a fixture keep a member the
 * contract has dropped and still validate, which is the drift the fixture
 * checks below exist to catch. Walked by keyword rather than by key, so a
 * property that happens to be named `properties` is not mistaken for one.
 */
function closedSchema(schema: unknown): unknown {
    if (!isSchemaObject(schema)) return schema;
    if (schema.allOf !== undefined) {
        // Closing each branch of an allOf would refuse the members the other
        // branches declare. Nothing in the contract uses one today; if that
        // changes, this check has to learn unevaluatedProperties first.
        throw new Error('closedSchema cannot close an allOf schema');
    }
    const copy: Record<string, unknown> = { ...schema };
    if (isSchemaObject(copy.properties)) {
        copy.properties = Object.fromEntries(
            Object.entries(copy.properties).map(([name, member]) => [
                name,
                closedSchema(member),
            ]),
        );
        copy.additionalProperties ??= false;
    }
    for (const keyword of ['items', 'additionalProperties', 'not']) {
        if (isSchemaObject(copy[keyword])) {
            copy[keyword] = closedSchema(copy[keyword]);
        }
    }
    for (const keyword of ['oneOf', 'anyOf', 'prefixItems']) {
        const branches = copy[keyword];
        if (Array.isArray(branches)) copy[keyword] = branches.map(closedSchema);
    }
    return copy;
}

const specSchemas = (spec.components as { schemas: Record<string, unknown> })
    .schemas;
ajv.addSchema(
    {
        ...spec,
        components: {
            ...(spec.components as Record<string, unknown>),
            schemas: Object.fromEntries(
                Object.entries(specSchemas).map(([name, schema]) => [
                    name,
                    closedSchema(schema),
                ]),
            ),
        },
    },
    'closed-spec',
);

/**
 * Check one of this file's result fixtures against its contract schema, with
 * every object closed, so a member the contract does not declare fails.
 */
function assertFixtureMatches(schemaName: string, fixture: unknown): void {
    const valid = ajv.validate(
        { $ref: `closed-spec#/components/schemas/${schemaName}` },
        fixture,
    );
    if (!valid) {
        const msg = ajv.errorsText(ajv.errors, { separator: '\n  - ' });
        throw new Error(`Fixture does not match ${schemaName}:\n  - ${msg}`);
    }
}

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

type Captured = {
    method: string;
    path: string;
    body: unknown;
    contentType: string | undefined;
};

const BASE_URL = 'http://api.test';

function captureFetch(responseBody: unknown = {}): Captured[] {
    const captured: Captured[] = [];
    globalThis.fetch = vi.fn(
        async (urlStr: string | URL, init: RequestInit = {}) => {
            const url = new URL(
                typeof urlStr === 'string' ? urlStr : urlStr.toString(),
            );
            captured.push({
                method: (init.method ?? 'GET').toUpperCase(),
                path: `${url.pathname}${url.search}`,
                body: init.body ? JSON.parse(init.body as string) : null,
                contentType: (
                    init.headers as Record<string, string> | undefined
                )?.['Content-Type'],
            });
            const body =
                url.pathname.startsWith('/v1/ctx/') &&
                !url.pathname.endsWith('/access/rules') &&
                (responseBody === null ||
                    typeof responseBody !== 'object' ||
                    !Object.hasOwn(responseBody, 'resolution'))
                    ? {
                          resolution: {
                              contextId: 'test-context',
                              resolvedVersion: '1.0.0',
                              artifacts: [],
                              sources: [],
                          },
                          result: responseBody,
                          operationLimitations: [],
                      }
                    : responseBody;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify(body),
            } as Response;
        },
    );
    return captured;
}

function makeClient(): EzClassifyClient {
    return new EzClassifyClient(BASE_URL, {
        contextId: 'test-context',
        contextVersion: '1.0.0',
        disableCache: true,
    });
}

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Result fixtures, each checked against its contract schema below
// ---------------------------------------------------------------------------

const ASSESSMENT = {
    emitted: [{ conceptId: 'HIGH', categoryId: 'level' }],
    omitted: [],
    collapsed: [],
    conflicts: [],
    unrepresentable: [],
};

const HIGH: Assertion = {
    conceptId: 'HIGH',
    categoryId: 'level',
    confidence: 'certain',
    source: 'parse',
};

const STAFF: Assertion = {
    conceptId: 'STAFF',
    categoryId: 'audience',
    confidence: 'certain',
    source: 'user',
};

/**
 * What validate answers: the reader's result, with no fix paths.
 *
 * The scheme declares a surface `marking` with views `long` and `short`, so
 * recognition reports the view the text was read as by its output address, and
 * the role that view states.
 */
const VALIDATE_RESULT = {
    assertions: [HIGH],
    valid: true,
    inputWasValid: true,
    errors: [],
    warnings: [],
    appliedFixes: [],
    rendered: 'HIGH',
    assessment: ASSESSMENT,
    recognition: {
        status: 'complete',
        inputFormat: 'marking/long',
        role: 'whole',
        surface: 'marking',
        unmatched: [],
    },
    notices: [],
};

/** What process answers when it names one output and one picker. */
const PROCESS_RESULT = {
    ...VALIDATE_RESULT,
    recognition: { ...VALIDATE_RESULT.recognition, corrections: [] },
    proposedFixes: [],
    renders: {
        'marking/short': { rendered: 'H', assessment: ASSESSMENT },
    },
    suggestionsFor: { level: { suggestions: [], warnings: [] } },
};

const EXPLANATION_TRACE = {
    input: 'HIGH',
    schemeId: 'example-scheme',
    entries: [],
    repairs: [],
    validationErrors: [],
    inferences: [],
    finalAssertions: [HIGH],
    rendered: 'HIGH',
};

const SUGGESTIONS_BY_CATEGORY = { level: { suggestions: [], warnings: [] } };

// ---------------------------------------------------------------------------
// Request body contract tests
// ---------------------------------------------------------------------------

describe('openapi-contract: request body shape', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('GET /v1/health: correct method and path', async () => {
        const calls = captureFetch({
            status: 'ok',
            engineVersion: '0.1.0',
            engineSha: '',
            gitTag: '',
        });
        const client = makeClient();
        await client.ping();
        expect(calls[0].method).toBe('GET');
        expect(calls[0].path).toBe('/v1/health');
    });

    it('POST Context scheme/process: body matches CtxSchemeProcessRequestBody', async () => {
        const calls = captureFetch(PROCESS_RESULT);
        const client = makeClient();
        await client.scheme.process('HIGH');
        assertValidBody('CtxSchemeProcessRequestBody', calls[0].body);
        expect(calls[0].contentType).toBe('application/json');
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/process');
    });

    it('POST Context scheme/process: outputs and suggestFor match CtxSchemeProcessRequestBody', async () => {
        const calls = captureFetch(PROCESS_RESULT);
        const client = makeClient();
        await client.scheme.process('high', {
            assertions: [HIGH],
            outputs: ['marking/short'],
            suggestFor: ['level'],
        });
        assertValidBody('CtxSchemeProcessRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({
            input: 'high',
            assertions: [HIGH],
            outputs: ['marking/short'],
            suggestFor: ['level'],
        });
    });

    it('POST Context scheme/explain: body matches CtxSchemeExplainRequestBody', async () => {
        const calls = captureFetch(EXPLANATION_TRACE);
        const client = makeClient();
        const trace = await client.scheme.explain('HIGH');
        assertValidBody('CtxSchemeExplainRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({ input: 'HIGH' });
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/explain');
        expect(trace).toEqual(EXPLANATION_TRACE);
    });

    it('POST Context scheme/explain: facts go out beside an empty input', async () => {
        const calls = captureFetch(EXPLANATION_TRACE);
        const client = makeClient();
        await client.explain([HIGH]);
        assertValidBody('CtxSchemeExplainRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({ input: '', assertions: [HIGH] });
    });

    it('POST Context scheme/explain: the facts already chosen go out after the facts handed in', async () => {
        const calls = captureFetch(EXPLANATION_TRACE);
        const client = makeClient();
        await client.explain([HIGH], {
            assertions: [{ ...HIGH, source: 'user' }, STAFF],
        });
        assertValidBody('CtxSchemeExplainRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({
            input: '',
            assertions: [HIGH, STAFF],
        });
    });

    it('POST Context scheme/process: a fact with another value is another fact', async () => {
        const calls = captureFetch(PROCESS_RESULT);
        const client = makeClient();
        const named = (value?: string): Assertion => ({
            conceptId: 'NAMED',
            categoryId: 'owner',
            confidence: 'certain',
            source: 'user',
            ...(value === undefined ? {} : { value }),
        });
        await client.scheme.process([HIGH, named('Ruiz')], {
            assertions: [named('Ruiz'), named('Ruiz, M.'), named(''), named()],
        });
        assertValidBody('CtxSchemeProcessRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({
            input: '',
            assertions: [
                HIGH,
                named('Ruiz'),
                named('Ruiz, M.'),
                named(''),
                named(),
            ],
        });
    });

    it('POST Context scheme/process: chosen facts that are not a list go out for the server to refuse', async () => {
        const calls = captureFetch(PROCESS_RESULT);
        const client = makeClient();
        await client.scheme.process([HIGH], {
            assertions: null as unknown as Assertion[],
        });
        expect(calls[0].body).toEqual({ input: '', assertions: null });
    });

    it('POST Context scheme/suggest: facts go out as assertions, never beside input', async () => {
        // The suggest request carries the marking in exactly one of the two
        // fields and refuses a body with both, deciding by presence. The
        // schema states that in prose rather than as a oneOf, so it is
        // asserted on the body here, the empty list included: it is facts
        // with none chosen, not text with nothing typed.
        const calls = captureFetch(corpusResult('ctx-scheme-suggest.ok'));
        const client = makeClient();
        await client.scheme.suggest([HIGH], { filter: 'hi' });
        await client.suggest([]);
        assertValidBody('CtxSchemeSuggestRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({ assertions: [HIGH], filter: 'hi' });
        assertValidBody('CtxSchemeSuggestRequestBody', calls[1].body);
        expect(calls[1].body).toEqual({ assertions: [] });
    });

    it('POST Context scheme/aggregate: body matches CtxSchemeAggregateRequestBody', async () => {
        const calls = captureFetch(corpusResult('ctx-scheme-aggregate.ok'));
        const client = makeClient();
        await client.scheme.aggregate(['A', 'B']);
        assertValidBody('CtxSchemeAggregateRequestBody', calls[0].body);
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/aggregate',
        );
    });

    it('POST Context scheme/suggest: body matches CtxSchemeSuggestRequestBody', async () => {
        const calls = captureFetch(corpusResult('ctx-scheme-suggest.ok'));
        const client = makeClient();
        await client.scheme.suggest('');
        assertValidBody('CtxSchemeSuggestRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({ input: '' });
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/suggest');
    });

    it('POST Context scheme/suggest: includeGated matches CtxSchemeSuggestRequestBody', async () => {
        const calls = captureFetch(corpusResult('ctx-scheme-suggest.ok'));
        const client = makeClient();
        await client.scheme.suggest('', {
            includeGated: true,
        });
        assertValidBody('CtxSchemeSuggestRequestBody', calls[0].body);
    });

    it('POST Context scheme/suggest-for-categories: body matches CtxSchemeSuggestForCategoriesRequestBody', async () => {
        // The response must answer every requested category or the
        // client's missing-category guard rejects it before the request
        // assertion below ever runs.
        const calls = captureFetch(SUGGESTIONS_BY_CATEGORY);
        const client = makeClient();
        const byCategory = await client.scheme.suggestForCategories(
            [
                {
                    conceptId: 'HIGH',
                    categoryId: 'level',
                    confidence: 'certain',
                    source: 'user',
                },
            ],
            ['level'],
        );
        assertValidBody(
            'CtxSchemeSuggestForCategoriesRequestBody',
            calls[0].body,
        );
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/suggest-for-categories',
        );
        expect(byCategory).toEqual(SUGGESTIONS_BY_CATEGORY);
    });

    it('POST /v1/ctx/.../crosswalk/translate: body matches CtxCrosswalkTranslateRequestBody', async () => {
        const calls = captureFetch({
            resolution: {
                contextId: 'ctx',
                resolvedVersion: '1.0.0',
                artifacts: [],
                sources: [],
            },
            result: corpusResult('ctx-crosswalk-translate.translated'),
            operationLimitations: [],
        });
        const client = new EzClassifyClient(BASE_URL, {
            contextId: 'ctx',
            contextVersion: '1.0.0',
            disableCache: true,
        });
        await client.translate({
            crosswalkId: 'state-to-district',
            marking: 'HIGH',
        });
        assertValidBody('CtxCrosswalkTranslateRequestBody', calls[0].body);
        expect(calls[0].path).toBe('/v1/ctx/ctx/1.0.0/crosswalk/translate');
    });

    it('GET /v1/ctx/.../access/rules: reaches the declared route', async () => {
        const calls = captureFetch({ rules: [] });
        const client = new EzClassifyClient(BASE_URL, {
            contextId: 'ctx',
            contextVersion: '1.0.0',
            disableCache: true,
        });
        await client.access.describeAllAccessRules();
        expect(calls[0].method).toBe('GET');
        expect(calls[0].path).toBe('/v1/ctx/ctx/1.0.0/access/rules');
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/scan: body matches ScanRequest', async () => {
        const calls = captureFetch(corpusResult('ctx-scheme-scan.ok'));
        const client = makeClient();
        await client.scheme.scan('Some document text');
        assertValidBody('CtxSchemeScanRequestBody', calls[0].body);
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/scan');
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/validate: body matches ValidateRequest', async () => {
        const calls = captureFetch(VALIDATE_RESULT);
        const client = makeClient();
        await client.scheme.validate('HIGH');
        assertValidBody('CtxSchemeValidateRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({ input: 'HIGH' });
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/validate',
        );
    });

    it('POST Context scheme/validate: facts as stated go out as assertions, never beside input', async () => {
        // The validate request carries the marking in exactly one of the two
        // fields and refuses a body with both. The schema states that in
        // prose rather than as a oneOf, so it is asserted on the body here.
        const calls = captureFetch(VALIDATE_RESULT);
        const client = makeClient();
        await client.validate([HIGH], { surface: 'portion' });
        assertValidBody('CtxSchemeValidateRequestBody', calls[0].body);
        expect(calls[0].body).toEqual({
            assertions: [HIGH],
            surface: 'portion',
        });
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/render: body matches RenderRequest', async () => {
        const calls = captureFetch({
            result: 'HIGH',
            assessment: {
                emitted: [],
                omitted: [],
                collapsed: [],
                conflicts: [],
                unrepresentable: [],
            },
        });
        const client = makeClient();
        const assertions: Assertion[] = [
            {
                conceptId: 'HIGH',
                categoryId: 'level',
                confidence: 'certain',
                source: 'user',
            },
        ];
        await client.scheme.render(assertions, undefined);
        assertValidBody('CtxSchemeRenderRequestBody', calls[0].body);
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/render');
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/diff: body matches DiffRequest', async () => {
        const calls = captureFetch({ added: [], removed: [], common: [] });
        const client = makeClient();
        await client.scheme.diff('A', 'B');
        assertValidBody('CtxSchemeDiffRequestBody', calls[0].body);
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/diff');
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/check-coverage: body matches CheckCoverageRequest', async () => {
        const calls = captureFetch({
            covered: true,
            missing: [],
            missingLabels: [],
            excess: [],
            excessLabels: [],
            rendered: '',
        });
        const client = makeClient();
        await client.scheme.checkCoverage(['LEVEL-A', 'LEVEL-B'], 'LEVEL-HIGH');
        assertValidBody('CtxSchemeCheckCoverageRequestBody', calls[0].body);
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/check-coverage',
        );
    });

    it('GET Context scheme/describe-concept: arguments are query parameters', async () => {
        const calls = captureFetch(
            corpusResult('ctx-scheme-describe-concept.ok'),
        );
        const client = makeClient();
        await client.scheme.describeConcept('HIGH', 'level');
        expect(calls[0].method).toBe('GET');
        expect(calls[0].body).toBeNull();
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/describe-concept?conceptId=HIGH&categoryId=level',
        );
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/filter-concepts: body matches FilterConceptsRequest', async () => {
        const calls = captureFetch({
            visibleIds: [],
            categoryCounts: {},
            total: { visible: 0, total: 0 },
        });
        const client = makeClient();
        await client.scheme.filterConcepts('hi');
        assertValidBody('CtxSchemeFilterConceptsRequestBody', calls[0].body);
        expect(calls[0].path).toBe(
            '/v1/ctx/test-context/1.0.0/scheme/filter-concepts',
        );
    });

    it('POST /v1/ctx/test-context/1.0.0/scheme/notices: body matches CollectNoticesRequest', async () => {
        const calls = captureFetch([]);
        const client = makeClient();
        const assertions: Assertion[] = [
            {
                conceptId: 'HIGH',
                categoryId: 'level',
                confidence: 'certain',
                source: 'user',
            },
        ];
        await client.scheme.collectNotices(assertions);
        assertValidBody('CtxSchemeNoticesRequestBody', calls[0].body);
        expect(calls[0].contentType).toBe('application/json');
        expect(calls[0].path).toBe('/v1/ctx/test-context/1.0.0/scheme/notices');
    });
});

// ---------------------------------------------------------------------------
// Response deserialization tests
// ---------------------------------------------------------------------------

describe('openapi-contract: response deserialization', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('process response deserialized without throwing', async () => {
        captureFetch(PROCESS_RESULT);
        const client = makeClient();
        const result = await client.scheme.process('HIGH');
        expect(result).toEqual(PROCESS_RESULT);
    });

    it('validate and apply-preset answers deserialized without throwing', async () => {
        captureFetch(VALIDATE_RESULT);
        const client = makeClient();
        expect(await client.scheme.validate('HIGH')).toEqual(VALIDATE_RESULT);
        expect(await client.scheme.applyPreset('default-label')).toEqual(
            VALIDATE_RESULT,
        );
    });

    it.each([
        ['ValidateResult', VALIDATE_RESULT],
        ['ProcessResult', PROCESS_RESULT],
        ['ExplanationTrace', EXPLANATION_TRACE],
        ['SuggestResultsByCategory', SUGGESTIONS_BY_CATEGORY],
    ])('the %s fixture is one the contract accepts', (schemaName, fixture) => {
        // A fixture that drifts from the contract makes every test above it
        // prove something about a response no server sends.
        assertFixtureMatches(schemaName, fixture);
    });

    it.each([
        ['ProcessResult', { ...PROCESS_RESULT, notAContractField: {} }],
        [
            'SuggestResultsByCategory',
            {
                level: {
                    ...SUGGESTIONS_BY_CATEGORY.level,
                    notAContractField: true,
                },
            },
        ],
        [
            'ValidateResult',
            {
                ...VALIDATE_RESULT,
                recognition: {
                    ...VALIDATE_RESULT.recognition,
                    notAContractField: [],
                },
            },
        ],
    ])(
        'the fixture check refuses a %s carrying an undeclared member',
        (schemaName, fixture) => {
            // The wire schemas are open, so without closing them first these
            // would pass, and a fixture could drift from the contract with
            // nothing noticing.
            assertValidBody(schemaName, fixture);
            expect(() => assertFixtureMatches(schemaName, fixture)).toThrow(
                /must NOT have additional properties/,
            );
        },
    );

    it('aggregate response deserialized without throwing', async () => {
        captureFetch(corpusResult('ctx-scheme-aggregate.ok'));
        const client = makeClient();
        const result = await client.scheme.aggregate(['A', 'B']);
        expect(result).toBeDefined();
    });

    it('scan response deserialized without throwing', async () => {
        captureFetch({
            results: [],
            unread: [],
            limits: { status: 'complete', regionsFound: 0 },
        });
        const client = makeClient();
        const result = await client.scheme.scan('text');
        expect(Array.isArray(result.results)).toBe(true);
    });

    it('scan limits reach a caller that asks for them', async () => {
        // The whole reason the response is an object: this document had no
        // marking in it, and a scan that gave up would have answered with the
        // same empty list.
        captureFetch({
            results: [],
            unread: [],
            limits: { status: 'complete', regionsFound: 3 },
        });
        const client = makeClient();
        const outcome = await client.scheme.scan('text');
        expect(outcome.results).toEqual([]);
        expect(outcome.limits).toEqual({
            status: 'complete',
            regionsFound: 3,
        });
    });

    it('filter-concepts response hydrated to FilterResult without throwing', async () => {
        captureFetch({
            visibleIds: ['HIGH', 'LOW'],
            categoryCounts: { level: { visible: 2, total: 3 } },
            total: { visible: 2, total: 3 },
        });
        const client = makeClient();
        const result = await client.scheme.filterConcepts('hi');
        expect(result.visibleIds).toBeInstanceOf(Set);
        expect(result.categoryCounts).toBeInstanceOf(Map);
    });
});
