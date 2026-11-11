/**
 * Runs the cache conformance plans in `vendor/spec/cache/v1/plans.json`.
 *
 * `CACHE-SEMANTICS.md` is the contract every SDK's cache has to meet, and the
 * plans turn it into steps every port runs against the same recorded wire
 * corpus: the number of requests that reach the transport is the thing
 * measured. This file is this client's harness for them. It supplies the case
 * drivers (one public call per operation and recorded case), builds one
 * cache-enabled client per plan over a counting replay transport, and executes
 * the steps.
 *
 * Capabilities this client has, and the single reading worth stating:
 *
 * - `cancellation`: every operation a plan cancels takes an `AbortSignal`.
 * - `explicitNullMember`: a JavaScript caller can pass `null` for an optional
 *   member the types declare as absent-or-value, and it goes out as `null`.
 * - `schemeResourceOperations`: the seven scheme resource reads are not separate
 *   public operations. `fetchProfile()` is the public call that reads them, it
 *   reaches the wire every time, and the plans for the resource operations
 *   drive it. Each count is of the one resource's recorded case.
 * - `sharedRouteOperations`: `access.check()` and `context.checkAccess()` post
 *   the same body to the same Context access route, so the plan that keeps
 *   their entries apart runs here.
 * - The waiter count the harness needs is `RequestCache.pendingWaiters`. A call
 *   joins its in-flight entry before it returns control, so the count read
 *   right after the callers start observes that they have all joined.
 */

import { expect, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import type { Assertion } from '@ezclassify/types';
import { loadWireCorpus } from './wire-corpus';
import type { WireCase } from './wire-corpus';
import { PLAN_BASE_URL, PlanTransport } from './cache-plan-transport';
import type { NullVariant } from './cache-plan-transport';

/** The carrier a plan client sends its Context authorization in. */
const CONTEXT_CARRIER = 'conformance-context-carrier';

const OPEN_ASSERTION: Assertion = {
    categoryId: 'level',
    conceptId: 'OPEN',
    confidence: 'certain',
    source: 'explicit',
};

// ---------------------------------------------------------------------------
// Plan file shape
// ---------------------------------------------------------------------------

type Binding = 'pinned' | 'unpinned' | 'token-defaulted';

type ErrorExpectation =
    | { kind: 'http'; status: number }
    | { kind: 'aborted' | 'malformed-response' };

type Variant = 'reorderedMembers' | 'unsetMember' | 'explicitNullMember';

export type PlanStep =
    | {
          step: 'call';
          operation: string;
          case: string;
          times?: number;
          caller?: string;
          variant?: Variant;
          member?: string;
          preCanceled?: true;
          expect?: { error: ErrorExpectation };
      }
    | {
          step: 'concurrent';
          operation: string;
          case: string;
          callers: string[];
          cancelable?: string[];
      }
    | { step: 'gate' | 'release'; case: string }
    | { step: 'cancel'; caller: string }
    | { step: 'advanceClock'; ms: number }
    | {
          step: 'respond';
          synthetic: 'malformed-success';
          case: string;
          removeMembers: string[];
      }
    | { step: 'respond'; synthetic: 'denial-404'; case: string }
    | { step: 'respond'; synthetic: 'resolved-version'; version: string }
    | { step: 'quiesce' }
    | { step: 'mutateResult'; caller: string }
    | { step: 'expectOk'; callers: string[] }
    | { step: 'expectError'; callers: string[]; error: ErrorExpectation }
    | {
          step: 'expectWireCount';
          case: string;
          count: number;
          variant?: 'explicitNullMember';
          member?: string;
      }
    | { step: 'expectWireAborted'; case: string; aborted: boolean }
    | { step: 'expectIndependentResults'; callers: string[] };

export interface Plan {
    id: string;
    title: string;
    covers: string[];
    capabilities: string[];
    client: {
        binding: Binding;
        context?: string;
        cacheAccessDecisions?: boolean;
        construction?: 'refused';
    };
    steps: PlanStep[];
}

export interface PlanFile {
    corpus: string;
    denialCase: string;
    operations: Array<{
        name: string;
        method: string;
        route: string;
        treatment: string;
    }>;
    checklist: Array<{ id: string; requirement: string }>;
    capabilities: Record<
        string,
        { description: string; notApplicable?: string }
    >;
    knownGaps: unknown[];
    plans: Plan[];
}

/** What this client's harness can do. Every capability is present. */
export const CAPABILITIES: Readonly<Record<string, boolean>> = {
    responseGate: true,
    clock: true,
    scriptedResponses: true,
    quiesce: true,
    cancellation: true,
    explicitNullMember: true,
    schemeResourceOperations: true,
    sharedRouteOperations: true,
};

// ---------------------------------------------------------------------------
// Case drivers
// ---------------------------------------------------------------------------

/** How one call departs from the case's recorded request. */
interface CallOptions {
    signal?: AbortSignal;
    context?: Record<string, unknown>;
    variant?: Variant;
    member?: string;
}

/** The public call that sends exactly a case's recorded request. */
type CaseDriver = (
    client: EzClassifyClient,
    options: CallOptions,
) => Promise<unknown>;

/** A driver that takes no signal; a plan that cancels it is a harness error. */
function noSignal(
    run: (client: EzClassifyClient, options: CallOptions) => Promise<unknown>,
): CaseDriver {
    return (client, options) => {
        if (options.signal) {
            throw new Error('this driver has no cancellation surface');
        }
        return run(client, options);
    };
}

/** A resource read: `fetchProfile()` is the public call that reads all seven. */
const readResources: CaseDriver = noSignal((client) => client.fetchProfile());

/**
 * `process('OPEN')` and its variants. An unset member and an explicit null are
 * the two ways the plans depart from the recorded request.
 */
const processOpen: CaseDriver = (client, options) => {
    const signal = options.signal;
    if (options.variant === 'unsetMember') {
        return client.scheme.process('OPEN', {
            outputFormat: undefined,
            signal,
        });
    }
    if (options.variant === 'explicitNullMember') {
        // The option is typed as absent-or-string. A JavaScript caller can
        // still pass null, and it must go out as null.
        return client.scheme.process('OPEN', {
            outputFormat: null as unknown as undefined,
            signal,
        });
    }
    return client.scheme.process('OPEN', { signal });
};

/** The drivers, keyed `operation|case`. */
const DRIVERS: Readonly<Record<string, CaseDriver>> = {
    'scheme.process|ctx-scheme-process.ok': processOpen,
    'scheme.process|ctx-scheme-process.undeclared-format': (client, options) =>
        client.scheme.process('OPEN', {
            outputFormat: 'nope',
            signal: options.signal,
        }),
    'scheme.validate|ctx-scheme-validate.ok': (client, options) =>
        client.scheme.validate('OPEN', { signal: options.signal }),
    'scheme.explain|ctx-scheme-explain.ok': (client, options) =>
        client.scheme.explain('OPEN', { signal: options.signal }),
    'scheme.normalize|ctx-scheme-normalize.ok': (client, options) =>
        client.scheme.normalize('open', { signal: options.signal }),
    'scheme.render|ctx-scheme-render.ok': (client, options) =>
        client.scheme.render([OPEN_ASSERTION], undefined, {
            signal: options.signal,
        }),
    'scheme.diff|ctx-scheme-diff.ok': (client, options) =>
        client.scheme.diff('OPEN', 'SENSITIVE', { signal: options.signal }),
    'scheme.aggregate|ctx-scheme-aggregate.ok': (client, options) =>
        client.scheme.aggregate(['OPEN', 'SENSITIVE'], {
            signal: options.signal,
        }),
    'scheme.aggregateAssertions|ctx-scheme-aggregate.assertion-sets': (
        client,
        options,
    ) =>
        client.scheme.aggregateAssertions(
            [[OPEN_ASSERTION], [{ ...OPEN_ASSERTION, conceptId: 'SENSITIVE' }]],
            { signal: options.signal },
        ),
    'scheme.applyPreset|ctx-scheme-apply-preset.ok': noSignal((client) =>
        client.scheme.applyPreset('sensitive-preset'),
    ),
    'scheme.suggest|ctx-scheme-suggest.ok': (client, options) =>
        client.scheme.suggest('', { signal: options.signal }),
    'scheme.suggestForCategories|ctx-scheme-suggest-for-categories.ok': (
        client,
        options,
    ) =>
        client.scheme.suggestForCategories([OPEN_ASSERTION], ['level'], {
            signal: options.signal,
        }),
    'scheme.scan|ctx-scheme-scan.ok': (client, options) =>
        client.scheme.scan('OPEN document for review', {
            signal: options.signal,
        }),
    'scheme.describeConcept|ctx-scheme-describe-concept.ok': noSignal(
        (client) => client.scheme.describeConcept('OPEN', 'level'),
    ),
    'scheme.describeConcept|ctx-scheme-describe-concept.unknown-concept':
        noSignal((client) => client.scheme.describeConcept('NOPE', 'level')),
    'access.describeAllAccessRules|ctx-access-rules.ok': noSignal((client) =>
        client.access.describeAllAccessRules(),
    ),
    'context.describeCrosswalks|ctx-crosswalk-describe.ok': noSignal((client) =>
        client.context.describeCrosswalks(),
    ),
    'access.check|ctx-access-check.assertions': noSignal((client, options) =>
        client.access.check(
            [OPEN_ASSERTION],
            { clearance: 'OPEN' },
            options.context,
        ),
    ),
    'context.checkAccess|ctx-access-check.assertions': noSignal(
        (client, options) =>
            client.context.checkAccess(
                [OPEN_ASSERTION],
                { clearance: 'OPEN' },
                options.context,
            ),
    ),
    'context.checkAccess|ctx-access-check.marking': noSignal(
        (client, options) =>
            client.context.checkAccess(
                'OPEN',
                { clearance: 'OPEN' },
                options.context,
            ),
    ),
    'context.checkAccess|ctx-access-check.two-attributes': (
        client,
        options,
    ) => {
        if (options.signal) throw new Error('no cancellation surface');
        const attributes =
            options.variant === 'reorderedMembers'
                ? { organization: 'records', clearance: 'OPEN' }
                : { clearance: 'OPEN', organization: 'records' };
        return client.context.checkAccess('OPEN', attributes, options.context);
    },
    'context.audit|ctx-document-audit.ok': noSignal((client) =>
        client.context.audit({
            responseProfile: 'summary',
            text: 'OPEN\nThis document is releasable.',
        }),
    ),
    'context.accessRequirements|ctx-access-describe-requirements.ok': noSignal(
        (client) => client.context.accessRequirements({ marking: 'OPEN' }),
    ),
    'context.translate|ctx-crosswalk-translate.translated': noSignal((client) =>
        client.context.translate({
            crosswalkId: 'ez-test-to-ez-gated',
            marking: 'OPEN',
        }),
    ),
    'context.translate|ctx-crosswalk-translate.not-selected': noSignal(
        (client) =>
            client.context.translate({
                crosswalkId: 'ez-gated-to-ez-test',
                marking: 'SENSITIVE / EXPORT',
            }),
    ),
    'context.translate|ctx-crosswalk-translate.forbidden': noSignal((client) =>
        client.context.translate({
            crosswalkId: 'ez-test-to-ez-gated',
            marking: 'SENSITIVE',
        }),
    ),
    'scheme.buildSchemeView|ctx-scheme-view.ok': noSignal((client) =>
        client.scheme.buildSchemeView(),
    ),
    'scheme.filterConcepts|ctx-scheme-filter-concepts.ok': noSignal((client) =>
        client.scheme.filterConcepts('open'),
    ),
    'scheme.checkCoverage|ctx-scheme-check-coverage.ok': noSignal((client) =>
        client.scheme.checkCoverage(['OPEN'], 'SENSITIVE'),
    ),
    'scheme.collectNotices|ctx-scheme-notices.ok': noSignal((client) =>
        client.scheme.collectNotices([OPEN_ASSERTION]),
    ),
    'guide.scan|ctx-guide-scan.ok': noSignal((client) =>
        client.guide.scan('This paragraph is confidential.'),
    ),
    'guide.evaluate|ctx-guide-evaluate.ok': noSignal((client) =>
        client.guide.evaluate('ez-test', ['rule-sensitive']),
    ),
    'guide.describeRule|ctx-guide-describe-rule.ok': noSignal((client) =>
        client.guide.describeRule('rule-sensitive'),
    ),
    'guide.filterRules|ctx-guide-filter-rules.ok': noSignal((client) =>
        client.guide.filterRules('sensitive'),
    ),
    'guide.buildGuideView|ctx-guide-view.ok': noSignal((client) =>
        client.guide.buildGuideView(),
    ),
    'access.describeAccessRule|ctx-access-describe-rule.ok': noSignal(
        (client) => client.access.describeAccessRule('level-rule'),
    ),
    'access.describeAccessRequirements|ctx-access-describe-requirements.ok':
        noSignal((client) =>
            client.access.describeAccessRequirements({ marking: 'OPEN' }),
        ),
    'scheme.summary|ctx-scheme-summary.full': readResources,
    'scheme.concepts|ctx-scheme-concepts.full': readResources,
    'scheme.categories|ctx-scheme-categories.full': readResources,
    'scheme.formats|ctx-scheme-formats.full': readResources,
    'scheme.grammar|ctx-scheme-grammar.full': readResources,
    'scheme.scopes|ctx-scheme-scopes.full': readResources,
    'scheme.labelPresets|ctx-scheme-label-presets.full': readResources,
};

/** Every operation and case pair a driver exists for. */
export function driverKeys(): string[] {
    return Object.keys(DRIVERS);
}

function driverFor(operation: string, caseId: string): CaseDriver {
    const driver = DRIVERS[`${operation}|${caseId}`];
    if (!driver) {
        throw new Error(`no driver for ${operation} on ${caseId}`);
    }
    return driver;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** How one named caller's last call settled. */
type Outcome =
    | { ok: true; value: unknown; operation: string; caseId: string }
    | { ok: false; error: unknown };

const corpus = loadWireCorpus();

/** The Context id a plan's client binds. */
function contextOf(plan: Plan): string {
    return plan.client.context ?? 'ez-full';
}

/** Constructor options for a plan's client. */
function clientOptions(
    plan: Plan,
    transport: PlanTransport,
): ConstructorParameters<typeof EzClassifyClient>[1] {
    const { binding, cacheAccessDecisions } = plan.client;
    return {
        contextId: contextOf(plan),
        contextToken: CONTEXT_CARRIER,
        ...(binding === 'token-defaulted'
            ? {}
            : { contextVersion: binding === 'pinned' ? '1.0.0' : 'latest' }),
        ...(cacheAccessDecisions ? { cacheAccessDecisions: true } : {}),
        fetchImpl: transport.fetch,
        heartbeat: false,
    };
}

/** Whether the corpus recorded a route under a Context's own path. */
function hasRecorded(contextId: string, pathTemplate: string): boolean {
    return corpus.cases.some(
        (entry) =>
            entry.request.pathTemplate === pathTemplate &&
            entry.request.path.startsWith(`/v1/ctx/${contextId}/`),
    );
}

/**
 * Build a plan's client and connect it as far as its Context's recording goes:
 * fully when the corpus holds the scheme resources connecting warms, as a
 * description when it holds only that, and not at all when it holds neither.
 * Connect traffic is outside every plan, and a request names its Context
 * without one.
 */
async function buildClient(
    plan: Plan,
    transport: PlanTransport,
): Promise<EzClassifyClient> {
    const options = clientOptions(plan, transport);
    const contextId = contextOf(plan);
    if (hasRecorded(contextId, '/v1/ctx/{ctxId}/{version}/scheme')) {
        return EzClassifyClient.connect(PLAN_BASE_URL, options);
    }
    const client = new EzClassifyClient(PLAN_BASE_URL, options);
    if (hasRecorded(contextId, '/v1/ctx/{ctxId}/{version}')) {
        await client.describeContext();
    }
    return client;
}

/** Change a result in place, nested collections included. */
function mutateInPlace(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const element of value) mutateInPlace(element);
        value.push('mutated');
        return;
    }
    const record = value as Record<string, unknown>;
    for (const name of Object.keys(record)) {
        const member = record[name];
        if (member !== null && typeof member === 'object') {
            mutateInPlace(member);
        } else {
            record[name] = `mutated-${String(member)}`;
        }
    }
    record['mutated'] = true;
}

/** What a caller of an operation should be handed for a recorded response. */
function expectedResult(operation: string, entry: WireCase): unknown {
    const body = entry.response.body as Record<string, unknown>;
    if (operation.startsWith('context.')) return body;
    if (operation === 'scheme.process') return body['result'];
    throw new Error(`no expected result is derived for ${operation}`);
}

function assertError(error: unknown, expected: ErrorExpectation): void {
    expect(error, 'the caller must see an EzClassifyError').toBeInstanceOf(
        EzClassifyError,
    );
    const failure = error as EzClassifyError;
    if (expected.kind === 'http') {
        expect(failure.status).toBe(expected.status);
    } else if (expected.kind === 'aborted') {
        expect(failure.code).toBe(ErrorCodes.ABORTED);
    } else {
        // The response arrived and was refused: no HTTP status, and the
        // client's own malformed-response code rather than a transport
        // failure or a complaint about the caller's input.
        expect(failure.status).toBeUndefined();
        expect(failure.code).toBe(ErrorCodes.MALFORMED_RESPONSE);
    }
}

/**
 * Execute one plan.
 *
 * @param plan - The plan to run
 * @param file - The plan file, for the denial case
 */
export async function runPlan(plan: Plan, file: PlanFile): Promise<void> {
    const transport = new PlanTransport(corpus, file.denialCase);

    if (plan.client.construction === 'refused') {
        expect(
            () =>
                new EzClassifyClient(
                    PLAN_BASE_URL,
                    clientOptions(plan, transport),
                ),
            'building this client must fail',
        ).toThrow(EzClassifyError);
        expect(plan.steps).toEqual([]);
        return;
    }

    for (const name of plan.capabilities) {
        expect(CAPABILITIES[name], `capability ${name} is declared`).toBe(true);
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    if (plan.capabilities.includes('clock')) {
        vi.useFakeTimers({ toFake: ['Date'] });
    }
    const client = await buildClient(plan, transport);
    transport.mark();

    const outcomes = new Map<string, Outcome>();
    const pending = new Map<string, Promise<void>>();
    const controllers = new Map<string, AbortController>();
    const gated = new Set<string>();

    const settle = async (names: string[]): Promise<void> => {
        await Promise.all(names.map((name) => pending.get(name)));
    };
    const outcomeOf = (name: string): Outcome => {
        const outcome = outcomes.get(name);
        if (!outcome) throw new Error(`caller ${name} has no outcome yet`);
        return outcome;
    };
    const variantOf = (step: {
        variant?: string;
        member?: string;
    }): NullVariant | undefined =>
        step.variant === 'explicitNullMember' && step.member
            ? { kind: 'explicitNullMember', member: step.member }
            : undefined;

    try {
        for (const step of plan.steps) {
            switch (step.step) {
                case 'call': {
                    const driver = driverFor(step.operation, step.case);
                    for (let n = 0; n < (step.times ?? 1); n += 1) {
                        const controller = new AbortController();
                        if (step.preCanceled) controller.abort();
                        const options: CallOptions = {
                            ...(step.preCanceled
                                ? { signal: controller.signal }
                                : {}),
                            context: (
                                corpus.byId.get(step.case)?.request.body as
                                    | { context?: Record<string, unknown> }
                                    | undefined
                            )?.context,
                            variant: step.variant,
                            member: step.member,
                        };
                        let outcome: Outcome;
                        try {
                            outcome = {
                                ok: true,
                                value: await driver(client, options),
                                operation: step.operation,
                                caseId: step.case,
                            };
                        } catch (error) {
                            outcome = { ok: false, error };
                        }
                        if (step.expect) {
                            expect(
                                outcome.ok,
                                `${step.operation} on ${step.case} should have failed`,
                            ).toBe(false);
                            if (!outcome.ok) {
                                assertError(outcome.error, step.expect.error);
                            }
                        } else if (!outcome.ok) {
                            throw outcome.error;
                        }
                        if (step.caller) outcomes.set(step.caller, outcome);
                    }
                    break;
                }
                case 'concurrent': {
                    const driver = driverFor(step.operation, step.case);
                    const waitingBefore = client._cache?.pendingWaiters ?? 0;
                    for (const name of step.callers) {
                        const options: CallOptions = {
                            context: (
                                corpus.byId.get(step.case)?.request.body as
                                    | { context?: Record<string, unknown> }
                                    | undefined
                            )?.context,
                        };
                        if (step.cancelable?.includes(name)) {
                            const controller = new AbortController();
                            controllers.set(name, controller);
                            options.signal = controller.signal;
                        }
                        pending.set(
                            name,
                            driver(client, options).then(
                                (value) => {
                                    outcomes.set(name, {
                                        ok: true,
                                        value,
                                        operation: step.operation,
                                        caseId: step.case,
                                    });
                                },
                                (error: unknown) => {
                                    outcomes.set(name, { ok: false, error });
                                },
                            ),
                        );
                    }
                    if (gated.has(step.case)) {
                        await transport.untilHeld(step.case);
                        // Observed, not assumed: every caller is behind the
                        // one held request.
                        expect(
                            client._cache?.pendingWaiters,
                            'every caller must have joined the in-flight entry',
                        ).toBe(waitingBefore + step.callers.length);
                    } else {
                        await settle(step.callers);
                    }
                    break;
                }
                case 'gate':
                    transport.gate(step.case);
                    gated.add(step.case);
                    break;
                case 'release':
                    transport.release(step.case);
                    await settle([...pending.keys()]);
                    break;
                case 'cancel': {
                    const controller = controllers.get(step.caller);
                    if (!controller) {
                        throw new Error(
                            `${step.caller} was not started cancelable`,
                        );
                    }
                    controller.abort();
                    await pending.get(step.caller);
                    break;
                }
                case 'advanceClock':
                    vi.setSystemTime(Date.now() + step.ms);
                    break;
                case 'respond':
                    if (step.synthetic === 'malformed-success') {
                        transport.scriptMalformed(
                            step.case,
                            step.removeMembers,
                        );
                    } else if (step.synthetic === 'denial-404') {
                        transport.scriptDenial(step.case);
                    } else {
                        transport.moveResolvedVersion(step.version);
                    }
                    break;
                case 'quiesce':
                    await client._settleProfileRewarm();
                    break;
                case 'mutateResult': {
                    const outcome = outcomeOf(step.caller);
                    if (!outcome.ok) throw outcome.error;
                    try {
                        mutateInPlace(outcome.value);
                    } catch (error) {
                        // A result that refuses mutation satisfies the step.
                        expect(error).toBeInstanceOf(TypeError);
                    }
                    break;
                }
                case 'expectOk':
                    await settle(step.callers);
                    for (const name of step.callers) {
                        const outcome = outcomeOf(name);
                        if (!outcome.ok) throw outcome.error;
                    }
                    break;
                case 'expectError':
                    await settle(step.callers);
                    for (const name of step.callers) {
                        const outcome = outcomeOf(name);
                        expect(outcome.ok, `${name} should have failed`).toBe(
                            false,
                        );
                        if (!outcome.ok) assertError(outcome.error, step.error);
                    }
                    break;
                case 'expectWireCount':
                    expect(
                        transport.countFor(step.case, variantOf(step)),
                        `requests matching ${step.case}${step.member ? ` with ${step.member} null` : ''}`,
                    ).toBe(step.count);
                    break;
                case 'expectWireAborted':
                    expect(
                        transport.latestFor(step.case)?.aborted,
                        `the request in flight for ${step.case}`,
                    ).toBe(step.aborted);
                    break;
                case 'expectIndependentResults':
                    for (const name of step.callers) {
                        const outcome = outcomeOf(name);
                        if (!outcome.ok) throw outcome.error;
                        const entry = corpus.byId.get(outcome.caseId);
                        if (!entry)
                            throw new Error(`no case ${outcome.caseId}`);
                        expect(
                            outcome.value,
                            `${name}'s result is a fresh decode of what it was answered from`,
                        ).toEqual(expectedResult(outcome.operation, entry));
                    }
                    break;
            }
        }
        expect(transport.unmatched, 'requests nothing recorded').toEqual([]);
    } finally {
        client.destroy();
        warn.mockRestore();
        vi.useRealTimers();
    }
}
