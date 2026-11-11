/**
 * Domain sub-operation classes for {@link EzClassifyClient}: `SchemeOps`,
 * `GuideOps`, and `AccessOps`. Each is accessed via `client.scheme.*`,
 * `client.guide.*`, and `client.access.*`. They hold no state of their own:
 * every method routes through the owning client's internal request surface.
 */

import { GENERIC_REFERENCE_SURFACE_NOUNS } from '@ezclassify/types';
import type {
    Assertion,
    DiffResult,
    SuggestResult,
    AccessDecision,
    AccessRuleDescription,
    ProcessingContext,
    CoverageReport,
    ScanOptions,
    SchemePublicView,
    RenderResult,
    SchemeMetaView,
    SchemeGrammar,
    CategoryView,
    ConceptView,
    GuideView,
    GuideMetaView,
    GuideScanResult,
    EvaluationResult,
    GuideRuleSelection,
    RuleDescription,
    GuideStructuralView,
    SchemeStructuralView,
    FilterResult,
    ConceptDescription,
    ContextCrosswalkDescriptor,
    ContextOperationResult,
    CrosswalkTranslationInput,
    CrosswalkTranslationResult,
    DocumentAssessmentInput,
    DocumentAuditReport,
    AccessRequirementsInput,
    AccessRequirementsDescription,
    RemoteAccessEngineAdapter,
    RemoteGuideEngineAdapter,
    RemoteContextSchemeEngineAdapter,
    ContextSchemes as ContextSchemesContract,
    ReferenceSurfaceKey,
    AggregateResult,
    ProcessResult,
    ValidateResult,
    ExplanationTrace,
    SuggestResultsByCategory,
    ScanOutcome,
    RenderOptions,
} from '@ezclassify/types';
import { EzClassifyError, ErrorCodes } from './errors';
import type {
    ContextSchemeProfile,
    EzClassifyClient,
} from './ezclassify-client';
import { SchemeState, deepFreeze } from './scheme-state';
import { parseContextOperationResult } from './context-envelope';
import { MAX_UNPINNED_TTL_MS } from './request-cache';

/**
 * Longer TTL for metadata-ish ops: concept descriptions don't change within a
 * session. The longest an unpinned entry is allowed to live.
 */
const LONG_TTL_MS = MAX_UNPINNED_TTL_MS;

/**
 * Shorter TTL for scan results: text may repeat but result currency matters
 * more.
 */
const SCAN_TTL_MS = 2 * 60 * 1000;

/**
 * Vocabulary key a guide uses to rename its own reference surface, per the
 * `GuideMetaView.referenceSurfaceLabel` contract in `@ezclassify/types`.
 *
 * The generic noun a guide that declares no override wears comes from the same
 * contract. A local engine resolves it at its own chokepoint and hands the
 * caller a finished `referenceSurfaceLabel`; no wire route reports a guide's,
 * so the client resolves the documented override key itself and falls back to
 * the published generic.
 */
const GUIDEBOOK_TERM_KEY: ReferenceSurfaceKey = 'guidebook';

/**
 * Build the wire body for `process` and `explain`, which take a marking as text
 * or facts and, in `options.assertions`, the facts already chosen.
 *
 * The wire carries text in `input` and facts in `assertions`, and `input` must
 * be a string or the server answers 400. Facts handed in as the marking go out
 * as `assertions` beside an empty `input`, which the server reads as facts with
 * no text, just as the local engine reads `op(facts)`.
 *
 * The engine settles the facts handed in and the facts already chosen as one
 * marking, so both go out in the one `assertions` list the wire has, in the
 * order the engine reads them (see {@link withChosenFacts}). Sending the
 * marking's facts alone would drop the chosen ones without a word.
 */
function markingBody(
    input: string | Assertion[],
    options?: Record<string, unknown>,
): Record<string, unknown> {
    if (!Array.isArray(input)) return { input, ...(options ?? {}) };
    const chosen = options?.assertions;
    // A chosen value that is not a list goes out as given, for the server to
    // refuse as it does beside text, rather than being dropped here.
    let assertions: unknown = input;
    if (Array.isArray(chosen)) assertions = withChosenFacts(input, chosen);
    else if (chosen !== undefined) assertions = chosen;
    return { ...(options ?? {}), input: '', assertions };
}

/**
 * The facts of a marking with the facts already chosen added, as one list: the
 * marking's facts in order, then each chosen fact the marking does not already
 * state. A fact both state goes out once, as the marking has it.
 *
 * This is the list the engine settles when it is handed facts and chosen facts
 * together. Two facts are the same fact when they share a category, a concept
 * and a value, an absent value being distinct from an empty one, which is how
 * the engine tells them apart.
 */
function withChosenFacts(
    stated: readonly Assertion[],
    chosen: readonly Assertion[],
): Assertion[] {
    const factKey = (fact: Assertion) =>
        JSON.stringify([
            fact.categoryId,
            fact.conceptId,
            fact.value === undefined ? null : fact.value,
        ]);
    const held = new Set(stated.map(factKey));
    return [...stated, ...chosen.filter((fact) => !held.has(factKey(fact)))];
}

/**
 * Build the wire body for `validate` and `suggest`, whose marking is text or
 * facts and never both.
 *
 * Unlike {@link markingBody}, there is no `input: ''` here. These requests carry
 * the marking in exactly one of `input` and `assertions`, and answer 400 to a
 * body with both or neither, so a string operand goes out as `input` and an
 * array goes out as `assertions`. The server decides by presence, so an empty
 * string is text with nothing typed yet and an empty array is facts with none
 * chosen.
 */
function textOrFactsBody(
    input: string | Assertion[],
    options?: Record<string, unknown>,
): Record<string, unknown> {
    return Array.isArray(input)
        ? { ...(options ?? {}), assertions: input }
        : { ...(options ?? {}), input };
}

/**
 * Reject a result with no rendered marking before a cached call can settle.
 *
 * A validate, process or preset result and an explanation trace each write the
 * marking back as `rendered`, so that is the one member worth checking before
 * the answer is filed for every later caller.
 *
 * @param pending - The unwrapped wire result
 * @param operation - The operation named in the failure message
 * @returns The result, typed as the operation promised
 * @throws {EzClassifyError} When the body is not an object with a `rendered`
 *   string
 */
async function checkedMarkingResult<T>(
    pending: Promise<unknown>,
    operation: string,
): Promise<T> {
    const result = await pending;
    if (
        result === null ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        typeof (result as Record<string, unknown>).rendered !== 'string'
    ) {
        throw new EzClassifyError(
            `Context ${operation} result is missing its rendered marking`,
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    return result as T;
}

/**
 * Build the wire body for `crosswalk/translate` from the adapter's
 * `CrosswalkTranslationInput`.
 *
 * `CrosswalkTranslationInput.marking` is the shared `string | Assertion[]`
 * union, but `CtxCrosswalkTranslateRequestBody` carries it as two separate
 * optional fields, `marking` and `assertions`, with exactly one present. A
 * string operand goes out as `marking`; an array goes out as `assertions`,
 * never both.
 */
function crosswalkTranslateBody(
    input: CrosswalkTranslationInput,
): Record<string, unknown> {
    const { crosswalkId, marking } = input;
    return Array.isArray(marking)
        ? { crosswalkId, assertions: marking }
        : { crosswalkId, marking };
}

/**
 * Query string for the Context route's `describe-concept`, which carries its
 * arguments in the URL rather than in a body.
 *
 * `URLSearchParams` percent-encodes each value, which matters: a concept id is
 * scheme-authored text and nothing stops one carrying an `&`.
 */
function describeConceptQuery(
    conceptId: string,
    categoryId: string,
    view?: string,
): URLSearchParams {
    const query = new URLSearchParams({ conceptId, categoryId });
    if (view !== undefined) query.set('view', view);
    return query;
}

/**
 * Peel the transport-only `signal` off an options bag.
 *
 * It cancels the request; it is not part of the operation the server runs, so
 * it must reach neither the wire body nor the cache key.
 */
function splitSignal(options?: object): {
    signal: AbortSignal | undefined;
    rest: Record<string, unknown> | undefined;
} {
    const record = options as Record<string, unknown> | undefined;
    if (!record || !('signal' in record)) {
        return { signal: undefined, rest: record };
    }
    const { signal, ...rest } = record;
    return { signal: signal as AbortSignal | undefined, rest };
}

/**
 * Coerce a `render`/`normalize` wire response into the plain marking string
 * both operations promise their callers.
 *
 * This runs inside the cached thunk, not after it: the cache holds whatever
 * this returns, so under a version pin a raw, uncoerced response would sit
 * there forever and every caller after the first would get back the wrong
 * shape.
 *
 * A body carrying neither a bare string nor `result` nor `rendered` is a
 * contract mismatch, and it fails here rather than resolving to an empty
 * string. The output of these two operations is the marking itself; a blank one
 * presented as an answer is worse than no answer.
 *
 * @param raw - The parsed wire body
 * @returns The marking string the operation promised
 * @throws {EzClassifyError} When the body carries no marking string
 * @internal
 */
export function coerceRenderedString(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (raw !== null && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.result === 'string') return obj.result;
        if (typeof obj.rendered === 'string') return obj.rendered;
    }
    throw new EzClassifyError(
        'Render response carried no marking string.',
        ErrorCodes.MALFORMED_RESPONSE,
    );
}

/**
 * The response body the ctx guide family sends when the Context it is bound to
 * declares no guide at all.
 */
const NO_GUIDE_BODY_MESSAGE = 'Context has no guides attached.';

/**
 * Whether a parsed response body is exactly the no-guide-in-context shape.
 *
 * The match is exact, same discipline as {@link isDenialShapedBody}: a 422
 * carrying any other body is a real failure (a malformed request, a rejected
 * scan) and must not be swallowed alongside it.
 */
function isNoGuideBody(body: unknown): boolean {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return false;
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    return (
        keys.length === 1 &&
        keys[0] === 'error' &&
        record.error === NO_GUIDE_BODY_MESSAGE
    );
}

/**
 * Whether a failure is the deployment saying the Context declares no guide.
 *
 * The guide family answers 422 for that, not 404. A 404 from the same routes
 * means an explicitly named guide is not in the Context, which is not "there is
 * nothing to show".
 *
 * Status alone is not enough to discriminate: the guide family also answers 422
 * for an ordinary validation failure (a malformed scan request, for instance),
 * and a client keyed on status alone would swallow that as "no guide" instead
 * of propagating it. The body carries the constant message sent only for the
 * true no-guide case, so the match has to include it.
 */
function isNoGuideInContext(err: unknown): boolean {
    return (
        err instanceof EzClassifyError &&
        err.status === 422 &&
        isNoGuideBody(err.body)
    );
}

/**
 * Check the suggest-for-categories wire response, which is already the map the
 * adapter contract promises: one {@link SuggestResult} per category id.
 *
 * Every requested category has to come back with a result. A caller indexes the
 * map by an id it already holds and dereferences what it finds, so a partial or
 * malformed answer would hand it `undefined` typed as a `SuggestResult` and the
 * failure would land somewhere unrelated.
 *
 * Category ids are scheme-authored text, so presence is read from the entries
 * the server actually sent, never through the prototype chain: a category named
 * `toString` is not answered by `Object.prototype`, and one named `__proto__`
 * comes back as an ordinary entry of the returned map.
 *
 * @param wire - The unwrapped wire result
 * @param categoryIds - The categories the request named
 * @returns The results keyed by category id
 * @throws {EzClassifyError} When the body is not a map of results covering
 *   every requested category
 */
function checkedSuggestionsByCategory(
    wire: unknown,
    categoryIds: string[],
): SuggestResultsByCategory {
    if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
        throw new EzClassifyError(
            'suggest-for-categories response is not a map of results keyed by category id',
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    const byCategory = new Map<string, SuggestResult>();
    for (const [categoryId, result] of Object.entries(wire)) {
        if (
            result === null ||
            typeof result !== 'object' ||
            Array.isArray(result)
        ) {
            throw new EzClassifyError(
                `suggest-for-categories response carries no result for category "${categoryId}"`,
                ErrorCodes.MALFORMED_RESPONSE,
            );
        }
        byCategory.set(categoryId, result as SuggestResult);
    }
    const missing = categoryIds.filter((id) => !byCategory.has(id));
    if (missing.length > 0) {
        throw new EzClassifyError(
            `suggest-for-categories response answered no result for: ${missing.join(', ')}`,
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    return Object.fromEntries(byCategory);
}

/**
 * Rehydrate a wire FilterResult (arrays / plain objects) back to Set/Map.
 *
 * The three members are read off a response body, so they are checked before
 * they are read: an off-contract body should reach the caller as this package's
 * own failure rather than as a TypeError from the middle of a loop.
 *
 * @param wire - The parsed response body
 * @returns The filter result with its Set and Map rebuilt
 * @throws {EzClassifyError} When the body is not the documented shape
 */
function hydrateFilterResult(wire: unknown): FilterResult {
    const body = (
        wire !== null && typeof wire === 'object' ? wire : {}
    ) as Partial<{
        visibleIds: string[];
        categoryCounts: Record<string, { visible: number; total: number }>;
        total: { visible: number; total: number };
    }>;
    if (
        !Array.isArray(body.visibleIds) ||
        body.categoryCounts === null ||
        typeof body.categoryCounts !== 'object' ||
        body.total === null ||
        typeof body.total !== 'object'
    ) {
        throw new EzClassifyError(
            'filter-concepts response is not the documented shape',
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    const categoryCounts = new Map<
        string,
        { visible: number; total: number }
    >();
    for (const [k, v] of Object.entries(body.categoryCounts))
        categoryCounts.set(k, v);
    return {
        visibleIds: new Set(body.visibleIds),
        categoryCounts,
        total: body.total,
    };
}

const NO_PROFILE_MESSAGE =
    'No profile cached. Use EzClassifyClient.connect() or call fetchProfile() first.';

/**
 * Where a scheme view's cached profile lives, and the synchronous reads over
 * it. The owning client is the primary scheme's; {@link HeldSchemeState} is
 * every other held scheme's.
 *
 * @internal
 */
type SchemeProfileSlot = Pick<
    EzClassifyClient,
    | '_activeProfile'
    | '_activeGrammar'
    | '_setActiveProfile'
    | 'getSchemeMeta'
    | 'listCategories'
    | 'getConceptsInCategory'
    | 'uncoveredAssertions'
>;

/**
 * Cached-profile state for a scheme a Context holds beside its primary.
 *
 * The primary's profile lives on the client itself, which is what the client's
 * own synchronous accessors read. Each other held scheme gets one of these, so
 * a view bound to it answers its synchronous reads from its own scheme and
 * never from the primary's.
 *
 * Installing a profile here leaves the response cache alone, unlike the
 * client's: entries are keyed by selector, so a second scheme arriving cannot
 * make an answer for the first one stale. A composition change clears the whole
 * cache through the primary's install, which runs alongside this one.
 *
 * @internal
 */
class HeldSchemeState extends SchemeState {
    private _grammar: SchemeGrammar | null = null;

    get _activeProfile(): SchemePublicView | null {
        return this._profile;
    }

    get _activeGrammar(): SchemeGrammar | null {
        return this._grammar;
    }

    _setActiveProfile(profile: ContextSchemeProfile | null): void {
        // Installed together for the reason the client's are: one concrete
        // Context version produced both.
        this._profile = profile === null ? null : deepFreeze(profile.view);
        this._grammar = profile === null ? null : deepFreeze(profile.grammar);
        this.invalidateConceptMap();
    }

    protected _loadProfile(): SchemePublicView {
        if (!this._profile) {
            throw new EzClassifyError(
                NO_PROFILE_MESSAGE,
                ErrorCodes.INVALID_INPUT,
            );
        }
        return this._profile;
    }
}

/**
 * The schemes a Context holds, reached by key. `client.scheme` is the primary;
 * this collection is how a caller gets any other.
 */
export class ContextSchemes implements ContextSchemesContract<SchemeOps> {
    /**
     * @param _view - Finds or creates the owning client's view for a key.
     * @internal
     */
    constructor(private readonly _view: (key: string) => SchemeOps) {}

    /**
     * The view of the scheme a key names.
     *
     * `key` is a scheme's Context-local key, as `describeSchemes()` lists it.
     * The server decides whether the Context holds it: an operation on a key it
     * does not hold rejects with the server's 404 `scheme_not_found`, and
     * nothing falls back to the primary, because a marking checked in a scheme
     * its author did not choose can look valid and be wrong.
     *
     * `connect()` loads the profile of every scheme the Context lists, so their
     * views answer synchronous reads at once. Any other view loads its profile
     * with `fetchProfile()`. The same key returns the same view, and the
     * primary's key returns `client.scheme`.
     *
     * @param key - The scheme's key
     * @returns The view bound to that key
     * @throws {EzClassifyError} When `key` is blank or not a string. It could
     *   never name a scheme, and an absent key would address the primary.
     */
    get(key: string): SchemeOps {
        if (typeof key !== 'string' || key.trim() === '') {
            throw new EzClassifyError(
                'schemes.get() needs the key of a scheme the Context holds.',
                ErrorCodes.INVALID_INPUT,
            );
        }
        return this._view(key);
    }
}

/**
 * Scheme-domain operations on a remote EzClassify REST API, bound to one of the
 * schemes the Context holds. `client.scheme` is the primary scheme's view,
 * handed out as `ContextAdapter.scheme` so a component that only marks text
 * never learns it came from a Context; `client.schemes.get(key)` is the view of
 * any other.
 *
 * It is the marking-family view of one client, not a second engine: every
 * method routes through the owning client. The selector picks the view, never
 * an argument: a view bound to a held scheme other than the primary sends
 * `?scheme=<selector>` on every operation and every profile read, and keys its
 * cache entries by that selector, so no answer one scheme gave is served for
 * another. The primary's synchronous reads are the client's own; any other view
 * answers them from its own profile.
 */
export class SchemeOps implements RemoteContextSchemeEngineAdapter {
    /** Where this view's cached profile lives. */
    private readonly _state: SchemeProfileSlot;

    /**
     * @param _c - The owning client.
     * @param _selector - Context-local key of the held scheme this view is
     *   bound to; absent for the primary, which is addressed by no `?scheme=`.
     * @internal
     */
    constructor(
        private readonly _c: EzClassifyClient,
        readonly _selector?: string,
    ) {
        this._state = _selector === undefined ? _c : new HeldSchemeState();
    }

    /**
     * A path under this view's scheme resource, with the view's selector on it.
     * One builder for every operation and read, so none can leave the selector
     * off and quietly answer from the primary.
     */
    private _path(op: string, query?: URLSearchParams): string {
        const params = new URLSearchParams(query);
        if (this._selector !== undefined) params.set('scheme', this._selector);
        const path = this._c._ctxScopedPath(`scheme/${op}`);
        const search = params.toString();
        return search ? `${path}?${search}` : path;
    }

    /**
     * Install this view's profile. Called by `fetchProfile()`, by connect's
     * warm and by the re-warm on an alias move.
     *
     * @internal
     */
    _install(profile: ContextSchemeProfile | null): void {
        this._state._setActiveProfile(profile);
    }

    /** Whether the owning client has an active connection to the REST API. */
    get connected(): boolean {
        return this._c.connected;
    }

    /**
     * Release the owning client's resources.
     *
     * This adapter holds none of its own: its heartbeat, cache and connection
     * are the client's, so destroying it destroys the client it came from.
     *
     * That makes it wider than it looks. A component handed this object as
     * `ContextAdapter.scheme` and disposing it on unmount takes down the
     * client, its heartbeat, its cache, and every sibling family surface with
     * it, including {@link ContextOps} on `client.context`. Ownership of the
     * client belongs to whoever constructed it; a component that was merely
     * handed the scheme view should not be calling this.
     */
    destroy(): void {
        this._c.destroy();
    }

    /**
     * Return the cached public profile synchronously. Reflects the current
     * composition stack. Available after connect() or fetchProfile().
     */
    getScheme(): SchemePublicView {
        const profile = this._state._activeProfile;
        if (!profile) {
            throw new EzClassifyError(
                NO_PROFILE_MESSAGE,
                ErrorCodes.INVALID_INPUT,
            );
        }
        return profile;
    }

    /**
     * Fetch and cache the public profile from the server using RESTful
     * sub-resource endpoints. After this call, getScheme() returns
     * synchronously.
     *
     * The profile is read from this view's scheme, from the mirrored family
     * under `/v1/ctx`, at the concrete version the Context resolved to.
     * `connect()` already does this for every scheme the Context holds, so a
     * caller reaches for it to re-read a profile it suspects has moved.
     */
    async fetchProfile(): Promise<SchemePublicView> {
        const profile = await this._c._fetchProfileFromContext(
            await this._c.describeContext(),
            this._selector,
        );
        this._install(profile);
        return profile.view;
    }

    /**
     * Process a marking for someone who is writing it: the author's call.
     *
     * `input` is either a marking string to parse or an already-parsed
     * assertion array, exactly as on the local engine: an array skips the parse
     * stage and is processed directly. A UI writing facets takes this path, so
     * the remote and local adapters accept the same operand.
     * `options.assertions` adds the facts already chosen elsewhere, and text
     * and chosen facts are settled together as one marking, which is what a
     * composer sends on a keystroke.
     *
     * The answer is everything {@link validate} answers, settled the same way,
     * plus the corrections to the text, the proven fix paths, a rendering for
     * each output named in `options.outputs` and, when `options.suggestFor`
     * names categories, their picker options. Nothing beyond that is written:
     * `renders` is empty unless outputs are named, and `suggestionsFor` is
     * absent unless categories are. A reader that only needs the verdict calls
     * {@link validate}; the trace of how the engine got here is {@link explain}.
     *
     * The bound Context selects the composition; the operation accepts no
     * scheme selector.
     */
    async process(
        input: string | Assertion[],
        options?: {
            /**
             * The format `input` is written in. For a scheme that declares
             * surfaces, it may instead name the view the text is read as, by id
             * or `surface/view` address. Omitted, recognition works it out and
             * reports what the text was read as in `recognition.inputFormat`.
             */
            inputFormat?: string;
            /**
             * The output `rendered` is written in: a format id, or for a scheme
             * that declares surfaces a `surface/view` address. Omitted, the
             * scheme's default format, or for a scheme that declares surfaces,
             * each surface the result writes in its default for the marking's
             * role, so a part and a whole can come back in different views.
             */
            outputFormat?: string;
            /** The facts already chosen, settled together with `input`. */
            assertions?: Assertion[];
            context?: ProcessingContext;
            /**
             * The validation surface `input` is, by scheme scope id. Omitted,
             * the input is a whole marking.
             */
            surface?: string;
            /**
             * Part markings the whole must cover. The whole is judged as
             * covering them: a part it does not cover is an error, and so is a
             * part that does not read as a marking. Every proposed fix and
             * every rank floor is worked out against the whole and these parts
             * together, so a raise never lands below what a part needs. Each
             * entry is a marking in one of the scheme's part formats, or any
             * format the scheme reads. Empty or absent, the whole stands
             * alone.
             */
            parts?: string[];
            /**
             * The outputs to write into `renders`, each spelled exactly as a
             * key of `renders` is: `surface/view` for a scheme that declares
             * surfaces, a format id otherwise. Omitted or empty, `renders` is
             * empty. An output the scheme does not declare is refused.
             */
            outputs?: string[];
            /**
             * Category ids to answer picker options for, in `suggestionsFor`.
             * Omitted, nothing is suggested and the field is absent. A category
             * the scheme does not declare is refused.
             */
            suggestFor?: string[];
            signal?: AbortSignal;
        },
    ): Promise<ProcessResult> {
        const { signal, rest } = splitSignal(options);
        const body = markingBody(input, rest);
        return this._c._cachedWire(
            'process',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                checkedMarkingResult<ProcessResult>(
                    this._c._requestEngine<unknown>(
                        'POST',
                        this._path('process'),
                        wireBody,
                        wireSignal,
                    ),
                    'process',
                ),
            { signal },
        );
    }

    /** Aggregate multiple marking strings into a single combined marking. */
    async aggregate(
        inputs: string[],
        options?: {
            inputFormat?: string;
            outputFormat?: string;
            context?: ProcessingContext;
            surface?: string;
            signal?: AbortSignal;
        },
    ): Promise<AggregateResult> {
        const { signal, rest } = splitSignal(options);
        const body = { inputs, ...(rest ?? {}) };
        return this._c._cachedWire(
            'aggregate',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                this._c._requestEngine<AggregateResult>(
                    'POST',
                    this._path('aggregate'),
                    wireBody,
                    wireSignal,
                ),
            { signal },
        );
    }

    /**
     * Aggregate already-parsed assertion sets: the lossless sibling of
     * {@link aggregate}. Sends `assertionSets` (mutually exclusive with
     * `inputs`) to the same Context aggregate route; the server skips the
     * string-parse stage and runs the rest of the aggregate pipeline. Use this
     * to transport scope-only assertions and capture values that no rendered
     * string can carry.
     */
    async aggregateAssertions(
        assertionSets: Assertion[][],
        options?: {
            outputFormat?: string;
            context?: ProcessingContext;
            surface?: string;
            signal?: AbortSignal;
        },
    ): Promise<AggregateResult> {
        const { signal, rest } = splitSignal(options);
        const body = { assertionSets, ...(rest ?? {}) };
        return this._c._cachedWire(
            'aggregateAssertions',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                this._c._requestEngine<AggregateResult>(
                    'POST',
                    this._path('aggregate'),
                    wireBody,
                    wireSignal,
                ),
            { signal },
        );
    }

    /**
     * Expand a named label preset by id on the server and return what validate
     * answers for the marking it stands for. The preset's `marking` string and
     * expansion rules never leave the server.
     *
     * A preset is a stored marking, so there is nothing to correct and no fix
     * path to offer: the answer is the facts, the verdicts, the rendering and
     * its assessment, the notices and the color.
     *
     * The Context names the scheme, so the request carries no scheme id.
     * `outputFormat` names the output the preset's marking is written in.
     */
    async applyPreset(
        presetId: string,
        options?: { outputFormat?: string },
    ): Promise<ValidateResult> {
        const body = { presetId, ...(options ?? {}) };
        const path = this._path('apply-preset');
        return this._c._cachedWire(
            'applyPreset',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                checkedMarkingResult<ValidateResult>(
                    this._c._requestEngine<unknown>(
                        'POST',
                        path,
                        wireBody,
                        wireSignal,
                    ),
                    'apply-preset',
                ),
        );
    }

    /**
     * Generate suggestions for completing or modifying a marking: the options a
     * picker may offer, and only those. How the marking reads and whether it
     * stands are what {@link validate} and {@link process} answer.
     *
     * `input` is the marking as text or as facts, one or the other. Text typed
     * beside facts already chosen is what {@link process} answers, with the
     * categories to offer options for named in `suggestFor`. `inputFormat` says
     * how text is read, so the server refuses it beside facts.
     *
     * `includeGated` asks for the concepts an active filter would otherwise
     * hide because their prerequisites are unmet. Each comes back marked
     * `gated` with the `requires` ids that would make it available, so a picker
     * can show an "add X first" row instead of an unexplained absence.
     */
    async suggest(
        input: string | Assertion[],
        options?: {
            inputFormat?: string;
            outputFormat?: string;
            filter?: string;
            surface?: string;
            includeGated?: boolean;
            signal?: AbortSignal;
        },
    ): Promise<SuggestResult> {
        const { signal, rest } = splitSignal(options);
        const body = textOrFactsBody(input, rest);
        return this._c._cachedWire(
            'suggest',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                this._c._requestEngine<SuggestResult>(
                    'POST',
                    this._path('suggest'),
                    wireBody,
                    wireSignal,
                ),
            { signal },
        );
    }

    /**
     * Suggest for several categories at once against one committed assertion
     * set, keyed by category id.
     *
     * Each category is answered as if its own assertions were not yet chosen,
     * so a picker offers the alternatives to the current selection rather than
     * only what is still addable beside it. The caller sends its full committed
     * set once; the exclusion is done for it. Each entry holds that category's
     * options and no other's, and none offers a label preset, which belongs to
     * no category.
     *
     * One round trip where a form would otherwise fan out one `suggest` per
     * field. An author who is processing the marking anyway gets the same map
     * from that call by naming the categories in `suggestFor`. The operation is
     * part of the 1.0 Context contract; a server that does not implement it is
     * version-incompatible.
     *
     * @param assertions - The caller's full committed assertion set
     * @param categoryIds - Categories to produce suggestions for
     * @param options - Output format, suggestion surface, and the caller's
     *   cancellation signal
     * @returns One {@link SuggestResult} per requested category id
     */
    async suggestForCategories(
        assertions: Assertion[],
        categoryIds: string[],
        options?: {
            outputFormat?: string;
            surface?: string;
            signal?: AbortSignal;
        },
    ): Promise<SuggestResultsByCategory> {
        const { signal, rest } = splitSignal(options);
        const body = {
            assertions,
            categoryIds,
            ...(rest ?? {}),
        };
        // The response is checked inside the thunk, not after it: a cache
        // entry settles when its thunk resolves, so validating outside would
        // file a malformed body as a good answer. The answer is the map
        // itself, so naming no category gets back `{}`; the envelope lets
        // that through and the key check below decides.
        return this._c._cachedWire(
            'suggestForCategories',
            this._c._schemeCacheKey(this._selector),
            body,
            async (wireSignal, wireBody) =>
                checkedSuggestionsByCategory(
                    await this._c._requestEngine<unknown>(
                        'POST',
                        this._path('suggest-for-categories'),
                        wireBody,
                        wireSignal,
                        { emptyResult: 'allowed' },
                    ),
                    categoryIds,
                ),
            { signal },
        );
    }

    /**
     * Scan a document and extract all marking strings found within it.
     *
     * Each hit's `result` is what {@link validate} answers for that marking,
     * read in the role it was found in. A scan reads documents and does not
     * author them, so there are no fix paths; a caller that wants to correct
     * one region processes that region.
     *
     * The outcome carries the limit report beside the markings: an empty list
     * is what a clean document and a scan that stopped before the end of one
     * both look like, and `limits` says which it was.
     */
    async scan(
        text: string,
        options?: ScanOptions & { signal?: AbortSignal },
    ): Promise<ScanOutcome> {
        const { signal, rest } = splitSignal(options);
        const body = { text, ...(rest ?? {}) };
        return this._c._cachedWire(
            'scan',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                this._c._requestEngine<ScanOutcome>(
                    'POST',
                    this._path('scan'),
                    wireBody,
                    wireSignal,
                ),
            { ttlMs: SCAN_TTL_MS, signal },
        );
    }

    /** Render assertions directly into a marking string without re-parsing. */
    async render(
        assertions: Assertion[],
        format?: string,
        options?: RenderOptions,
    ): Promise<RenderResult> {
        const { signal, preservation } = options ?? {};
        const body = {
            assertions,
            outputFormat: format,
            preservation,
        };
        const cacheKey = this._c._schemeCacheKey(this._selector);
        // Coercion happens inside the thunk so the cache holds the plain
        // string it promises, not the raw wire body. See
        // `coerceRenderedString`.
        return this._c._cachedWire(
            'render',
            cacheKey,
            body,
            async (wireSignal, wireBody) => {
                const wire = await this._c._requestEngine<{
                    result: string;
                    assessment: RenderResult['assessment'];
                }>('POST', this._path('render'), wireBody, wireSignal);
                if (typeof wire.result !== 'string' || !wire.assessment) {
                    throw new EzClassifyError(
                        'Render response is missing result or assessment.',
                        ErrorCodes.MALFORMED_RESPONSE,
                    );
                }
                return { rendered: wire.result, assessment: wire.assessment };
            },
            { signal },
        );
    }

    /**
     * Collect concept-attached notices for the given assertions.
     *
     * Reach for this when all you have is a set of assertions. Any result that
     * describes a marking already carries the same list on its `notices` field,
     * so a caller that has just processed, validated, aggregated or scanned has
     * the notices in hand and does not need this call.
     */
    async collectNotices(assertions: Assertion[]): Promise<
        Array<{
            conceptId: string;
            conceptName: string;
            type: string;
            text: string;
            required: boolean;
        }>
    > {
        return this._c._requestEngine<
            Array<{
                conceptId: string;
                conceptName: string;
                type: string;
                text: string;
                required: boolean;
            }>
        >('POST', this._path('notices'), { assertions });
    }

    /**
     * Cover check. Rolls the children up on the server and reports whether the
     * parent covers them: what the parent is missing, and what it carries in
     * excess of what the children allow.
     */
    async checkCoverage(
        children: string[],
        parent: string,
        options?: {
            inputFormat?: string;
            outputFormat?: string;
            signal?: AbortSignal;
        },
    ): Promise<CoverageReport> {
        const { signal, rest } = splitSignal(options);
        const nonEmpty = Array.isArray(children)
            ? children.filter((c) => !!c)
            : [];
        // Nothing to cover is covered, and that answer needs no server: with
        // no children the parent lacks nothing and carries nothing in excess.
        if (nonEmpty.length === 0) {
            return {
                covered: true,
                missing: [],
                missingLabels: [],
                excess: [],
                excessLabels: [],
                rendered: '',
            };
        }
        // A caller asking whether children are covered, without naming what is
        // supposed to cover them, gets told so. Answering "covered" would be
        // this client inventing a reassuring result for a question nobody
        // asked the server.
        if (!parent) {
            throw new EzClassifyError(
                'checkCoverage() needs a parent marking to check the children against.',
                ErrorCodes.INVALID_INPUT,
            );
        }
        return this._c._requestEngine<CoverageReport>(
            'POST',
            this._path('check-coverage'),
            {
                children: nonEmpty,
                parent,
                inputFormat: (rest as { inputFormat?: string } | undefined)
                    ?.inputFormat,
                outputFormat: (rest as { outputFormat?: string } | undefined)
                    ?.outputFormat,
            },
            signal,
        );
    }

    /**
     * Describe a concept's usage: definition, guidance, and applicable rules.
     *
     * The Context route carries the concept, category, and optional view in the
     * query and has no request body. A concept or category the scheme does not
     * declare is refused: the {@link EzClassifyError} has status 404, code
     * `NOT_FOUND` and a `detail` naming the query parameter and the id, which
     * is what tells it apart from the codeless 404 of a refused credential.
     *
     * `view` is a key of the concept's `views`; omitted, the concept is named
     * in its default view.
     */
    async describeConcept(
        conceptId: string,
        categoryId: string,
        options?: { view?: string },
    ): Promise<ConceptDescription> {
        // The route takes its arguments in the query, so the cache key is
        // built from them rather than from a request body.
        const body = { conceptId, categoryId, view: options?.view };
        return this._c._cachedWire(
            'describeConcept',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal) =>
                this._c._requestEngine<ConceptDescription>(
                    'GET',
                    this._path(
                        'describe-concept',
                        describeConceptQuery(
                            conceptId,
                            categoryId,
                            options?.view,
                        ),
                    ),
                    undefined,
                    wireSignal,
                ),
            { ttlMs: LONG_TTL_MS },
        );
    }

    /**
     * Judge a marking for someone who is reading it: the reader's call.
     *
     * `input` is marking text, or facts as stated: what a document or an author
     * states before any engine has settled them. It is never the `assertions`
     * of an earlier result. Those are settled already, so validating them can
     * call a marking valid whose text was not.
     *
     * The server settles the input exactly as {@link process} does and then
     * judges it, so `valid` and `inputWasValid` mean the same here as on every
     * other operation. `surface`, `context` and `parts` say what the marking is
     * judged as. The answer is the settled facts, the verdicts, errors and
     * warnings, the changes settling made, the marking written back with its
     * assessment, how recognition read it, the notices and the color. Fix paths
     * and corrections to the text are an author's concern and come from
     * {@link process}.
     */
    async validate(
        input: string | Assertion[],
        options?: {
            /**
             * The format `input` is written in, when it is text. For a scheme
             * that declares surfaces, it may instead name the view the text is
             * read as, by id or `surface/view` address. Omitted, recognition
             * works it out. The server refuses it with facts, which carry no
             * text.
             */
            inputFormat?: string;
            /**
             * The output `rendered` is written in: a format id, or for a scheme
             * that declares surfaces a `surface/view` address. Omitted, the
             * scheme's default format, or for a scheme that declares surfaces,
             * each surface the result writes in its default for the marking's
             * role.
             */
            outputFormat?: string;
            context?: ProcessingContext;
            /**
             * The validation surface `input` is, by scheme scope id. Omitted,
             * the input is a whole marking.
             */
            surface?: string;
            /**
             * Part markings the whole must cover. The whole is judged as
             * covering them: a part it does not cover is an error, and so is a
             * part that does not read as a marking. Each entry is a marking in
             * one of the scheme's part formats, or any format the scheme reads.
             * Empty or absent, the whole stands alone.
             */
            parts?: string[];
            signal?: AbortSignal;
        },
    ): Promise<ValidateResult> {
        const { signal, rest } = splitSignal(options);
        const body = textOrFactsBody(input, rest);
        return this._c._cachedWire(
            'validate',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                checkedMarkingResult<ValidateResult>(
                    this._c._requestEngine<unknown>(
                        'POST',
                        this._path('validate'),
                        wireBody,
                        wireSignal,
                    ),
                    'validate',
                ),
            { signal },
        );
    }

    /**
     * Explain, step by step, how the server settles a marking.
     *
     * Takes what {@link process} takes apart from `outputs` and `suggestFor`,
     * which only add to a process result, and returns the trace of that same
     * processing: what was read, repaired, inferred and found wrong, and what
     * was written. Reach for it when someone wants to know why a marking came
     * out the way it did. No other operation returns the trace.
     */
    async explain(
        input: string | Assertion[],
        options?: {
            /**
             * The format `input` is written in. For a scheme that declares
             * surfaces, it may instead name the view the text is read as, by id
             * or `surface/view` address. Omitted, recognition works it out.
             */
            inputFormat?: string;
            /**
             * The output the trace's `rendered` is written in: a format id, or
             * for a scheme that declares surfaces a `surface/view` address.
             * Omitted, the scheme's default format, or for a scheme that
             * declares surfaces, each surface the result writes in its default
             * for the marking's role.
             */
            outputFormat?: string;
            /** The facts already chosen, settled together with `input`. */
            assertions?: Assertion[];
            context?: ProcessingContext;
            /**
             * The validation surface `input` is, by scheme scope id. Omitted,
             * the input is a whole marking.
             */
            surface?: string;
            /** Part markings the whole must cover, judged as on {@link process}. */
            parts?: string[];
            signal?: AbortSignal;
        },
    ): Promise<ExplanationTrace> {
        const { signal, rest } = splitSignal(options);
        const body = markingBody(input, rest);
        return this._c._cachedWire(
            'explain',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                checkedMarkingResult<ExplanationTrace>(
                    this._c._requestEngine<unknown>(
                        'POST',
                        this._path('explain'),
                        wireBody,
                        wireSignal,
                    ),
                    'explain',
                ),
            { signal },
        );
    }

    /** Normalize a marking string to its canonical rendered form. */
    async normalize(
        input: string,
        options?: {
            inputFormat?: string;
            outputFormat?: string;
            signal?: AbortSignal;
        },
    ): Promise<string> {
        const { signal, rest } = splitSignal(options);
        const body = { input, ...(rest ?? {}) };
        // Coercion happens inside the thunk so the cache holds the plain
        // string it promises, not the raw wire body. See
        // `coerceRenderedString`.
        return this._c._cachedWire(
            'normalize',
            this._c._schemeCacheKey(this._selector),
            body,
            async (wireSignal, wireBody) =>
                coerceRenderedString(
                    await this._c._requestEngine<unknown>(
                        'POST',
                        this._path('normalize'),
                        wireBody,
                        wireSignal,
                    ),
                ),
            { signal },
        );
    }

    /**
     * Diff two marking strings, returning added, removed, and common
     * assertions.
     */
    async diff(
        a: string,
        b: string,
        options?: { inputFormat?: string; signal?: AbortSignal },
    ): Promise<DiffResult> {
        const { signal, rest } = splitSignal(options);
        const body = { a, b, ...(rest ?? {}) };
        return this._c._cachedWire(
            'diff',
            this._c._schemeCacheKey(this._selector),
            body,
            (wireSignal, wireBody) =>
                this._c._requestEngine<DiffResult>(
                    'POST',
                    this._path('diff'),
                    wireBody,
                    wireSignal,
                ),
            { signal },
        );
    }

    /** Build a render-ready structural view of the client's profile. */
    async buildSchemeView(): Promise<SchemeStructuralView> {
        return this._c._requestEngine<SchemeStructuralView>(
            'POST',
            this._path('view'),
            {},
        );
    }

    /**
     * Substring filter over concepts in the client's profile. Returns visible
     * concept ids plus per-category visible/total counts.
     */
    async filterConcepts(query: string): Promise<FilterResult> {
        const wire = await this._c._requestEngine<unknown>(
            'POST',
            this._path('filter-concepts'),
            { query },
        );
        return hydrateFilterResult(wire);
    }

    /**
     * Compact id/label pairs for every category, for tool-use contexts.
     *
     * Answered from the cached profile when the client holds one, and from the
     * structural view otherwise: both carry the categories in declared order,
     * and no route was added for a projection of data already on hand.
     */
    async listCategoriesFlat(): Promise<Array<{ id: string; label: string }>> {
        if (this._state._activeProfile) {
            return this.getScheme().categories.map((c) => ({
                id: c.id,
                label: c.label,
            }));
        }
        const view = await this.buildSchemeView();
        return view.categories.map((c) => ({ id: c.id, label: c.label }));
    }

    // -- synchronous views of the cached profile ---------------------------
    //
    // The view's profile slot carries the cached scheme: the owning client for
    // the primary, so these read through to it rather than keeping a second
    // copy that could disagree with it, and the view's own state otherwise.

    /** Scheme identity and configuration metadata from the cached profile. */
    getSchemeMeta(): SchemeMetaView {
        return this._state.getSchemeMeta();
    }

    /**
     * How the scheme's reader compares a spelling against its vocabulary, read
     * from the Context's grammar resource when the profile was fetched.
     * Available after connect() or fetchProfile(); the object is frozen, shared
     * like the profile it came with.
     */
    getGrammar(): SchemeGrammar {
        const grammar = this._state._activeGrammar;
        if (!grammar) {
            throw new EzClassifyError(
                NO_PROFILE_MESSAGE,
                ErrorCodes.INVALID_INPUT,
            );
        }
        return grammar;
    }

    /** Resolved category views for every category in the cached profile. */
    listCategories(): CategoryView[] {
        return this._state.listCategories();
    }

    /** Concepts in a category as resolved views, optionally with nesting depth. */
    getConceptsInCategory(categoryId: string): ConceptView[];
    getConceptsInCategory(
        categoryId: string,
        options: { nested: true },
    ): Array<{ concept: ConceptView; depth: number }>;
    getConceptsInCategory(
        categoryId: string,
        options?: { nested: true },
    ): ConceptView[] | Array<{ concept: ConceptView; depth: number }> {
        return options
            ? this._state.getConceptsInCategory(categoryId, options)
            : this._state.getConceptsInCategory(categoryId);
    }

    /** Assertions in `candidates` that `parent` does not cover. */
    uncoveredAssertions(
        candidates: Assertion[],
        parent: Assertion[],
    ): Assertion[] {
        return this._state.uncoveredAssertions(candidates, parent);
    }
}

/**
 * Guide-domain operations on a remote EzClassify REST API. Access via
 * `client.guide.*`, and handed out as `ContextAdapter.guide`.
 */
export class GuideOps implements RemoteGuideEngineAdapter {
    /** @internal */
    constructor(private readonly _c: EzClassifyClient) {}

    /**
     * Metadata for the guides this client has loaded, in the Context's
     * precedence order. Keyed by guide id.
     */
    private readonly _meta = new Map<string, GuideMetaView>();

    /**
     * Metadata-only views of every guide loaded from the Context, in precedence
     * order. A projection of {@link listGuideMeta}'s cache, not a second copy of
     * it: empty for exactly the same reasons and until exactly the same point
     * {@link listGuideMeta} is, because that is the one place a guide's metadata
     * is actually recorded.
     */
    listGuides(): GuideView[] {
        const schemeId = this._c._contextDescription?.scheme.id ?? '';
        return [...this._meta.values()].map((meta) => ({
            id: meta.id,
            name: meta.name,
            version: meta.version,
            ...(meta.description ? { description: meta.description } : {}),
            schemeId,
        }));
    }

    /**
     * Metadata for every guide loaded from the Context, in precedence order.
     *
     * A remote client only records a guide's metadata along the path that knows
     * both its id and its resolved version, which the Context decomposition
     * supplies: {@link EzClassifyClient.connect} records every guide the Context
     * declares, and a later {@link buildGuideViews} call does the same once that
     * decomposition is cached. Everything here comes off the wire: the ids and
     * versions from the Context decomposition, the name, description and rule
     * count from the guide's own view.
     *
     * A client built with `new EzClassifyClient(...)` rather than connected has
     * no decomposition yet, so it has nothing to record from: its
     * {@link buildGuideViews} falls back to fetching the Context's default guide
     * view without a name to record it under, and this stays empty until the
     * Context resolves.
     */
    listGuideMeta(): GuideMetaView[] {
        return [...this._meta.values()];
    }

    /**
     * Metadata for one loaded guide, or the first the Context declares when
     * `guideId` is omitted. `undefined` when that guide has not been loaded.
     */
    getGuideMeta(guideId?: string): GuideMetaView | undefined {
        if (guideId !== undefined) return this._meta.get(guideId);
        for (const meta of this._meta.values()) return meta;
        return undefined;
    }

    /**
     * Record a loaded guide's metadata from the two wire responses that carry
     * it between them.
     *
     * `version` comes from the Context decomposition because a structural view
     * does not report one, which is also why a client that never resolved its
     * Context records nothing: half the required metadata would be missing and
     * a half-filled view reads as a real one.
     *
     * @internal
     */
    private _rememberGuide(
        view: GuideStructuralView,
        version: string,
    ): GuideStructuralView {
        const ruleCount =
            view.categories.reduce((n, cat) => n + cat.items.length, 0) +
            view.uncategorized.length;
        const override = view.vocabulary?.[GUIDEBOOK_TERM_KEY];
        this._meta.set(view.id, {
            id: view.id,
            version,
            name: view.name,
            ...(view.description ? { description: view.description } : {}),
            ruleCount,
            referenceSurfaceLabel: {
                singular:
                    override?.singular ??
                    GENERIC_REFERENCE_SURFACE_NOUNS[GUIDEBOOK_TERM_KEY]
                        .singular,
                plural:
                    override?.plural ??
                    GENERIC_REFERENCE_SURFACE_NOUNS[GUIDEBOOK_TERM_KEY].plural,
            },
        });
        return view;
    }

    /**
     * Load metadata for every guide the Context declares.
     *
     * Called by {@link EzClassifyClient.connect} so a picker bound to
     * `ContextAdapter.guide` has something real to render the moment it is
     * handed the adapter. A failure here is reported and swallowed: a caller
     * that only marks text should not lose its connection because a guide view
     * would not load.
     *
     * @internal
     */
    async _warmGuideMeta(): Promise<void> {
        const guides = this._c._contextDescription?.guides ?? [];
        if (guides.length === 0) return;
        try {
            await Promise.all(
                guides.map(async (guide) =>
                    this._rememberGuide(
                        await this.buildGuideView(guide.id),
                        guide.resolvedVersion,
                    ),
                ),
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(
                `@ezclassify/rest-client: could not load guide metadata for context ` +
                    `"${this._c._contextDescription?.id}": ${reason}. ` +
                    `guide.listGuideMeta() may be missing some guides; the ones ` +
                    `that resolved before the failure are still recorded, and the ` +
                    `guide operations still work.`,
            );
        }
    }

    /** Scan text against every guide attached to this Context. */
    async scan(text: string, guideId?: string): Promise<GuideScanResult[]> {
        return this._c._requestEngine<GuideScanResult[]>(
            'POST',
            this._c._ctxScopedPath('guide/scan'),
            { text, ...(guideId ? { guideId } : {}) },
        );
    }

    /** Evaluate selected rules from one guide attached to this Context. */
    async evaluate(
        guideId: string,
        selectedRuleIds: string[],
    ): Promise<EvaluationResult> {
        return this._c._requestEngine<EvaluationResult>(
            'POST',
            this._c._ctxScopedPath('guide/evaluate'),
            { guideId, selectedRuleIds },
        );
    }

    /**
     * Roll up a selection that spans the guides attached to this Context.
     *
     * Each selection names its guide, so a rule id two guides share is two
     * rules. The server evaluates each guide's selected rules as
     * {@link evaluate} would and rolls the outcomes up per target scheme; no
     * guide overrides or depends on another.
     *
     * @param selections - The selected rules, each with the guide that holds it
     */
    async evaluateMany(
        selections: GuideRuleSelection[],
    ): Promise<EvaluationResult> {
        return this._c._requestEngine<EvaluationResult>(
            'POST',
            this._c._ctxScopedPath('guide/evaluate'),
            { selections },
        );
    }

    /** Describe one rule from a guide attached to this Context. */
    async describeRule(
        ruleId: string,
        guideId?: string,
    ): Promise<RuleDescription> {
        return this._c._requestEngine<RuleDescription>(
            'POST',
            this._c._ctxScopedPath('guide/describe-rule'),
            { ruleId, ...(guideId ? { guideId } : {}) },
        );
    }

    /** Search the rules in a guide attached to this Context. */
    async filterRules(query: string, guideId?: string): Promise<FilterResult> {
        const wire = await this._c._requestEngine<{
            visibleIds: string[];
            categoryCounts: Record<string, { visible: number; total: number }>;
            total: { visible: number; total: number };
        }>('POST', this._c._ctxScopedPath('guide/filter-rules'), {
            query,
            ...(guideId ? { guideId } : {}),
        });
        return hydrateFilterResult(wire);
    }

    /** Build a render-ready structural view of a Context guide. */
    async buildGuideView(guideId?: string): Promise<GuideStructuralView> {
        return this._c._requestEngine<GuideStructuralView>(
            'POST',
            this._c._ctxScopedPath('guide/view'),
            guideId ? { guideId } : {},
        );
    }

    /**
     * Structural views for every guide the Context resolves, in precedence
     * order, and their metadata as a side effect.
     *
     * The ctx view route answers for one guide at a time, so this names each
     * guide from the Context decomposition and asks for its view. A Context
     * that declares no guide is answered without a request at all.
     *
     * A client that has not resolved its Context falls back to the route's own
     * default, which is the first guide. That path cannot tell a multi-guide
     * Context from a single-guide one, and it learns "no guide here" only from
     * the server: 422 is the runtime's answer for a Context with no guide
     * attached.
     */
    async buildGuideViews(): Promise<GuideStructuralView[]> {
        const declared = this._c._contextDescription?.guides;
        if (declared) {
            return Promise.all(
                declared.map(async (guide) =>
                    this._rememberGuide(
                        await this.buildGuideView(guide.id),
                        guide.resolvedVersion,
                    ),
                ),
            );
        }
        try {
            return [await this.buildGuideView()];
        } catch (err) {
            if (isNoGuideInContext(err)) return [];
            throw err;
        }
    }
}

/**
 * Composed operations on a remotely resolved EzClassify Context. Access via
 * `client.context.*`.
 *
 * Holds no resources of its own and declares no `destroy()`: every method
 * routes through the owning client. Releasing a Context's resources means
 * releasing the client's, which is `EzClassifyClient.destroy()` (equally,
 * `client.scheme.destroy()`; see {@link SchemeOps.destroy} for why that
 * sub-object's teardown reaches the whole client too).
 */
export class ContextOps {
    /** @internal */
    constructor(private readonly _c: EzClassifyClient) {}

    /** Audit a document and preserve the server's resolved Context envelope. */
    async audit(
        input: DocumentAssessmentInput,
    ): Promise<ContextOperationResult<DocumentAuditReport>> {
        return this._request<DocumentAuditReport>(
            'document/audit',
            input,
            'required',
        );
    }

    /**
     * Evaluate one trusted marking or structured assertion target.
     *
     * Every call goes to the wire unless the client was built with
     * `cacheAccessDecisions`. The default is not a performance oversight: the
     * request is what puts the decision in the runtime's audit record, against
     * the artifact versions that answered it, and a decision served from the
     * client's memory is a decision the deployment cannot show anyone. The
     * option is the consumer choosing traffic over that record; see
     * `cacheAccessDecisions` in the client options.
     */
    async checkAccess(
        target: string | Assertion[],
        userAttributes: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<ContextOperationResult<AccessDecision>> {
        const path = this._c._ctxScopedPath('access/check');
        const body = {
            ...(typeof target === 'string'
                ? { marking: target }
                : { assertions: target }),
            userAttributes,
            ...(context !== undefined ? { context } : {}),
        };
        // The envelope is parsed inside the thunk so a malformed body rejects
        // the entry instead of settling it. Validating after the cache would
        // hold the bad payload for every later caller, and under the pin this
        // option requires that entry never expires.
        return this._c._cachedDecision(
            'context.checkAccess',
            path,
            body,
            async (signal, wireBody) =>
                parseContextOperationResult<AccessDecision>(
                    await this._c._request<unknown>(
                        'POST',
                        path,
                        wireBody,
                        signal,
                    ),
                    'forbidden',
                ),
        );
    }

    /** Describe requirements for a marking, assertions, or their merged target. */
    async accessRequirements(
        input: AccessRequirementsInput,
    ): Promise<ContextOperationResult<AccessRequirementsDescription>> {
        return this._request<AccessRequirementsDescription>(
            'access/describe-requirements',
            input,
            'forbidden',
        );
    }

    /**
     * Apply a directional crosswalk this Context declares.
     *
     * The result reports the treatment of every source assertion: what was
     * carried, what a reviewer has to decide, and what no mapping covers. A
     * prohibition stops the translation before the target scheme is touched and
     * the result says which one did it.
     *
     * @param input - Crosswalk id and the source marking or its assertions
     * @returns The translation under the resolved Context envelope
     */
    async translate(
        input: CrosswalkTranslationInput,
    ): Promise<ContextOperationResult<CrosswalkTranslationResult>> {
        return this._request<CrosswalkTranslationResult>(
            'crosswalk/translate',
            crosswalkTranslateBody(input),
            'forbidden',
        );
    }

    /**
     * Every crosswalk this Context holds, in declaration order. Empty when it
     * declares none.
     *
     * Each one names its source and target by the selectors `describeSchemes()`
     * reports, so a translation view bound to a scheme finds the crosswalk that
     * reads from it, and a crosswalk handbook renders the mappings and
     * selections a translation applies.
     *
     * The answer is a fixed property of the composition, so it goes through the
     * request cache: within the hour on an unpinned client, and for the life of
     * the entry on one pinned to a Context version. A client constructed with
     * `disableCache` asks the server every time.
     */
    async describeCrosswalks(): Promise<ContextCrosswalkDescriptor[]> {
        const path = this._c._ctxScopedPath('crosswalk/describe');
        // Not the Context envelope: this route answers `{ crosswalks }`
        // directly. The contract's response shape is checked inside the
        // request, so a malformed body rejects the entry rather than filing it.
        return this._c._cachedWire(
            'context.describeCrosswalks',
            path,
            null,
            async (signal) => {
                const wire = await this._c._request<{
                    crosswalks: ContextCrosswalkDescriptor[];
                }>('GET', path, undefined, signal);
                return wire.crosswalks;
            },
            { ttlMs: LONG_TTL_MS },
        );
    }

    private async _request<T>(
        suffix: string,
        body: unknown,
        projection: 'required' | 'forbidden',
    ): Promise<ContextOperationResult<T>> {
        const response = await this._c._request<unknown>(
            'POST',
            this._c._ctxScopedPath(suffix),
            body,
        );
        return parseContextOperationResult<T>(response, projection);
    }
}

/**
 * Access-domain operations on a remote EzClassify REST API. Access via
 * `client.access.*`, and handed out as `ContextAdapter.access`.
 */
export class AccessOps implements RemoteAccessEngineAdapter {
    /** @internal */
    constructor(private readonly _c: EzClassifyClient) {}

    /**
     * Id of the scheme whose assertions this policy evaluates.
     *
     * The contract makes this a synchronous property because a local access
     * engine is handed its scheme at construction. A remote one learns it from
     * the resolved Context decomposition.
     *
     * Only a client that has resolved neither has nothing to answer with, and
     * that is the same state {@link SchemeOps.getScheme} refuses in: built but
     * never connected. Returning an empty string there would read as a real
     * id.
     *
     * @throws {EzClassifyError} When the client has resolved no composition
     */
    get schemeId(): string {
        const id =
            this._c._activeProfile?.id ??
            this._c._contextDescription?.scheme.id;
        if (!id) {
            throw new EzClassifyError(
                'access.schemeId is unknown: this client has resolved no composition. ' +
                    'Use EzClassifyClient.connect() / connectContext(), or call describeContext() or fetchProfile() first.',
                ErrorCodes.INVALID_INPUT,
            );
        }
        return id;
    }

    /**
     * Check whether a user's attributes satisfy the access requirements of
     * tagged data. The second argument is always the `userAttributes` map; the
     * target is the `dataAssertions` array. An assertion array is invalid in
     * place of `userAttributes` and is rejected.
     *
     * Every call goes to the wire unless the client was built with
     * `cacheAccessDecisions`. The default is not a performance oversight: the
     * request is what puts the decision in the runtime's audit record, against
     * the artifact versions that answered it, and a decision served from the
     * client's memory is a decision the deployment cannot show anyone. The
     * option is the consumer choosing traffic over that record; see
     * `cacheAccessDecisions` in the client options.
     */
    async check(
        dataAssertions: Assertion[],
        userAttributes: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<AccessDecision> {
        // The SchemeEngineAdapter surface types userAttributes as `unknown`,
        // so guard at runtime too: an assertion array is a target shape, and
        // silently folding it into the target would omit the required map.
        if (Array.isArray(userAttributes)) {
            throw new EzClassifyError(
                'access.check() userAttributes must be an object, not an assertion array',
                ErrorCodes.INVALID_INPUT,
            );
        }
        // The Context supplies the access policy and scheme, so the body is
        // payload only.
        // Wire contract (CtxAccessCheckRequestBody): the structured TARGET is
        // `assertions` and the SUBJECT is the `userAttributes` attribute map,
        // which the server reads exactly.
        const path = this._c._ctxScopedPath('access/check');
        const body = {
            assertions: dataAssertions,
            userAttributes,
            ...(context != null ? { context } : {}),
        };
        return this._c._cachedDecision(
            'access.check',
            path,
            body,
            (signal, wireBody) =>
                this._c._requestEngine<AccessDecision>(
                    'POST',
                    path,
                    wireBody,
                    signal,
                ),
        );
    }

    /**
     * Describe one rule in the Context's access policy: its requirement and
     * activation text, the `userAttributes` paths it reads, and the rules it
     * depends on or overrides.
     */
    async describeAccessRule(ruleId: string): Promise<AccessRuleDescription> {
        return this._c._requestEngine<AccessRuleDescription>(
            'POST',
            this._c._ctxScopedPath('access/describe-rule'),
            { ruleId },
        );
    }

    /**
     * Describe the immutable requirements a trusted target carries, as the bare
     * description. `client.context.accessRequirements()` is the same operation
     * with the resolved Context envelope kept.
     */
    async describeAccessRequirements(
        input: AccessRequirementsInput,
    ): Promise<AccessRequirementsDescription> {
        return this._c._requestEngine<AccessRequirementsDescription>(
            'POST',
            this._c._ctxScopedPath('access/describe-requirements'),
            input,
        );
    }

    /**
     * Describe every rule in the Context's access policy, in declared order.
     *
     * One route serves both halves of the contract: {@link listAccessRuleIds}
     * reads the ids off this response rather than asking for a list of its own.
     * On a client with the request cache on, which is the default, a repeat
     * call is served from it and costs nothing: within the hour on an unpinned
     * client, and for the life of the entry on one pinned to a Context version,
     * where nothing expires. A client constructed with `disableCache` has no
     * cache to serve it, so there each call is its own round trip.
     */
    async describeAllAccessRules(): Promise<AccessRuleDescription[]> {
        const path = this._c._ctxScopedPath('access/rules');
        // Not `_requestEngine`: this route answers the rule list directly
        // rather than under the Context envelope its siblings use.
        //
        // The shape check runs inside the thunk so a malformed body rejects
        // the entry rather than settling it. Checking after the cache would
        // file the bad payload and throw for every later caller, and a pinned
        // client would never expire it.
        return this._c._cachedWire(
            'describeAllAccessRules',
            path,
            null,
            async () => {
                const wire = await this._c._request<{ rules?: unknown }>(
                    'GET',
                    path,
                );
                if (!Array.isArray(wire?.rules)) {
                    throw new EzClassifyError(
                        'access/rules response is missing its `rules` array',
                        ErrorCodes.MALFORMED_RESPONSE,
                    );
                }
                return wire.rules as AccessRuleDescription[];
            },
            { ttlMs: LONG_TTL_MS },
        );
    }

    /** Ids of every rule in the Context's access policy, in declared order. */
    async listAccessRuleIds(): Promise<string[]> {
        const rules = await this.describeAllAccessRules();
        return rules.map((rule) => rule.rule.ruleId);
    }
}
