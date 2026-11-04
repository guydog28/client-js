/**
 * What drives each corpus case through the real client, and what every case
 * outside this client's surface cannot be replayed.
 *
 * A driver is not a description of a request. It is a call on the public
 * client, and the request it happens to emit is what gets matched against the
 * recording. Typed operations construct their own requests. Malformed requests
 * that those signatures exclude go through the client's own request transport,
 * with their recorded shapes stated explicitly. Both use the client transport
 * and Context credentials; a changed request stops matching the recording.
 *
 * Every corpus case is either driven or excluded with a reason. The replay
 * suite fails on a case that is neither, so a corpus that grows a new operation
 * cannot quietly read as covered.
 */

import type { Assertion } from '@ezclassify/types';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { loadWireCorpus, type WireCase } from './wire-corpus';
import type { RequestAssertion } from './wire-replay-transport';
import { REPLAY_BASE_URL } from './wire-replay-transport';

/** The Context authorization carrier a context-bound replay client sends. */
const CONTEXT_CARRIER = 'conformance-context-carrier';

const corpus = loadWireCorpus();

/** Caller-supplied Context metadata is an input to the public operation. */
function requestContext(caseId: string): Record<string, unknown> | undefined {
    const recorded = corpus.byId.get(caseId);
    if (!recorded) throw new Error(`missing wire case ${caseId}`);
    return (
        recorded.request.body as
            { context?: Record<string, unknown> } | undefined
    )?.context;
}

/**
 * A caller credential no deployment issues, for the cases recorded against a
 * deployment that refuses one. The corpus records no credential value, so the
 * bytes are irrelevant; what matters is that the client has one configured and
 * therefore has grounds to suspect a denial-shaped 404.
 */
const REFUSED_BEARER = 'a-bearer-no-deployment-accepts';

const OPEN_ASSERTION: Assertion = {
    categoryId: 'level',
    conceptId: 'OPEN',
    confidence: 'certain',
    source: 'explicit',
};

/** How a replay client is bound for the cases a driver covers. */
export type BindingName =
    | 'open'
    | 'open-with-credential'
    | 'open-with-recorded-route-credential'
    | 'discovery'
    | 'ctx:ez-controls'
    | 'ctx:ez-crosswalk'
    | 'ctx:ez-full'
    | 'ctx:ez-full-bad-credential'
    | 'ctx:ez-full-no-carrier'
    | 'ctx:ez-gated'
    | 'ctx:ez-minimal'
    | 'ctx:ez-presets'
    | 'ctx:ez-release'
    | 'ctx:ez-share';

/**
 * Build the client a driver runs against.
 *
 * The heartbeat is off in every binding: a background health poll would put a
 * request on the wire that no case expects, and the poll has nothing to keep
 * warm against a recording.
 *
 * The base URL is an argument because the same drivers run twice. In the fast
 * lane they run against an in-process transport at a URL nothing dials; in the
 * server lane they run against a replay server over real HTTP. Anything that
 * only holds in one of the two is a property of the harness rather than of the
 * client, and running both is how that shows.
 *
 * @param binding - Which binding the driver declared
 * @param baseUrl - Where the client points
 * @param fetchImpl - Transport override; the platform's fetch when omitted
 * @returns A client bound the way the driver asked for
 */
export function buildClient(
    binding: BindingName,
    baseUrl: string,
    fetchImpl?: typeof fetch,
): EzClassifyClient {
    const shared = { heartbeat: false, ...(fetchImpl ? { fetchImpl } : {}) };
    switch (binding) {
        case 'open':
            return new EzClassifyClient(baseUrl, shared);
        case 'open-with-recorded-route-credential':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                headers:
                    corpus.byId.get('route-miss.route-not-found')?.auth
                        .credential === 'context-token'
                        ? { 'X-EzClassify-Context-Token': CONTEXT_CARRIER }
                        : {},
            });
        case 'open-with-credential':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                auth: { token: REFUSED_BEARER },
            });
        case 'discovery':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextToken: CONTEXT_CARRIER,
            });
        case 'ctx:ez-full':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-full',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-full-no-carrier':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-full',
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-full-bad-credential':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                auth: { token: REFUSED_BEARER },
                contextId: 'ez-full',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-gated':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-gated',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-minimal':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-minimal',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-presets':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-presets',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-release':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-release',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-controls':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-controls',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-crosswalk':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-crosswalk',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
        case 'ctx:ez-share':
            return new EzClassifyClient(baseUrl, {
                ...shared,
                contextId: 'ez-share',
                contextToken: CONTEXT_CARRIER,
                contextVersion: '1.0.0',
            });
    }
}

/**
 * Build the client for the in-process replay lane.
 *
 * @param binding - Which binding the driver declared
 * @param fetchImpl - The replay transport
 * @returns A client pointed at the replay transport
 */
export function buildReplayClient(
    binding: BindingName,
    fetchImpl: typeof fetch,
): EzClassifyClient {
    return buildClient(binding, REPLAY_BASE_URL, fetchImpl);
}

/** How a driver's client call settled. */
export type DriverOutcome =
    | { settled: 'resolved'; value: unknown }
    | { settled: 'rejected'; error: unknown };

/** Reads a recorded case this driver declared. */
export type RecordedLookup = (caseId: string) => WireCase;

/** One client call, the cases it replays, and what its answer has to be. */
export interface WireDriver {
    /** How the client is bound for this call. */
    binding: BindingName;
    /** Corpus cases the call emits, in any order. */
    cases: readonly string[];
    /** The call itself, on the public client surface. */
    run(client: EzClassifyClient): Promise<unknown>;
    /** What the recorded responses had to parse into. */
    verify(outcome: DriverOutcome, recorded: RecordedLookup): void;
    /** Extra checks on the emitted request, beyond the canonical match. */
    assertRequest?: RequestAssertion;
}

/** The recorded response body for a case. */
function body(
    recorded: RecordedLookup,
    caseId: string,
): Record<string, unknown> {
    return recorded(caseId).response.body as Record<string, unknown>;
}

/** The result a context-bound client unwraps out of the recorded envelope. */
function result(recorded: RecordedLookup, caseId: string): unknown {
    return body(recorded, caseId)['result'];
}

/** The value a driver resolved with, or a failure naming what it threw. */
function resolved(outcome: DriverOutcome): unknown {
    if (outcome.settled === 'rejected') {
        const error = outcome.error;
        throw error instanceof Error
            ? error
            : new Error(`driver rejected with ${String(error)}`);
    }
    return outcome.value;
}

/** The error a driver threw, typed, or a failure saying it did not throw. */
function rejected(outcome: DriverOutcome): EzClassifyError {
    if (outcome.settled === 'resolved') {
        throw new Error(
            `expected the client to throw, it resolved with ${JSON.stringify(outcome.value)}`,
        );
    }
    if (!(outcome.error instanceof EzClassifyError)) {
        throw new Error(
            `expected an EzClassifyError, got ${String(outcome.error)}`,
        );
    }
    return outcome.error;
}

/** Deep equality against a recorded value, with a readable failure. */
function equals(actual: unknown, expected: unknown, what: string): void {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    if (left !== right) {
        throw new Error(`${what}\n  parsed:   ${left}\n  recorded: ${right}`);
    }
}

/**
 * A driver whose whole answer is the recorded body, or the result inside the
 * recorded envelope on a context-bound client.
 *
 * Most operations are this: the client parses the response and hands it back
 * whole, so the expectation is derived from the recording rather than restated
 * beside it.
 */
function passthrough(
    binding: BindingName,
    caseId: string,
    run: (client: EzClassifyClient) => Promise<unknown>,
): WireDriver {
    const unwraps = binding.startsWith('ctx:');
    return {
        binding,
        cases: [caseId],
        run,
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                unwraps ? result(recorded, caseId) : body(recorded, caseId),
                `${caseId}: the client did not hand back what the runtime answered`,
            ),
    };
}

/** A driver whose call must fail, checked against the recorded refusal. */
function failure(
    binding: BindingName,
    caseId: string,
    run: (client: EzClassifyClient) => Promise<unknown>,
    check: (error: EzClassifyError, recorded: RecordedLookup) => void,
    assertRequest?: RequestAssertion,
): WireDriver {
    return {
        assertRequest,
        binding,
        cases: [caseId],
        run,
        verify: (outcome, recorded) => check(rejected(outcome), recorded),
    };
}

/** A Context refusal must retain the recorded status, code and whole body. */
function recordedRefusal(
    caseId: string,
    run: (client: EzClassifyClient) => Promise<unknown>,
    binding: BindingName = 'ctx:ez-full',
): WireDriver {
    return failure(binding, caseId, run, (error, recorded) => {
        const response = recorded(caseId).response;
        equals(error.status, response.status, `${caseId}: response status`);
        equals(error.body, response.body, `${caseId}: refusal body`);
        equals(
            error.code,
            body(recorded, caseId)['code'] ?? 'HTTP',
            `${caseId}: refusal code`,
        );
        if (error.possiblyUnauthenticated) {
            throw new Error(
                `${caseId}: an input or named-resource refusal is not a credential denial`,
            );
        }
    });
}

/**
 * Every corpus case this client's surface can reach, and the call that reaches
 * it.
 */
export const WIRE_DRIVERS: Readonly<Record<string, WireDriver>> = {
    // -- probes ------------------------------------------------------------

    'health.ok': {
        binding: 'open',
        cases: ['health.ok'],
        run: (client) => client.ping(),
        verify: (outcome, recorded) => {
            const health = body(recorded, 'health.ok');
            equals(
                resolved(outcome),
                {
                    engineVersion: health['engineVersion'],
                    engineSha: health['engineSha'],
                    gitTag: health['gitTag'],
                },
                'health.ok: ping did not report the runtime the recording came from',
            );
        },
    },

    'denial.authenticated-health-still-open': {
        binding: 'open-with-credential',
        cases: ['denial.authenticated-health-still-open'],
        run: (client) => client.ping(),
        verify: (outcome) => {
            const ping = resolved(outcome) as { engineVersion: string };
            if (ping.engineVersion === '') {
                throw new Error(
                    'liveness answered, but the client read no wire version out of it',
                );
            }
        },
    },

    // -- context resolution ------------------------------------------------

    'ctx-list.ok': {
        binding: 'discovery',
        cases: ['ctx-list.ok'],
        run: (client) => client.listContexts(),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-list.ok')['contexts'],
                'Context discovery must return every visible Context id',
            ),
    },

    'ctx-versions.ok': {
        binding: 'discovery',
        cases: ['ctx-versions.ok'],
        run: (client) => client.listContextVersions('ez-full'),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-versions.ok')['versions'],
                'Context discovery must return every published version',
            ),
    },

    // Everything a context-bound connect resolves before it can render: the
    // description, and the scheme profile warmed from it. They are one driver
    // because they are one exchange, and because the second is issued at the
    // concrete version the first reports.
    //
    // The composition here declares no formats, no scopes and no presets, which
    // is where an assembly quietly goes wrong: a default render format guessed
    // from an empty format list, or a `[]` preset response read as "the route
    // is missing". ctx-scheme.profile covers the same warm over a scheme that
    // declares all three.
    'ctx-describe.ok': {
        binding: 'ctx:ez-full',
        cases: [
            'ctx-describe.ok',
            'ctx-scheme-summary.full',
            'ctx-scheme-concepts.full',
            'ctx-scheme-categories.full',
            'ctx-scheme-formats.full',
            'ctx-scheme-grammar.full',
            'ctx-scheme-scopes.full',
            'ctx-scheme-label-presets.full',
        ],
        run: async (client) => ({
            description: await client.describeContext(),
            profile: await client.fetchProfile(),
            schemes: await client.describeSchemes(),
        }),
        verify: (outcome, recorded) => {
            const both = resolved(outcome) as {
                description: Record<string, unknown>;
                profile: Record<string, unknown>;
                schemes: unknown;
            };
            const wire = body(recorded, 'ctx-describe.ok');
            equals(both.description['id'], wire['id'], 'context id');
            equals(
                both.description['version'],
                wire['version'],
                'context version',
            );
            equals(
                both.description['scheme'],
                wire['scheme'],
                'composed scheme',
            );
            equals(
                both.description['guides'],
                wire['guides'],
                'declared guides',
            );
            equals(
                both.description['access'],
                wire['access'],
                'access component',
            );
            equals(
                both.description['schemes'],
                wire['schemes'],
                'the held-scheme inventory',
            );

            // The inventory is the only place a caller learns what to pass as
            // `?scheme=`, and the selector is a Context-local key rather than
            // the component id, so nothing else in the response can stand in
            // for it. Reading it back through describeSchemes() proves the
            // accessor returns the recorded inventory whole instead of one
            // entry reconstructed from `scheme`.
            equals(
                both.schemes,
                wire['schemes'],
                'describeSchemes must report the recorded inventory',
            );

            const summary = body(recorded, 'ctx-scheme-summary.full');
            equals(both.profile['id'], summary['id'], 'the profile id');
            equals(
                both.profile['concepts'],
                recorded('ctx-scheme-concepts.full').response.body,
                'the profile concepts must be the recorded list',
            );
            equals(
                both.profile['categories'],
                recorded('ctx-scheme-categories.full').response.body,
                'the profile categories must be the recorded list',
            );
            // Read from the recording like every sibling here: whatever the
            // route sends arrives unchanged, and an empty list is an answer.
            equals(
                both.profile['scopes'],
                recorded('ctx-scheme-scopes.full').response.body,
                'the scopes arrive as recorded, an empty list included',
            );
            equals(
                both.profile['labelPresets'],
                recorded('ctx-scheme-label-presets.full').response.body,
                'an empty preset list is an answer, not a missing route',
            );
            equals(
                both.description['crosswalks'],
                wire['crosswalks'] ?? [],
                'a description that sends no crosswalks reports an empty list',
            );
        },
    },

    // A Context that declares a crosswalk: the description names it with the
    // version it was declared at and the version it resolved to. The scheme
    // inventory names the crosswalk's target as a held scheme.
    'ctx-describe.crosswalks': {
        binding: 'ctx:ez-crosswalk',
        cases: ['ctx-describe.crosswalks'],
        run: (client) => client.describeContext(),
        verify: (outcome, recorded) => {
            const description = resolved(outcome) as Record<string, unknown>;
            const wire = body(recorded, 'ctx-describe.crosswalks');
            equals(
                description['crosswalks'],
                wire['crosswalks'],
                'the declared crosswalks',
            );
            equals(description['scheme'], wire['scheme'], 'composed scheme');
            equals(
                description['schemes'],
                wire['schemes'],
                'the held-scheme inventory, crosswalk target included',
            );
        },
    },

    // -- composed document operations --------------------------------------

    'ctx-document-audit.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-document-audit.ok'],
        run: (client) =>
            client.context.audit({
                responseProfile: 'summary',
                text: 'OPEN\nThis document is releasable.',
            }),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-document-audit.ok'),
                'audit keeps the resolved Context envelope whole',
            ),
    },

    'ctx-document-audit.empty-text': failure(
        'ctx:ez-full',
        'ctx-document-audit.empty-text',
        (client) => client.context.audit({ text: '' }),
        (error, recorded) => {
            const wire = body(recorded, 'ctx-document-audit.empty-text');
            if (error.status !== 400) {
                throw new Error(`expected 400, got ${String(error.status)}`);
            }
            equals(error.code, wire['code'], 'the refusal keeps the wire code');
            equals(
                error.detail,
                wire['detail'],
                'the refusal keeps the wire detail',
            );
        },
    ),

    // -- scheme resources under a Context ----------------------------------

    // The eight-request warm a context-bound connect runs, replayed as one
    // exchange. This is the driver the whole ctx scheme resource family exists
    // for: a browser cannot render until this assembly answers, and asserting
    // the pieces separately would prove the routes reply without proving the
    // profile they add up to.
    'ctx-scheme.profile': {
        binding: 'ctx:ez-presets',
        cases: [
            'ctx-describe.presets',
            'ctx-scheme-summary.ok',
            'ctx-scheme-concepts.ok',
            'ctx-scheme-categories.ok',
            'ctx-scheme-formats.ok',
            'ctx-scheme-grammar.ok',
            'ctx-scheme-scopes.ok',
            'ctx-scheme-label-presets.ok',
        ],
        run: async (client) => ({
            profile: await client.fetchProfile(),
            meta: client.getSchemeMeta(),
        }),
        verify: (outcome, recorded) => {
            const { profile, meta } = resolved(outcome) as {
                profile: Record<string, unknown>;
                meta: Record<string, unknown>;
            };
            const summary = body(recorded, 'ctx-scheme-summary.ok');
            equals(profile['id'], summary['id'], 'the profile id');
            equals(
                profile['defaultRenderFormat'],
                summary['defaultRenderFormat'],
                'the default render format must come from the summary, not from formats[0]',
            );
            equals(
                profile['concepts'],
                recorded('ctx-scheme-concepts.ok').response.body,
                'the profile concepts must be the recorded list',
            );
            equals(
                profile['categories'],
                recorded('ctx-scheme-categories.ok').response.body,
                'the profile categories must be the recorded list',
            );
            const formats = recorded('ctx-scheme-formats.ok').response
                .body as Array<Record<string, unknown>>;
            equals(
                profile['formats'],
                formats,
                'the profile formats must be the recorded format views',
            );
            equals(
                meta['formats'],
                formats.map(({ syntax: _syntax, ...layout }) => layout),
                'the metadata retains every recorded presentation layout field',
            );
            equals(
                profile['scopes'],
                recorded('ctx-scheme-scopes.ok').response.body,
                'the profile scopes must be the recorded definitions',
            );
            equals(
                profile['labelPresets'],
                recorded('ctx-scheme-label-presets.ok').response.body,
                'the profile presets must be the recorded preset views',
            );
        },
    },

    'ctx-scheme-apply-preset.ok': passthrough(
        'ctx:ez-presets',
        'ctx-scheme-apply-preset.ok',
        (client) => client.scheme.applyPreset('sensitive-preset'),
    ),

    'ctx-scheme-apply-preset.unknown': failure(
        'ctx:ez-presets',
        'ctx-scheme-apply-preset.unknown',
        (client) => client.scheme.applyPreset('no-such-preset'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a named missing preset is a resource answer, not a suspected denial',
                );
            }
        },
    ),

    // -- scheme operations under a Context ---------------------------------

    'ctx-scheme-process.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-process.ok',
        (client) => client.scheme.process('OPEN'),
    ),

    'ctx-scheme-validate.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-validate.ok',
        (client) => client.scheme.validate('OPEN'),
    ),

    // Facts as stated go out as `assertions` and nothing else. The recording
    // carries no `input`, so a client that sent the empty one process sends
    // beside its facts would stop matching here.
    'ctx-scheme-validate.assertions': passthrough(
        'ctx:ez-full',
        'ctx-scheme-validate.assertions',
        (client) => client.scheme.validate([OPEN_ASSERTION]),
    ),

    // The two options only the author's call takes. The recorded body names
    // one output and one category, and the result carries a render for that
    // output alone and picker options for that category alone.
    'ctx-scheme-process.outputs-and-options': passthrough(
        'ctx:ez-full',
        'ctx-scheme-process.outputs-and-options',
        (client) =>
            client.scheme.process('OPEN', {
                outputs: ['default'],
                suggestFor: ['level'],
            }),
    ),

    'ctx-scheme-explain.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-explain.ok',
        (client) => client.scheme.explain('OPEN'),
    ),

    // The envelope's result is itself `{ result: "<marking>" }`, so a
    // context-bound caller is two layers away from the string the method
    // promises. Both layers are peeled inside the cached call.
    'ctx-scheme-normalize.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-scheme-normalize.ok'],
        run: (client) => client.scheme.normalize('open'),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                (
                    result(recorded, 'ctx-scheme-normalize.ok') as {
                        result: string;
                    }
                ).result,
                'normalize under a Context must still hand back the plain marking',
            ),
    },

    'ctx-scheme-render.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-scheme-render.ok'],
        run: (client) => client.scheme.render([OPEN_ASSERTION]),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                (() => {
                    const wire = result(recorded, 'ctx-scheme-render.ok') as {
                        result: string;
                        assessment: unknown;
                    };
                    return {
                        rendered: wire.result,
                        assessment: wire.assessment,
                    };
                })(),
                'render under a Context returns the rendered marking and assessment',
            ),
    },

    // What @ezclassify/ui emits before an author types: an empty marking through
    // process, and the empty assertion list through render. A surface that
    // cannot get through its own first render never mounts, so these are the
    // two calls a browser makes that nothing else here would cover.
    'ctx-scheme-process.empty': passthrough(
        'ctx:ez-full',
        'ctx-scheme-process.empty',
        (client) => client.scheme.process('', { outputFormat: 'default' }),
    ),

    'ctx-scheme-render.empty': {
        binding: 'ctx:ez-full',
        cases: ['ctx-scheme-render.empty'],
        run: (client) => client.scheme.render([], 'default'),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                (() => {
                    const wire = result(
                        recorded,
                        'ctx-scheme-render.empty',
                    ) as { result: string; assessment: unknown };
                    return {
                        rendered: wire.result,
                        assessment: wire.assessment,
                    };
                })(),
                'an empty render returns its marking and assessment',
            ),
    },

    'ctx-scheme-diff.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-diff.ok',
        (client) => client.scheme.diff('OPEN', 'SENSITIVE'),
    ),

    'ctx-scheme-view.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-view.ok',
        (client) => client.scheme.buildSchemeView(),
    ),

    'ctx-scheme-notices.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-notices.ok',
        (client) => client.scheme.collectNotices([OPEN_ASSERTION]),
    ),

    'ctx-scheme-filter-concepts.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-scheme-filter-concepts.ok'],
        run: (client) => client.scheme.filterConcepts('open'),
        verify: (outcome, recorded) => {
            const wire = result(recorded, 'ctx-scheme-filter-concepts.ok') as {
                visibleIds: string[];
            };
            const parsed = resolved(outcome) as { visibleIds: Set<string> };
            equals(
                [...parsed.visibleIds],
                wire.visibleIds,
                'filtering under a Context must hydrate the ids inside the envelope',
            );
        },
    },

    'ctx-scheme-filter-concepts.no-match': {
        binding: 'ctx:ez-full',
        cases: ['ctx-scheme-filter-concepts.no-match'],
        run: (client) => client.scheme.filterConcepts('zzznomatch'),
        verify: (outcome) => {
            const parsed = resolved(outcome) as { visibleIds: Set<string> };
            if (parsed.visibleIds.size !== 0) {
                throw new Error('a query matching nothing came back with ids');
            }
        },
    },

    'ctx-scheme-scan.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-scan.ok',
        (client) => client.scheme.scan('OPEN document for review'),
    ),

    'ctx-scheme-aggregate.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-aggregate.ok',
        (client) => client.scheme.aggregate(['OPEN', 'SENSITIVE']),
    ),

    'ctx-scheme-aggregate.assertion-sets': passthrough(
        'ctx:ez-full',
        'ctx-scheme-aggregate.assertion-sets',
        (client) =>
            client.scheme.aggregateAssertions([
                [OPEN_ASSERTION],
                [{ ...OPEN_ASSERTION, conceptId: 'SENSITIVE' }],
            ]),
    ),

    'ctx-scheme-suggest.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-suggest.ok',
        (client) => client.scheme.suggest(''),
    ),

    'ctx-scheme-suggest.gated-hidden': passthrough(
        'ctx:ez-gated',
        'ctx-scheme-suggest.gated-hidden',
        (client) => client.scheme.suggest('', { filter: 'export' }),
    ),

    'ctx-scheme-suggest.gated-included': passthrough(
        'ctx:ez-gated',
        'ctx-scheme-suggest.gated-included',
        (client) =>
            client.scheme.suggest('', { filter: 'export', includeGated: true }),
    ),

    // The answer is the map itself, keyed by the categories named, so the
    // whole result is the comparison.
    'ctx-scheme-suggest-for-categories.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-suggest-for-categories.ok',
        (client) =>
            client.scheme.suggestForCategories([OPEN_ASSERTION], ['level']),
    ),

    'ctx-scheme-suggest-for-categories.empty-baseline': passthrough(
        'ctx:ez-full',
        'ctx-scheme-suggest-for-categories.empty-baseline',
        (client) => client.scheme.suggestForCategories([], ['level']),
    ),

    'ctx-scheme-check-coverage.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-check-coverage.ok',
        (client) => client.scheme.checkCoverage(['OPEN'], 'SENSITIVE'),
    ),

    'ctx-scheme-check-coverage.excess': passthrough(
        'ctx:ez-share',
        'ctx-scheme-check-coverage.excess',
        (client) =>
            client.scheme.checkCoverage(
                ['OPEN//ALPHA/BRAVO', 'OPEN//BRAVO/CHARLIE'],
                'OPEN//ALPHA/BRAVO/CHARLIE',
            ),
    ),

    'ctx-scheme-check-coverage.pipeline': passthrough(
        'ctx:ez-release',
        'ctx-scheme-check-coverage.pipeline',
        (client) =>
            client.scheme.checkCoverage(
                ['OPEN//SHARED ALPHA, BRAVO'],
                'OPEN//SHARED ALPHA, CHARLIE',
            ),
    ),

    'ctx-scheme-check-coverage.pipeline-narrowed': passthrough(
        'ctx:ez-controls',
        'ctx-scheme-check-coverage.pipeline-narrowed',
        (client) =>
            client.scheme.checkCoverage(
                ['OPEN//VIEW ALPHA, BRAVO'],
                'OPEN//SHARED ALPHA, BRAVO//VIEW ALPHA, BRAVO',
            ),
    ),

    'ctx-scheme-describe-concept.ok': passthrough(
        'ctx:ez-full',
        'ctx-scheme-describe-concept.ok',
        (client) => client.scheme.describeConcept('OPEN', 'level'),
    ),

    // -- access -------------------------------------------------------------

    'ctx-access-check.marking': {
        binding: 'ctx:ez-full',
        cases: ['ctx-access-check.marking'],
        run: (client) =>
            client.context.checkAccess(
                'OPEN',
                { clearance: 'OPEN' },
                requestContext('ctx-access-check.marking'),
            ),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-access-check.marking'),
                'context.checkAccess keeps the resolved Context envelope',
            ),
    },

    // The attribute map has no order on the wire; the recording sends it in one
    // order and the client builds it in the caller's.
    'ctx-access-check.two-attributes': {
        binding: 'ctx:ez-full',
        cases: ['ctx-access-check.two-attributes'],
        run: (client) =>
            client.context.checkAccess(
                'OPEN',
                {
                    clearance: 'OPEN',
                    organization: 'records',
                },
                requestContext('ctx-access-check.two-attributes'),
            ),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-access-check.two-attributes'),
                'context.checkAccess keeps the resolved Context envelope',
            ),
    },

    'ctx-access-check.assertions': passthrough(
        'ctx:ez-full',
        'ctx-access-check.assertions',
        (client) =>
            client.access.check(
                [OPEN_ASSERTION],
                { clearance: 'OPEN' },
                requestContext('ctx-access-check.assertions'),
            ),
    ),

    'ctx-access-describe-rule.ok': passthrough(
        'ctx:ez-full',
        'ctx-access-describe-rule.ok',
        (client) => client.access.describeAccessRule('level-rule'),
    ),

    'ctx-access-describe-requirements.ok': passthrough(
        'ctx:ez-full',
        'ctx-access-describe-requirements.ok',
        (client) =>
            client.access.describeAccessRequirements({ marking: 'OPEN' }),
    ),

    'ctx-access-rules.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-access-rules.ok'],
        run: (client) => client.access.describeAllAccessRules(),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-access-rules.ok')['rules'],
                'the rule list is read off the recorded `rules` array',
            ),
    },

    'ctx-access-rules.no-policy': failure(
        'ctx:ez-minimal',
        'ctx-access-rules.no-policy',
        (client) => client.access.describeAllAccessRules(),
        (error) => {
            if (error.status !== 422) {
                throw new Error(`expected 422, got ${String(error.status)}`);
            }
        },
    ),

    // -- guides -------------------------------------------------------------

    'ctx-guide-scan.ok': passthrough(
        'ctx:ez-full',
        'ctx-guide-scan.ok',
        (client) => client.guide.scan('This paragraph is confidential.'),
    ),

    'ctx-guide-evaluate.ok': passthrough(
        'ctx:ez-full',
        'ctx-guide-evaluate.ok',
        (client) => client.guide.evaluate('ez-test', ['rule-sensitive']),
    ),

    'ctx-guide-evaluate.all-guides': passthrough(
        'ctx:ez-full',
        'ctx-guide-evaluate.all-guides',
        (client) => client.guide.evaluateMany(['rule-sensitive']),
    ),

    'ctx-guide-describe-rule.ok': passthrough(
        'ctx:ez-full',
        'ctx-guide-describe-rule.ok',
        (client) => client.guide.describeRule('rule-sensitive'),
    ),

    'ctx-guide-describe-rule.unknown-guide': failure(
        'ctx:ez-full',
        'ctx-guide-describe-rule.unknown-guide',
        (client) =>
            client.guide.describeRule('rule-sensitive', 'no-such-guide'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a named missing guide is a resource answer, not a suspected denial',
                );
            }
        },
    ),

    'ctx-guide-filter-rules.ok': {
        binding: 'ctx:ez-full',
        cases: ['ctx-guide-filter-rules.ok'],
        run: (client) => client.guide.filterRules('sensitive'),
        verify: (outcome, recorded) => {
            const wire = result(recorded, 'ctx-guide-filter-rules.ok') as {
                visibleIds: string[];
            };
            const parsed = resolved(outcome) as { visibleIds: Set<string> };
            equals(
                [...parsed.visibleIds],
                wire.visibleIds,
                'filterRules must hydrate the recorded ids into a Set',
            );
        },
    },

    'ctx-guide-view.ok': passthrough(
        'ctx:ez-full',
        'ctx-guide-view.ok',
        (client) => client.guide.buildGuideView(),
    ),

    // The per-guide view a client warms its guide metadata with at connect. It
    // names the guide; the merged view above does not.
    'ctx-guide-view.by-id': passthrough(
        'ctx:ez-full',
        'ctx-guide-view.by-id',
        (client) => client.guide.buildGuideView('ez-test'),
    ),

    // -- crosswalk ----------------------------------------------------------

    // The recording Context declares no crosswalk, so every recorded translate
    // is the same 422. What the two driven cases still prove is the half of the
    // exactly-one-source rule that lives on this side of the wire: which field
    // the client puts the source in, and that it never sends both.
    'ctx-crosswalk-translate.marking': failure(
        'ctx:ez-full',
        'ctx-crosswalk-translate.marking',
        (client) =>
            client.context.translate({
                crosswalkId: 'ez-test-to-ez-gated',
                marking: 'OPEN',
            }),
        (error) => {
            if (error.status !== 422) {
                throw new Error(`expected 422, got ${String(error.status)}`);
            }
        },
        (request) => {
            const sent = request.body as Record<string, unknown>;
            if (!('marking' in sent) || 'assertions' in sent) {
                throw new Error(
                    'a string source must go out as `marking` alone; the wire takes exactly one source',
                );
            }
        },
    ),

    'ctx-crosswalk-translate.assertions': failure(
        'ctx:ez-full',
        'ctx-crosswalk-translate.assertions',
        (client) =>
            client.context.translate({
                crosswalkId: 'ez-test-to-ez-gated',
                marking: [OPEN_ASSERTION],
            }),
        (error) => {
            if (error.status !== 422) {
                throw new Error(`expected 422, got ${String(error.status)}`);
            }
        },
        (request) => {
            const sent = request.body as Record<string, unknown>;
            if (!('assertions' in sent) || 'marking' in sent) {
                throw new Error(
                    'an assertion source must go out as `assertions` alone; the wire takes exactly one source',
                );
            }
        },
    ),

    // A Context that declares the crosswalk answers the translation under its
    // envelope: the carried mapping, and the prohibition that refuses one.
    'ctx-crosswalk-translate.translated': {
        binding: 'ctx:ez-crosswalk',
        cases: ['ctx-crosswalk-translate.translated'],
        run: (client) =>
            client.context.translate({
                crosswalkId: 'ez-test-to-ez-gated',
                marking: 'OPEN',
            }),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-crosswalk-translate.translated'),
                'translate keeps the resolved Context envelope',
            ),
    },

    'ctx-crosswalk-translate.forbidden': {
        binding: 'ctx:ez-crosswalk',
        cases: ['ctx-crosswalk-translate.forbidden'],
        run: (client) =>
            client.context.translate({
                crosswalkId: 'ez-test-to-ez-gated',
                marking: 'SENSITIVE',
            }),
        verify: (outcome, recorded) =>
            equals(
                resolved(outcome),
                body(recorded, 'ctx-crosswalk-translate.forbidden'),
                'a prohibited translation is an answer under the envelope, not an error',
            ),
    },

    // Facts travel as facts alone, with their caller provenance unchanged.
    'ctx-scheme-suggest.facts': passthrough(
        'ctx:ez-full',
        'ctx-scheme-suggest.facts',
        (client) => client.scheme.suggest([OPEN_ASSERTION]),
    ),

    'ctx-scheme-process.undeclared-format': recordedRefusal(
        'ctx-scheme-process.undeclared-format',
        (client) => client.scheme.process('OPEN', { outputFormat: 'nope' }),
    ),
    'ctx-scheme-suggest.input-format-with-facts': recordedRefusal(
        'ctx-scheme-suggest.input-format-with-facts',
        (client) =>
            client.scheme.suggest([OPEN_ASSERTION], { inputFormat: 'default' }),
    ),
    'ctx-scheme-describe-concept.unknown-concept': recordedRefusal(
        'ctx-scheme-describe-concept.unknown-concept',
        (client) => client.scheme.describeConcept('NOPE', 'level'),
    ),

    // Typed methods exclude these raw shapes: unknown body fields, missing or
    // duplicate marking operands, and an input format beside assertion sets.
    // The client's request transport sends a request outside those signatures.
    // Replaying it still proves the real credential and error path.
    'ctx-scheme-aggregate.input-format-with-sets': recordedRefusal(
        'ctx-scheme-aggregate.input-format-with-sets',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/aggregate', {
                assertionSets: [[OPEN_ASSERTION]],
                inputFormat: 'default',
            }),
    ),
    'ctx-scheme-suggest.both-sources': recordedRefusal(
        'ctx-scheme-suggest.both-sources',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/suggest', {
                assertions: [OPEN_ASSERTION],
                input: 'OPEN',
            }),
    ),
    'ctx-scheme-suggest.no-source': recordedRefusal(
        'ctx-scheme-suggest.no-source',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/suggest', {}),
    ),
    'ctx-scheme-process.undeclared-request-field-fix': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-fix',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                fix: true,
                input: 'OPEN',
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-preserveDeprecated':
        recordedRefusal(
            'ctx-scheme-process.undeclared-request-field-preserveDeprecated',
            (client) =>
                client._request(
                    'POST',
                    '/v1/ctx/ez-full/1.0.0/scheme/process',
                    {
                        input: 'OPEN',
                        preserveDeprecated: true,
                    },
                ),
        ),
    'ctx-scheme-process.undeclared-request-field-normalization':
        recordedRefusal(
            'ctx-scheme-process.undeclared-request-field-normalization',
            (client) =>
                client._request(
                    'POST',
                    '/v1/ctx/ez-full/1.0.0/scheme/process',
                    {
                        input: 'OPEN',
                        normalization: 'strict',
                    },
                ),
        ),
    'ctx-scheme-process.undeclared-request-field-skipRepair': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-skipRepair',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                input: 'OPEN',
                skipRepair: true,
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-skipInference':
        recordedRefusal(
            'ctx-scheme-process.undeclared-request-field-skipInference',
            (client) =>
                client._request(
                    'POST',
                    '/v1/ctx/ez-full/1.0.0/scheme/process',
                    {
                        input: 'OPEN',
                        skipInference: true,
                    },
                ),
        ),
    'ctx-scheme-process.undeclared-request-field-tolerant': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-tolerant',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                input: 'OPEN',
                tolerant: true,
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-validateOnly': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-validateOnly',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                input: 'OPEN',
                validateOnly: true,
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-scope': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-scope',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                input: 'OPEN',
                scope: 'banner',
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-format': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-format',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                format: 'default',
                input: 'OPEN',
            }),
    ),
    'ctx-scheme-process.undeclared-request-field-repairStrategy':
        recordedRefusal(
            'ctx-scheme-process.undeclared-request-field-repairStrategy',
            (client) =>
                client._request(
                    'POST',
                    '/v1/ctx/ez-full/1.0.0/scheme/process',
                    {
                        input: 'OPEN',
                        repairStrategy: 'first',
                    },
                ),
        ),
    'ctx-scheme-process.undeclared-request-field-unknownField': recordedRefusal(
        'ctx-scheme-process.undeclared-request-field-unknownField',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {
                input: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-scheme-validate.undeclared-field': recordedRefusal(
        'ctx-scheme-validate.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/validate', {
                input: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-scheme-explain.undeclared-field': recordedRefusal(
        'ctx-scheme-explain.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/explain', {
                input: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-scheme-normalize.undeclared-field': recordedRefusal(
        'ctx-scheme-normalize.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/normalize', {
                input: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-scheme-aggregate.undeclared-field': recordedRefusal(
        'ctx-scheme-aggregate.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/aggregate', {
                inputs: ['OPEN'],
                unknownField: true,
            }),
    ),
    'ctx-scheme-suggest.undeclared-field': recordedRefusal(
        'ctx-scheme-suggest.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/suggest', {
                input: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-scheme-suggest-for-categories.undeclared-field': recordedRefusal(
        'ctx-scheme-suggest-for-categories.undeclared-field',
        (client) =>
            client._request(
                'POST',
                '/v1/ctx/ez-full/1.0.0/scheme/suggest-for-categories',
                { assertions: [], categoryIds: ['level'], unknownField: true },
            ),
    ),
    'ctx-scheme-render.undeclared-field': recordedRefusal(
        'ctx-scheme-render.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/render', {
                assertions: [OPEN_ASSERTION],
                unknownField: true,
            }),
    ),
    'ctx-scheme-scan.undeclared-field': recordedRefusal(
        'ctx-scheme-scan.undeclared-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/scan', {
                text: 'OPEN',
                unknownField: true,
            }),
    ),
    'ctx-document-audit.undeclared-guide-field': recordedRefusal(
        'ctx-document-audit.undeclared-guide-field',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/document/audit', {
                guideDeterminations: {
                    findings: [],
                    manualSelections: [],
                    unknownField: true,
                },
                text: 'OPEN',
            }),
    ),
    // The client builds no request that carries a query parameter the
    // contract does not declare. These replay the recorded refusals through the
    // raw transport, so the refusal path (status, code, `detail: query:<name>`)
    // is proven for each shape that a typed method cannot emit.
    'ctx-scheme-label-presets.undeclared-query-parameter': recordedRefusal(
        'ctx-scheme-label-presets.undeclared-query-parameter',
        (client) =>
            client._request(
                'GET',
                '/v1/ctx/ez-presets/1.0.0/scheme/label-presets?scheme=ez-presets',
            ),
        'ctx:ez-presets',
    ),
    'ctx-scheme-process.undeclared-query-parameter': recordedRefusal(
        'ctx-scheme-process.undeclared-query-parameter',
        (client) =>
            client._request(
                'POST',
                '/v1/ctx/ez-full/1.0.0/scheme/process?outputFormat=default',
                { input: 'OPEN' },
            ),
    ),
    'health.undeclared-query-parameter': recordedRefusal(
        'health.undeclared-query-parameter',
        (client) => client._request('GET', '/v1/health?verbose=1'),
        'open',
    ),
    'ctx-scheme-process.missing-input': recordedRefusal(
        'ctx-scheme-process.missing-input',
        (client) =>
            client._request('POST', '/v1/ctx/ez-full/1.0.0/scheme/process', {}),
    ),

    // -- refusals and route misses -----------------------------------------

    'denial.authenticated-no-credential': failure(
        'ctx:ez-full-no-carrier',
        'denial.authenticated-no-credential',
        (client) => client.scheme.process('OPEN'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a client with no credential configured has no grounds to suspect one; ' +
                        'flagging here would send every 404 to the wrong diagnosis',
                );
            }
            if (error.requestPath !== '/v1/ctx/ez-full/1.0.0/scheme/process') {
                throw new Error(
                    `the refusal must carry the path the runtime saw, got ${String(error.requestPath)}`,
                );
            }
        },
    ),

    'denial.authenticated-bad-credential': failure(
        'ctx:ez-full-bad-credential',
        'denial.authenticated-bad-credential',
        (client) => client.scheme.process('OPEN'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated !== true) {
                throw new Error(
                    'the constant denial shape reached a client holding a credential and was not flagged; ' +
                        'the caller will go hunting for a missing route',
                );
            }
        },
        (request) => {
            if (!request.headers['authorization']?.startsWith('Bearer ')) {
                throw new Error(
                    'the recording presented a bearer; the client sent none',
                );
            }
        },
    ),

    'denial.context-without-carrier': failure(
        'ctx:ez-full-no-carrier',
        'denial.context-without-carrier',
        (client) => client.scheme.process('OPEN'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a Context carrier is not a caller credential; only the caller credential earns the flag',
                );
            }
        },
        (request) => {
            if (request.headers['x-ezclassify-context-token'] !== undefined) {
                throw new Error(
                    'the recording presented no Context carrier; the client sent one',
                );
            }
        },
    ),

    'denial.ctx-scheme-without-carrier': failure(
        'ctx:ez-full-no-carrier',
        'denial.ctx-scheme-without-carrier',
        (client) =>
            client._request('GET', '/v1/ctx/ez-full/1.0.0/scheme/concepts'),
        (error) => {
            if (error.status !== 404) {
                throw new Error(`expected 404, got ${String(error.status)}`);
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a Context carrier is not a caller credential; only the caller credential earns the flag',
                );
            }
        },
        (request) => {
            if (request.headers['x-ezclassify-context-token'] !== undefined) {
                throw new Error(
                    'the recording presented no Context carrier; the client sent one',
                );
            }
        },
    ),

    'route-miss.route-not-found': failure(
        'open-with-recorded-route-credential',
        'route-miss.route-not-found',
        (client) => client._request('GET', '/v1/no-such-route'),
        (error) => {
            if (error.code !== 'route_not_found') {
                throw new Error(
                    `a route the deployment does not serve must keep its wire code, got ${String(error.code)}`,
                );
            }
            if (error.possiblyUnauthenticated) {
                throw new Error(
                    'a named route miss is not the constant denial shape and must not be flagged as one',
                );
            }
        },
    ),

    'route-miss.ctx-operation-not-found': failure(
        'ctx:ez-full',
        'route-miss.ctx-operation-not-found',
        (client) =>
            client._request(
                'POST',
                '/v1/ctx/ez-full/1.0.0/scheme/no-such-operation',
                {},
            ),
        (error) => {
            if (error.code !== 'route_not_found') {
                throw new Error(
                    `the Context dispatcher's own route miss must keep its wire code, got ${String(error.code)}`,
                );
            }
            if (
                error.requestPath !==
                '/v1/ctx/ez-full/1.0.0/scheme/no-such-operation'
            ) {
                throw new Error(
                    `the error must carry the rewritten path the runtime saw, got ${String(error.requestPath)}`,
                );
            }
        },
    ),

    'method-guard.allow-header': failure(
        'ctx:ez-full',
        'method-guard.allow-header',
        (client) =>
            client._request('GET', '/v1/ctx/ez-full/1.0.0/crosswalk/translate'),
        (error) => {
            if (error.status !== 405) {
                throw new Error(`expected 405, got ${String(error.status)}`);
            }
        },
    ),
};

/**
 * Corpus cases this client's surface cannot emit, and why.
 *
 * Every entry is a decision, not a backlog item to be worked off. Three shapes
 * appear: an operation the client has no method for, a request the client only
 * makes as one leg of a call whose other legs this corpus does not record, and
 * a body the client cannot build because its signature rules it out.
 */
export const EXCLUDED_CASES: Readonly<Record<string, string>> = {
    'ready.ok':
        'The client exposes liveness through ping() and no readiness probe. Readiness is a ' +
        'deployment concern answered by an orchestrator, not by an SDK caller.',

    'ctx-scheme-summary.layered':
        'Reached only inside the composite profile warm, which asks for seven sub-resources at ' +
        'once. This one is recorded against the layered context to pin composition, and the ' +
        'other six legs of that context are not recorded, so no client call can complete the ' +
        'fetch there. ctx-scheme.profile covers the assembly against ez-presets.',
    'ctx-scheme-concepts.layered':
        'Reached only inside the composite profile warm. See ctx-scheme-summary.layered.',
    'ctx-scheme-categories.layered':
        'Reached only inside the composite profile warm. See ctx-scheme-summary.layered.',
    'ctx-scheme-scopes.none':
        'Reached only inside the composite profile warm, and recorded against ez-minimal to pin ' +
        'the null answer while the other six legs of that context are not recorded. See ' +
        'ctx-scheme-summary.layered.',

    'ctx-scheme-validate.both-sources':
        'Not emittable. validate takes its marking as one operand: a string goes out as ' +
        'input, an array as assertions, never both. ctx-scheme-validate.ok and ' +
        'ctx-scheme-validate.assertions hold each half, because the replay refuses a body ' +
        'the recording did not carry.',
    'ctx-scheme-validate.no-source':
        'Not emittable. The marking operand is required, and an empty string still goes out ' +
        'as input. This is the runtime guarding hand-built requests.',

    'ctx-crosswalk-translate.both-sources':
        'Not emittable. The translate body carries exactly one source by construction: a string ' +
        'operand goes out as marking, an array as assertions, never both. The two driven ' +
        'translate cases assert that on the request itself.',
    'ctx-crosswalk-translate.no-source':
        'Not emittable. CrosswalkTranslationInput.marking is required, so a call with no source ' +
        'does not typecheck. This is the runtime guarding hand-built requests.',
};
