/**
 * EzClassifyClient: thin client for an EzClassify REST API. Exposes four
 * sub-objects for domain-specific operations: client.scheme for marking scheme
 * operations (process, aggregate, suggest, scan, …), client.guide for guide
 * operations (scan, evaluate, …), client.access for access-control operations
 * (check), and client.context for composed-context operations (audit,
 * checkAccess, …).
 *
 * It also implements the shared adapter contract, so UI bindings can consume
 * the client directly without application code importing the embedded engine.
 */

import type {
    Assertion,
    AccessDecision,
    ContextCrosswalkDescriptor,
    ContextSchemeDescriptor,
    ContextSchemeRole,
    RemoteContextAdapter,
    ContextOperationResult,
    CrosswalkTranslationInput,
    CrosswalkTranslationResult,
    DocumentAssessmentInput,
    DocumentAuditReport,
    AccessRequirementsInput,
    AccessRequirementsDescription,
    SchemePublicView,
    MarkingColorRule,
    Vocabulary,
} from '@ezclassify/types';
import { deepFreeze } from './scheme-state';
import {
    RequestCache,
    cacheKeyForWireValue,
    wireSnapshot,
} from './request-cache';
import { EzClassifyError, ErrorCodes, isDenialShapedBody } from './errors';
import { CLIENT_SPEC_VERSION } from './spec-version';
import {
    ContextSchemes,
    SchemeProfileState,
    SchemeOps,
    GuideOps,
    AccessOps,
    ContextOps,
} from './client-ops';
import {
    parseContextOperationResult,
    type ContextResultShape,
} from './context-envelope';
import { assertResponseShape } from './response-check';
import { RequestBudget } from './request-budget';

/**
 * One artifact taking part in a resolved Context: the id and version the
 * Context declared, plus the concrete version those resolved to.
 */
export interface ContextComponentRef {
    /** Artifact id as the Context declares it. */
    id: string;
    /** Version literal the Context declares (a concrete semver, or `latest`). */
    version: string;
    /** Concrete version after `latest` resolution. */
    resolvedVersion: string;
    /**
     * Layers stacked beneath this component, in composition order. Sent on the
     * composed scheme and on each crosswalk; absent when it has none.
     */
    layers?: ContextComponentRef[];
}

/**
 * What a Context is made of, as the server resolved it.
 *
 * This is the composition a context-bound client operates against, and it is
 * settled the moment the Context resolves: a client that holds it knows which
 * guides and which access policy its Context declares without asking again.
 * That is what lets the synchronous guide-metadata accessors and
 * `access.schemeId` answer at all on a remote client.
 */
export interface ContextDescription {
    /** Context id. */
    id: string;
    /** Concrete Context version after `latest` resolution. */
    version: string;
    /** Human-readable description copied from the Context declaration. */
    description?: string;
    /** The composed scheme: the base of the layer stack. */
    scheme: ContextComponentRef;
    /**
     * Every scheme the Context holds, primary first, each with the selector
     * that addresses it.
     *
     * Always sent. The selector is a Context-local key that need not equal the
     * component id, so it is read from the server and never derived from
     * `scheme`.
     */
    schemes: ContextSchemeDescriptor[];
    /**
     * Layer components in composition order: the layers of the composed scheme,
     * as `scheme.layers` reports them. Empty when the Context stacks none.
     */
    layers: ContextComponentRef[];
    /**
     * Guide components in precedence order. Empty when the Context declares
     * none.
     */
    guides: ContextComponentRef[];
    /** Access policy component, absent when the Context declares none. */
    access?: ContextComponentRef;
    /**
     * Crosswalk components in declaration order, each with the layers it stacks
     * and the concrete version that answered. Empty when the Context declares
     * none.
     */
    crosswalks: ContextComponentRef[];
}

/**
 * The roles a Context can give a scheme it holds.
 *
 * Written as a record keyed by the contract's own union so the compiler is what
 * keeps it current: a role added to `ContextSchemeRole` fails the build here
 * until it is listed, and a role removed from it fails the same way.
 */
const CONTEXT_SCHEME_ROLES: Record<ContextSchemeRole, true> = {
    'primary': true,
    'crosswalk-source': true,
    'crosswalk-target': true,
    'additional': true,
};

/** Whether one wire entry is a descriptor a caller can actually act on. */
function isSchemeDescriptor(value: unknown): value is ContextSchemeDescriptor {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    const roles = entry['roles'];
    return (
        typeof entry['selector'] === 'string' &&
        typeof entry['id'] === 'string' &&
        typeof entry['version'] === 'string' &&
        Array.isArray(roles) &&
        // "Never empty" is the contract: a scheme the Context holds for no
        // stated reason is `additional`, not a scheme with no roles.
        roles.length > 0 &&
        roles.every(
            (role) =>
                typeof role === 'string' &&
                Object.hasOwn(CONTEXT_SCHEME_ROLES, role),
        )
    );
}

/**
 * Read the held-scheme inventory out of a Context description body.
 *
 * The inventory is the one part of the description a caller reaches back into
 * the server with: the selector goes on the wire as `?scheme=`. A descriptor
 * the client cannot vouch for is worse than none, because it would arrive typed
 * and be trusted, so anything short of a whole descriptor makes the response
 * malformed rather than being dropped or patched up.
 *
 * @param value - The `schemes` member of the response body
 * @returns The inventory
 * @throws {EzClassifyError} When the inventory is absent or not readable
 */
function readSchemeInventory(value: unknown): ContextSchemeDescriptor[] {
    if (!Array.isArray(value) || !value.every(isSchemeDescriptor)) {
        throw new EzClassifyError(
            'Context description response carries a malformed scheme inventory',
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    return value;
}

/**
 * Profiles for every scheme a Context holds, read at one concrete version and
 * installed together.
 */
interface HeldProfiles {
    /** The primary scheme's. */
    primary: ContextSchemeProfile;
    /** The key the description lists the primary under. */
    primaryKey: string | undefined;
    /** Every other held scheme's, by its Context-local key. */
    others: Map<string, ContextSchemeProfile>;
}

/** The key a Context description lists its primary scheme under. */
function primaryKeyOf(description: ContextDescription): string | undefined {
    return description.schemes.find((held) => held.roles.includes('primary'))
        ?.selector;
}

/**
 * Read the `GET /v1/ctx/{ctxId}/{version}` body into {@link ContextDescription}.
 *
 * The wire omits `layers`, `guides`, `crosswalks` and `access` rather than
 * sending empty collections, and "the Context declares no guide" is exactly the
 * answer the guide surface needs, so the omission is normalized here into an
 * empty array once instead of at every reader.
 *
 * @param wire - The parsed response body
 * @returns The description the guide and access surfaces read
 */
function readContextDescription(wire: unknown): ContextDescription {
    const body = (wire ?? {}) as Record<string, unknown>;
    const scheme = body['scheme'] as ContextComponentRef | undefined;
    if (
        typeof body['id'] !== 'string' ||
        typeof body['version'] !== 'string' ||
        !scheme ||
        typeof scheme.id !== 'string'
    ) {
        throw new EzClassifyError(
            'Context description response is missing its `id`, `version` or `scheme`',
            ErrorCodes.MALFORMED_RESPONSE,
        );
    }
    const description: ContextDescription = {
        id: body['id'],
        version: body['version'],
        scheme,
        layers: scheme.layers ?? [],
        guides: Array.isArray(body['guides'])
            ? (body['guides'] as ContextComponentRef[])
            : [],
        crosswalks: Array.isArray(body['crosswalks'])
            ? (body['crosswalks'] as ContextComponentRef[])
            : [],
        schemes: readSchemeInventory(body['schemes']),
    };
    if (typeof body['description'] === 'string') {
        description.description = body['description'];
    }
    if (body['access']) {
        description.access = body['access'] as ContextComponentRef;
    }
    return description;
}

/** What the client tells a token supplier about the request it is about to send. */
export interface TokenRequest {
    /**
     * The token sent a moment ago was refused and this call is the replay. A
     * supplier that caches, or that reads a token its auth library holds, has
     * to refresh here or the replay repeats the rejected credential.
     */
    forceRefresh: boolean;
}

/**
 * Supplies the caller identity token for one request.
 *
 * Return the token the host currently holds. The client calls this on every
 * request and keeps nothing, so a browser session that rotates a short-lived
 * token keeps working without rebuilding the client.
 *
 * @param request - Why the client is asking, including the force-refresh flag
 * @returns The bearer token, or a promise for it
 */
export type AccessTokenSupplier = (
    request: TokenRequest,
) => string | Promise<string>;

/** Resolve a renewed signed Context token for the same app and policy binding. */
export type ContextTokenSupplier = () => string | Promise<string>;

/**
 * Caller identity for every request a client makes.
 *
 * One client instance serves one caller. Memoized results are filed under the
 * operation and the composition, not under who asked for them, so a host that
 * switches to a different person builds a new client rather than repointing
 * this one. A supplier that refreshes the same person's token is the case this
 * is built for and needs nothing extra.
 */
export interface ClientAuth {
    /**
     * Access token sent as `Authorization: Bearer ...`.
     *
     * A string is captured once and sent forever, which suits a short-lived
     * script. Pass a supplier instead for anything long-lived: it is called per
     * request and its result is never held past that request. Only a supplier
     * can answer a suspected auth failure with a different credential, so it is
     * also what earns the single re-resolve-and-replay.
     */
    token: string | AccessTokenSupplier;
}

/** Options for constructing an EzClassifyClient. */
export interface EzClassifyClientOptions {
    /**
     * Caller identity: the token to send.
     *
     * Ignored when `headers` already carries an `Authorization` entry.
     */
    auth?: ClientAuth;
    /**
     * The id this application is registered under in Studio. Sent as
     * `x-ezclassify-application-id` on every Context request so the deployment
     * can report usage per application. It is a label, not a credential: it
     * authorizes nothing, and a request without it, or with an id the
     * deployment has not registered, is served the same way.
     *
     * Must be 1 to 128 characters, each a visible ASCII character (`0x21` to
     * `0x7e`: no spaces, control characters or non-ASCII). The client refuses
     * any other value at construction. A value outside that grammar would be
     * served and counted as unidentified. Do not also write the header in
     * `headers`.
     */
    applicationId?: string;
    /**
     * Signed Context authorization envelope carrier. A supplier is called on
     * each Context request so platform-owned renewal requires no client
     * rebuild. It must retain the same application and Context binding.
     */
    contextToken?: string | ContextTokenSupplier;
    /**
     * Additional request headers. In bearer mode an `Authorization` header here
     * takes precedence over `auth` and is never overwritten.
     *
     * Read once, at construction. A bearer token that changes per request
     * belongs in an `auth.token` supplier, which is asked every time.
     */
    headers?: Record<string, string>;
    /**
     * Bind every op to a specific published Context.
     *
     * With `contextVersion` set, op URLs become
     * `/v1/ctx/{contextId}/{contextVersion}/<scheme|guide|access>/<op>`.
     *
     * With `contextVersion` omitted, the URLs drop the version segment and the
     * server chooses. Caller authentication remains a separate credential.
     */
    contextId?: string;
    /**
     * Version of the bound Context. Omit the version to let the server choose:
     * the Context token's default, or the newest published.
     *
     * A concrete version pins the client to that immutable composition. An
     * omitted version, an empty string, or `latest` leaves it unpinned: the
     * server resolves the version on every request and cache entries expire on
     * their TTL.
     */
    contextVersion?: string;
    /**
     * Request timeout in milliseconds (default: 30000).
     *
     * One deadline covers the whole request: the `auth.token` and
     * `contextToken` suppliers, the transport, the response body and the single
     * replay. A supplier that never settles fails the request with `TIMEOUT`
     * once it elapses. The client stops waiting for that code but cannot stop
     * it running.
     */
    timeout?: number;
    /**
     * Disable the in-client request cache (default: false, caching is on).
     * Tests set this to exercise the wire path directly.
     */
    disableCache?: boolean;
    /**
     * Override the fetch implementation, for tests or for a host that needs its
     * own transport. Defaults to `globalThis.fetch`.
     */
    fetchImpl?: typeof fetch;
}

const CLIENT_OPTION_KEYS: Record<keyof EzClassifyClientOptions, true> = {
    auth: true,
    applicationId: true,
    contextToken: true,
    headers: true,
    contextId: true,
    contextVersion: true,
    timeout: true,
    disableCache: true,
    fetchImpl: true,
};

// ECMAScript Object.prototype metadata, including Annex B accessor helpers.
// Keep this intrinsic list fixed so ambient extra keys are not admitted.
const OBJECT_PROTOTYPE_KEYS = new Set([
    'constructor',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'toString',
    'valueOf',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    '__proto__',
]);

/** Response from {@link EzClassifyClient.ping}. */
export interface PingResult {
    /** Engine version currently running on the server. */
    engineVersion: string;
    /**
     * Git commit SHA of the deployed server build (empty string when
     * unavailable).
     */
    engineSha: string;
    /** Git tag of the deployed server build (empty string when unavailable). */
    gitTag: string;
}

/**
 * The one version alias the `/v1/ctx` URL space resolves rather than matches.
 *
 * Every other version segment is looked up as written, so a client that named
 * one is bound to that exact published Context for its whole life. `latest`
 * moves the moment a newer version is published.
 */
const MUTABLE_VERSION_ALIAS = 'latest';

/** Header carrying the registered application id, sent on Context requests. */
const APPLICATION_ID_HEADER = 'x-ezclassify-application-id';
/** The application id grammar: 1 to 128 characters, each `0x21` to `0x7e`. */
const APPLICATION_ID_PATTERN = /^[\u0021-\u007e]{1,128}$/u;

/**
 * Response header naming the concrete Context version that answered.
 *
 * The dispatcher sets it on every `/v1/ctx` response, and it is on the CORS
 * expose list, so a browser can read it. It is the only thing that tells an
 * unpinned client its alias moved.
 */
const RESOLVED_VERSION_HEADER = 'X-EzClassify-Resolved-Version';

/**
 * Whether these options bind a client to one concrete, immutable published
 * Context version.
 *
 * A version segment is a pin only when the caller wrote a concrete one:
 * `latest` resolves to whatever is newest at request time, and an omitted
 * version lets the server pick the Context token's default (which can be
 * re-signed) or the newest published. Neither is a promise that the same
 * request answers the same way tomorrow.
 */
function isVersionPinned(options?: EzClassifyClientOptions): boolean {
    return (
        !!options?.contextId &&
        !!options?.contextVersion &&
        options.contextVersion !== MUTABLE_VERSION_ALIAS
    );
}

/** How much of an unstructured error body is worth putting in a message. */
const ERROR_BODY_PREVIEW_CHARS = 200;

/**
 * Render the tail of an error message for a response whose body carried no
 * `error` field.
 *
 * A deployment that answers with something other than the documented error
 * shape still owes the caller a clue, so a short prefix of what it did send
 * goes in the message. Only a prefix: an exception message travels further than
 * the response did, through browser consoles and log shippers, and a whole body
 * in there is a lot of somebody's content to carry by accident. The body is
 * preserved intact on `EzClassifyError.body` for anyone who wants it.
 */
function summarizeErrorBody(errorBody: string): string {
    const collapsed = errorBody.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    if (collapsed.length <= ERROR_BODY_PREVIEW_CHARS) return `: ${collapsed}`;
    return (
        `: ${collapsed.slice(0, ERROR_BODY_PREVIEW_CHARS)}` +
        ` [body truncated, see EzClassifyError.body]`
    );
}

/**
 * Read one string member out of a parsed error body.
 *
 * The body of a failed response is whatever the deployment sent, including a
 * plain string or nothing at all, so every read of it is guarded the same way.
 *
 * @param body - Parsed response body, of any shape
 * @param key - Member to read
 * @returns The member when it is present and a string, otherwise undefined
 */
function readStringField(body: unknown, key: string): string | undefined {
    if (body === null || typeof body !== 'object') return undefined;
    const value = (body as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

/**
 * The delay, in seconds, a 429 response asks for.
 *
 * The header wins because it is what a proxy in front of the server can also
 * set; the body repeats the value for callers that never see headers. A header
 * that is not a plain count of seconds (the HTTP-date form) is passed over for
 * the body rather than guessed at.
 */
function readRetryAfter(response: Response, body: unknown): number | undefined {
    const header = response.headers?.get('Retry-After')?.trim();
    if (header && /^\d+(\.\d+)?$/.test(header)) return Number(header);
    if (body !== null && typeof body === 'object') {
        const value = (body as Record<string, unknown>).retryAfter;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return value;
        }
    }
    return undefined;
}

/** Extract `major.minor` from a semver string for loose version comparison. */
function _majorMinor(version: string): string {
    const parts = version.split('.');
    return `${parts[0] ?? '0'}.${parts[1] ?? '0'}`;
}

/**
 * The scheme a Context-bound client caches: the public view its synchronous
 * accessors answer from, read at one concrete Context version.
 *
 * @internal
 */
export interface ContextSchemeProfile {
    /** The scheme as it displays. */
    view: SchemePublicView;
}

/**
 * A REST API client that delegates marking-scheme operations, guide operations,
 * and access-control operations to dedicated sub-objects.
 *
 * Instead of loading a profile and running the pipeline locally, all operations
 * are delegated to a remote EzClassify REST API server.
 *
 * Implements the remote adapter contract so it works directly with the forms
 * library.
 *
 * @example
 *
 * ```ts
 * const client = await EzClassifyClient.connect(url, {
 *     contextId: 'corp-default',
 *     contextVersion: '1.0.0',
 * });
 * await client.scheme.process('HIGH');
 * await client.guide.evaluate('my-guide', ['rule-1']);
 * await client.access.check(assertions, { clearance: 'HIGH' });
 * ```
 */
export class EzClassifyClient implements RemoteContextAdapter {
    private readonly _baseUrl: string;
    private readonly _authToken?: string | AccessTokenSupplier;
    private readonly _contextToken?: string | ContextTokenSupplier;
    private readonly _headers: Record<string, string>;
    private readonly _applicationId?: string;
    /**
     * Caller spelled out an Authorization header, so the client keeps its hands
     * off it.
     */
    private readonly _callerOwnsAuthorization: boolean;
    /**
     * Some caller credential is in play, which is what makes a denial-shaped
     * 404 suspicious.
     */
    private readonly _authConfigured: boolean;
    /**
     * Read when building Context-bound operation paths
     *
     * @internal
     */
    private readonly _contextId?: string;
    /**
     * Read when building Context-bound operation paths
     *
     * @internal
     */
    private readonly _contextVersion?: string;
    /**
     * The resolved composition, once something has fetched it.
     *
     * Read by GuideOps and AccessOps, which are the surfaces the base adapter
     * contract requires to answer synchronously about the composition.
     *
     * @internal
     */
    _contextDescription: ContextDescription | null = null;
    /**
     * The description request already on the wire, so concurrent first callers
     * share one trip. Cleared when it settles; a failure leaves nothing behind
     * and the next caller tries again.
     */
    private _contextDescriptionInFlight: Promise<ContextDescription> | null =
        null;
    private readonly _timeout: number;
    private readonly _fetch: typeof fetch;
    /**
     * Some request has completed. A suspected auth failure is only believed
     * from a client that has: its first failure is far more likely a wrong base
     * URL than a stale credential.
     */
    private _hasConnected = false;
    private _destroyed = false;
    private _versionWarnEmitted = false;
    /**
     * The response cache, read by the operation objects
     *
     * @internal
     */
    _cache: RequestCache | null;
    /**
     * Bound to one concrete published Context version, so no engine op's answer
     * can change under this client. Decided once, at construction, and read
     * wherever a cache entry's lifetime is chosen.
     */
    private readonly _versionPinned: boolean;
    /**
     * Concrete Context version the cached profile was assembled at.
     *
     * Under a pin this never moves. Under `latest` or an omitted version it
     * can: the composition behind the binding is republished, every operation
     * follows because each one re-resolves per request, and the profile would
     * not, because nothing refreshes it. Holding the version the profile was
     * built at is what lets an operation's response header say the alias
     * moved.
     */
    private _profileContextVersion: string | null = null;
    /**
     * The concrete Context version the most recent response was answered at, on
     * an unpinned binding. Entries in the response cache were answered under
     * it, so a response that names a different one means they are stale.
     */
    private _answeredVersion: string | null = null;
    /** A re-warm already in flight, so a burst of responses starts one. */
    private _profileRewarm: Promise<void> | null = null;
    /**
     * The primary scheme's cached profile and its synchronous reads. Installing
     * a profile clears the response cache: a memoized answer was computed
     * against the composition that just went away.
     *
     * @internal
     */
    readonly _primaryState = new SchemeProfileState(() => this._cache?.clear());

    /**
     * Marking-scheme operations: process, aggregate, suggest, scan, validate,
     * diff, …
     */
    readonly scheme: SchemeOps;
    /** Guide operations: scan, evaluate, evaluateMany, … */
    readonly guide: GuideOps;
    /** Access-control operations: check, describeAccessRule, … */
    readonly access: AccessOps;
    /** Composed operations on the remotely resolved Context. */
    readonly context: ContextOps;
    /**
     * The other schemes the bound Context holds, reached by key:
     * `client.schemes.get('district-records')`. {@link scheme} stays the
     * primary.
     */
    readonly schemes: ContextSchemes;
    /**
     * The view of each key other than the primary's. One per key for the life
     * of the client, so every caller naming a scheme shares its profile and its
     * cache entries.
     */
    private readonly _schemeViews = new Map<string, SchemeOps>();

    /**
     * Whether a request has completed against the REST API and the client is
     * still in use. Required by the adapter contract; the client holds no
     * connection open and does not poll the server.
     */
    get connected(): boolean {
        return this._hasConnected && !this._destroyed;
    }

    /**
     * Presence of optional families in the resolved Context composition.
     *
     * A context-bound client caches this decomposition during
     * `connectContext()`, so callers can answer presence synchronously without
     * probing guide or access routes. This deliberately distinguishes a present
     * access policy with no rules from a Context that declares no access
     * policy.
     */
    get compositionPresence():
        { readonly guides: boolean; readonly access: boolean } | undefined {
        const description = this._contextDescription;
        if (!description) return undefined;
        return {
            guides: description.guides.length > 0,
            access: description.access !== undefined,
        };
    }

    constructor(baseUrl: string, options?: EzClassifyClientOptions) {
        // Refuse unknown configuration before it can silently drop caller auth.
        for (
            let bag: object | null = options ?? null;
            bag;
            bag = Object.getPrototypeOf(bag)
        ) {
            for (const key of Reflect.ownKeys(bag)) {
                // A class prototype's constructor is not an option field.
                if (bag !== options && key === 'constructor') continue;
                if (
                    bag === Object.prototype &&
                    typeof key === 'string' &&
                    OBJECT_PROTOTYPE_KEYS.has(key)
                )
                    continue;
                if (
                    typeof key !== 'string' ||
                    !Object.prototype.hasOwnProperty.call(
                        CLIENT_OPTION_KEYS,
                        key,
                    )
                ) {
                    throw new EzClassifyError(
                        'EzClassifyClient: unsupported constructor option.',
                        ErrorCodes.INVALID_INPUT,
                    );
                }
            }
        }
        // URL parsing normalizes these segments before a request is sent,
        // which would move a credential outside the Context path it authorizes.
        for (const binding of ['contextId', 'contextVersion'] as const) {
            const value = options?.[binding];
            if (value === '.' || value === '..') {
                throw new EzClassifyError(
                    `EzClassifyClient: ${binding} must name a Context path segment.`,
                    ErrorCodes.INVALID_INPUT,
                );
            }
        }
        if (
            options?.timeout !== undefined &&
            (!Number.isFinite(options.timeout) || options.timeout <= 0)
        ) {
            // A zero or negative deadline aborts every request before it can
            // leave, which reads as a server that answers nothing.
            throw new EzClassifyError(
                'EzClassifyClient: `timeout` must be a positive number of milliseconds.',
                ErrorCodes.INVALID_INPUT,
            );
        }
        this._baseUrl = baseUrl.replace(/\/+$/, '');
        this._authToken = options?.auth?.token;
        this._contextToken = options?.contextToken;
        // Copied, not held by reference: `_callerOwnsAuthorization` is decided
        // here once, so a header map that changed afterward would send an
        // Authorization the client still believes it owns.
        this._headers = { ...(options?.headers ?? {}) };
        this._callerOwnsAuthorization = Object.keys(this._headers).some(
            (name) => name.toLowerCase() === 'authorization',
        );
        const applicationId = options?.applicationId;
        if (applicationId !== undefined) {
            if (
                typeof applicationId !== 'string' ||
                !APPLICATION_ID_PATTERN.test(applicationId)
            ) {
                throw new EzClassifyError(
                    'EzClassifyClient: `applicationId` must be 1 to 128 characters, each a visible ASCII character (0x21 to 0x7e).',
                    ErrorCodes.INVALID_INPUT,
                );
            }
            if (
                Object.keys(this._headers).some(
                    (name) => name.toLowerCase() === APPLICATION_ID_HEADER,
                )
            ) {
                throw new EzClassifyError(
                    'EzClassifyClient: set the application id with `applicationId`, not in `headers`.',
                    ErrorCodes.INVALID_INPUT,
                );
            }
            this._applicationId = applicationId;
        }
        this._authConfigured =
            this._callerOwnsAuthorization || !!options?.auth?.token;
        this._contextId = options?.contextId;
        // An empty string cannot name a version, so it means the same as
        // leaving the option out: the server chooses.
        this._contextVersion = options?.contextVersion || undefined;
        this._timeout = options?.timeout ?? 30_000;
        // Called as a plain function, never as a method of this client: a
        // browser's `window.fetch` refuses any other receiver, and the client
        // is not something to hand to the caller's transport.
        const fetchImpl = options?.fetchImpl;
        this._fetch = fetchImpl
            ? (url, init) => fetchImpl(url, init)
            : (url, init) => globalThis.fetch(url, init);
        this._cache = options?.disableCache ? null : new RequestCache();
        this._versionPinned = isVersionPinned(options);
        this.scheme = new SchemeOps(this);
        this.schemes = new ContextSchemes((key) => this._schemeView(key));
        this.guide = new GuideOps(this);
        this.access = new AccessOps(this);
        this.context = new ContextOps(this);
    }

    /**
     * Drop every memoized engine-op result. Call this when the backing profile
     * may have been updated upstream.
     *
     * On a client pinned to a concrete Context version, entries have no expiry
     * at all, so this and LRU eviction are the only things that remove one. A
     * pinned client should not need it: the version it named cannot be
     * republished with different content.
     */
    clearCache(): void {
        this._cache?.clear();
    }

    /**
     * Release resources. The client should not be used after calling destroy().
     *
     * Memoized entries are dropped: an entry holds its request body as the key
     * and the answer as the value, so a discarded client that stays reachable
     * would otherwise keep both alive. The client runs no timers, so calling
     * this is housekeeping rather than a duty. Requests already on the wire are
     * abandoned rather than canceled; a caller that needs them stopped passes
     * its own signal.
     */
    destroy(): void {
        this._destroyed = true;
        this._cache?.clear();
    }

    /**
     * Return the wire spec version this client was built against.
     *
     * A build-time constant, stamped from `info.version` in
     * `vendor/spec/openapi.yaml` by `scripts/generate-spec-version.mjs`. It is
     * the version of the REST contract this build was compiled against, which
     * is what {@link ping} compares against the server's reported
     * `engineVersion`.
     */
    engineSpecVersion(): string {
        return CLIENT_SPEC_VERSION;
    }

    /**
     * Ping the live server and return its engine version, git SHA, and git tag.
     *
     * On the first call, if the server's major.minor version differs from
     * {@link engineSpecVersion}, a warning is logged to the console.
     */
    async ping(): Promise<PingResult> {
        const health = await this._request<{
            engineVersion: string;
            engineSha: string;
            gitTag: string;
        }>('GET', '/v1/health', undefined, AbortSignal.timeout(5_000));
        const result: PingResult = {
            engineVersion: health.engineVersion ?? '',
            engineSha: health.engineSha ?? '',
            gitTag: health.gitTag ?? '',
        };
        if (!this._versionWarnEmitted) {
            this._versionWarnEmitted = true;
            const specMinor = _majorMinor(CLIENT_SPEC_VERSION);
            const serverMinor = _majorMinor(result.engineVersion);
            if (specMinor !== serverMinor) {
                console.warn(
                    `@ezclassify/rest-client: built against the v${CLIENT_SPEC_VERSION} contract, ` +
                        `connected to a server reporting v${result.engineVersion}. Mixed minor versions are unsupported.`,
                );
            }
        }
        return result;
    }

    /**
     * Describe the Context this client is bound to, and cache the result.
     *
     * The composition a Context resolves to is fixed for the life of a version,
     * so this is fetched once and reused; callers that race the first call
     * share that one request rather than each opening their own, which also
     * keeps a concurrent `scheme.fetchProfile()` from duplicating the
     * six-request assembly behind it. It is what tells the client which guides
     * the Context declares, whether it declares an access policy, and which
     * scheme its access rules evaluate: the questions the base adapter contract
     * asks synchronously and no per-family route answers.
     *
     * @returns The resolved composition
     * @throws {EzClassifyError} When the client is not bound to a Context
     */
    async describeContext(): Promise<ContextDescription> {
        if (this._contextDescription) return this._contextDescription;
        // Not `_ctxScopedPath`: that builds an operation path under the Context
        // and this is the Context resource itself.
        if (!this._contextId) {
            throw new EzClassifyError(
                'describeContext() requires a context-bound client (construct with a `contextId`).',
                ErrorCodes.INVALID_INPUT,
            );
        }
        if (this._contextDescriptionInFlight) {
            return this._contextDescriptionInFlight;
        }
        const id = encodeURIComponent(this._contextId);
        // The description is a version resource. `/v1/ctx/{ctxId}` with no
        // version segment is a different resource, the version list, so a
        // client bound to no version asks for `latest` by name. The runtime
        // resolves `latest` exactly as it resolves an omitted segment on the
        // operation routes: the Context token's default, else the newest.
        const version = encodeURIComponent(this._contextVersion ?? 'latest');
        const path = `/v1/ctx/${id}/${version}`;
        const inFlight = this._request<unknown>('GET', path)
            .then((body) => {
                const description = deepFreeze(readContextDescription(body));
                this._contextDescription = description;
                return description;
            })
            .finally(() => {
                this._contextDescriptionInFlight = null;
            });
        this._contextDescriptionInFlight = inFlight;
        return inFlight;
    }

    /**
     * Every scheme the bound Context holds, primary first, each with the
     * selector that addresses it.
     *
     * This is where a caller learns what to pass as `?scheme=` on the Context
     * scheme resources. A crosswalk translation answers in its target scheme,
     * and rendering that answer means fetching the target's concepts and
     * formats, which means knowing its selector.
     *
     * Served from the cached Context description, so it costs a request only
     * the first time. The composition a Context version resolves to does not
     * change underneath it, so neither does this.
     *
     * @returns One descriptor per held scheme, in the order the server reports
     * @throws {EzClassifyError} When the client is not bound to a Context
     */
    async describeSchemes(): Promise<ContextSchemeDescriptor[]> {
        return (await this.describeContext()).schemes;
    }

    /**
     * Every crosswalk the bound Context holds, in declaration order, each with
     * its source and target scheme selectors and the mappings and selections a
     * translation applies. Delegates to `client.context.describeCrosswalks()`.
     *
     * A dedicated read rather than part of the Context description: reviewed
     * mappings run to tens of kilobytes, and most clients never translate.
     *
     * @returns One descriptor per crosswalk; empty when the Context declares
     *   none
     * @throws {EzClassifyError} When the client is not bound to a Context
     */
    async describeCrosswalks(): Promise<ContextCrosswalkDescriptor[]> {
        return this.context.describeCrosswalks();
    }

    /**
     * The view bound to a key, for {@link ContextSchemes.get}.
     *
     * The server decides whether the Context holds it. Every key gets its own
     * view, the same object every time, and the primary's key is no exception:
     * `this.scheme` answers in whatever is primary now, while a view answers in
     * its key even after a moving alias makes another scheme primary. A view
     * sends `?scheme=<key>` on every operation and profile read, keeps its own
     * profile for the synchronous reads, and keys its cache entries by the key,
     * so no answer crosses between schemes.
     */
    private _schemeView(key: string): SchemeOps {
        const existing = this._schemeViews.get(key);
        if (existing) return existing;
        const view = new SchemeOps(this, key);
        this._schemeViews.set(key, view);
        return view;
    }

    /**
     * List every Context visible to the caller.
     *
     * @returns Context ids in server order; non-string response entries are
     *   ignored.
     * @throws {EzClassifyError} If the request fails or the server refuses
     *   access.
     */
    async listContexts(): Promise<string[]> {
        const response = await this._request<{ contexts?: unknown }>(
            'GET',
            '/v1/ctx',
        );
        return Array.isArray(response.contexts)
            ? response.contexts.filter(
                  (value): value is string => typeof value === 'string',
              )
            : [];
    }

    /**
     * List every published version of a Context id.
     *
     * @param contextId - Context to discover, encoded as one URL path segment.
     * @returns Version strings in server order; non-string response entries are
     *   ignored.
     * @throws {EzClassifyError} If the request fails or the server refuses
     *   access.
     */
    async listContextVersions(contextId: string): Promise<string[]> {
        const response = await this._request<{
            id?: unknown;
            versions?: unknown;
        }>('GET', `/v1/ctx/${encodeURIComponent(contextId)}`);
        return Array.isArray(response.versions)
            ? response.versions.filter(
                  (value): value is string => typeof value === 'string',
              )
            : [];
    }

    /**
     * Verify health and warm the Context binding: the description, the profile
     * of every scheme the Context holds, and the guide metadata. Called by
     * {@link connectContext}.
     *
     * @throws {EzClassifyError} If connectivity, Context resolution, or profile
     *   loading fails.
     * @internal
     */
    async _open(): Promise<void> {
        await this._request<{ status: string }>(
            'GET',
            '/v1/health',
            undefined,
            AbortSignal.timeout(5_000),
        );

        // A context-bound client that skipped this would have to answer
        // "what guides does my Context have" and "which scheme do its
        // access rules evaluate" with a shrug, and both are settled facts
        // by the time the Context resolves.
        const description = await this.describeContext();
        // The description first, and not only for ordering's sake: it
        // carries the concrete version the binding resolved to, and the
        // six legs below are issued against that rather than against the
        // caller's `latest`. Six requests against one concrete version
        // cannot straddle two compositions the way six against a moving
        // alias can.
        //
        // This rejects rather than warning, unlike the guide warm below. A
        // caller who only marks text should not lose its connection over a
        // guide view; a client that connects without a profile is a client
        // whose entire synchronous surface throws, which is the failure
        // this warm exists to remove. Warning here would reproduce that
        // failure with a console line in front of it.
        //
        // Every other scheme the Context holds is warmed with it, for the
        // same reason: a view `schemes.get()` hands out answers its
        // synchronous reads at once, as the primary does.
        this._installHeldProfiles(await this._fetchHeldProfiles(description));
        this._profileContextVersion = description.version;
        await this.guide._warmGuideMeta();
    }

    /** Audit a document through the bound remote Context. */
    async audit(
        input: DocumentAssessmentInput,
    ): Promise<ContextOperationResult<DocumentAuditReport>> {
        return this.context.audit(input);
    }

    /** Evaluate a trusted target and retain the resolved Context envelope. */
    async checkContextAccess(
        target: string | Assertion[],
        userAttributes: Record<string, unknown>,
        context?: Record<string, unknown>,
    ): Promise<ContextOperationResult<AccessDecision>> {
        return this.context.checkAccess(target, userAttributes, context);
    }

    /** Describe immutable access requirements through the bound Context. */
    async accessRequirements(
        input: AccessRequirementsInput,
    ): Promise<ContextOperationResult<AccessRequirementsDescription>> {
        return this.context.accessRequirements(input);
    }

    /**
     * Apply a directional crosswalk declared by the bound Context. Delegates to
     * `client.context.translate()`.
     */
    async translate(
        input: CrosswalkTranslationInput,
    ): Promise<ContextOperationResult<CrosswalkTranslationResult>> {
        return this.context.translate(input);
    }

    /**
     * The composition component of a cache key: what the operation ran against.
     *
     * The Context binding is the most specific name the client has for the
     * server-owned composition.
     *
     * Called by SchemeOps, GuideOps, AccessOps
     *
     * @internal
     */
    _stackCacheKey(): string | undefined {
        if (!this._contextId) return undefined;
        return this._contextVersion
            ? `ctx:${this._contextId}@${this._contextVersion}`
            : `ctx:${this._contextId}`;
    }

    /**
     * The cache name for one scheme view's entries: the binding's, narrowed by
     * the held scheme's selector for any view but the primary's. The same
     * request to two schemes is two questions, so it is two entries.
     *
     * Called by SchemeOps
     *
     * @internal
     */
    _schemeCacheKey(selector: string | undefined): string | undefined {
        const stack = this._stackCacheKey();
        if (selector === undefined) return stack;
        return `${stack ?? ''}?scheme=${selector}`;
    }

    /**
     * Run one wire op through the response cache.
     *
     * The thunk is handed the signal to give the request, which is the shared
     * one when the cache is on: identical concurrent calls ride a single wire
     * trip, so no one caller's signal can be allowed to cancel it. The caller's
     * own signal goes to the cache, which uses it to settle that caller alone.
     *
     * Called by SchemeOps, GuideOps, AccessOps
     *
     * @internal
     */
    _cachedWire<T>(
        op: string,
        profile: string | undefined,
        body: unknown,
        thunk: (
            signal: AbortSignal | undefined,
            wireBody: unknown,
        ) => Promise<T>,
        options?: { ttlMs?: number; signal?: AbortSignal },
    ): Promise<T> {
        if (!this._cache) return thunk(options?.signal, body);
        const wireBody = wireSnapshot(body);
        return this._cache.get(
            cacheKeyForWireValue(op, profile, wireBody),
            (signal) => thunk(signal, wireBody),
            {
                ttlMs: this._entryTtlMs(options?.ttlMs),
                signal: options?.signal,
                label: op,
            },
        );
    }

    /**
     * How long one cache entry lives, decided by what this client is bound to.
     *
     * A `{contextId, contextVersion}` pin names a published, immutable version:
     * the composition behind it cannot change, so the same request answers the
     * same forever and an expiry would buy nothing but a round trip that
     * returns what the client already holds. Under a pin nothing expires and
     * LRU eviction is the only bound on the cache.
     *
     * `latest` and an omitted version both resolve through something that can
     * move, so they keep the per-op TTL or the client default. The binding is
     * read here, once, rather than by each operation: an op knows how volatile
     * its own answer is, not what the client is pointed at.
     */
    private _entryTtlMs(opTtlMs?: number): number | undefined {
        return this._versionPinned ? Number.POSITIVE_INFINITY : opTtlMs;
    }

    /**
     * Fetch a public profile from the scheme the bound Context names, composing
     * the responses of the `/v1/ctx/{ctxId}/{version}/scheme/*` sub-resources.
     *
     * The reads go to the Context the client is bound to, under the id it was
     * bound with. The description says what the Context is, and that is not
     * always where it is served: a held draft reports the Context its documents
     * name, while the server holds it under its own id.
     *
     * When the description names the bound id, its concrete version is a
     * version that id serves, so the path is built from it rather than from the
     * caller's binding, which may be `latest` or a version the signed carrier
     * defaulted. Six reads at one concrete version cannot straddle two
     * compositions. When the bound id holds a Context named otherwise, the
     * description's version is not one the bound id serves, so the reads go to
     * the binding's own version, or `latest` when it names none.
     *
     * There is no `?layers=` here. The layers belong to the Context, and the
     * server would refuse to honor the parameter anyway. `selector` names a
     * held scheme other than the primary, and goes on every read as `?scheme=`;
     * absent, the reads answer for the primary.
     *
     * Called by _open(), SchemeOps.fetchProfile() and the re-warm on an alias
     * move
     *
     * @internal
     */
    async _fetchProfileFromContext(
        description: ContextDescription,
        selector?: string,
    ): Promise<ContextSchemeProfile> {
        if (!this._contextId) {
            throw new EzClassifyError(
                'Reading a scheme profile requires a context-bound client (construct with a `contextId`).',
                ErrorCodes.INVALID_INPUT,
            );
        }
        const servedAt =
            description.id === this._contextId
                ? description.version
                : (this._contextVersion ?? 'latest');
        const id = encodeURIComponent(this._contextId);
        const version = encodeURIComponent(servedAt);
        return this._fetchSchemeResources(
            `/v1/ctx/${id}/${version}/scheme`,
            selector === undefined
                ? ''
                : `?${new URLSearchParams({ scheme: selector })}`,
        );
    }

    /**
     * Fetch the profile of every scheme a description says the Context holds:
     * the primary first, then one per other held scheme, all at the
     * description's concrete version. Nothing is installed, so a failure leaves
     * every profile the client already holds in place.
     */
    private async _fetchHeldProfiles(
        description: ContextDescription,
    ): Promise<HeldProfiles> {
        const others = description.schemes.filter(
            (held) => !held.roles.includes('primary'),
        );
        const [primary, ...rest] = await Promise.all([
            this._fetchProfileFromContext(description),
            ...others.map((held) =>
                this._fetchProfileFromContext(description, held.selector),
            ),
        ]);
        return {
            primary: primary!,
            primaryKey: primaryKeyOf(description),
            others: new Map(
                others.map((held, index) => [held.selector, rest[index]!]),
            ),
        };
    }

    /**
     * Install every profile {@link _fetchHeldProfiles} read, together, so the
     * synchronous surface never answers one scheme from one composition and
     * another from the next.
     *
     * A view whose key the description does not list loses its profile: its
     * synchronous reads refuse and its operations reach a server that refuses
     * the key, rather than either answering from what the Context used to be.
     * The primary's key has a view like any other, reading the primary's
     * profile.
     */
    private _installHeldProfiles(profiles: HeldProfiles): void {
        this._primaryState._setActiveProfile(profiles.primary);
        const held = new Map(profiles.others);
        if (profiles.primaryKey !== undefined) {
            held.set(profiles.primaryKey, profiles.primary);
        }
        for (const [key, profile] of held) {
            this._schemeView(key)._install(profile);
        }
        for (const [key, view] of this._schemeViews) {
            if (!held.has(key)) view._install(null);
        }
    }

    /**
     * Compose one cached profile from the six sub-resources under a path
     * prefix: summary, concepts, categories, formats, scopes, label presets.
     *
     * One assembly for every Context-bound scheme-resource path. Keeping the
     * six resource requests together makes any server/client divergence show up
     * here as a type error rather than as a partially rendered UI.
     */
    private async _fetchSchemeResources(
        base: string,
        query: string,
    ): Promise<ContextSchemeProfile> {
        const [summary, concepts, categories, formats, scopes, labelPresets] =
            await Promise.all([
                this._request<{
                    id: string;
                    version: string;
                    name: string;
                    description?: string;
                    definition?: string;
                    guidance?: string;
                    marking?: string;
                    colorFrom?: string;
                    colorRules?: MarkingColorRule[];
                    roleAware?: boolean;
                    vocabulary?: Vocabulary;
                    referenceSurfaceLabel: { singular: string; plural: string };
                    contextFormats?: { whole: string[]; part: string[] };
                    embeddedMarking?: Array<{
                        pattern: string;
                        template: string;
                    }>;
                    defaultScope?: string;
                    scopeLabel?: string;
                    defaultRenderFormat?: string;
                    defaultPartRenderFormat?: string;
                    defaultWholeRenderFormat?: string;
                }>('GET', `${base}${query}`),
                this._request<SchemePublicView['concepts']>(
                    'GET',
                    `${base}/concepts${query}`,
                ),
                this._request<SchemePublicView['categories']>(
                    'GET',
                    `${base}/categories${query}`,
                ),
                this._request<SchemePublicView['formats']>(
                    'GET',
                    `${base}/formats${query}`,
                ),
                this._request<NonNullable<SchemePublicView['scopes']>>(
                    'GET',
                    `${base}/scopes${query}`,
                ),
                this._request<SchemePublicView['labelPresets']>(
                    'GET',
                    `${base}/label-presets${query}`,
                ),
            ]);

        // The collections arrive as the views the profile holds, so they are
        // carried as sent. The server names the default render format so the
        // client does not guess from declaration order; when the scheme names
        // none the field is absent, and the contract's rule is the first
        // declared format.
        const view: SchemePublicView = {
            id: summary.id,
            version: summary.version,
            name: summary.name,
            description: summary.description,
            definition: summary.definition,
            guidance: summary.guidance,
            marking: summary.marking,
            colorFrom: summary.colorFrom,
            colorRules: summary.colorRules,
            concepts,
            categories,
            formats,
            defaultRenderFormat: summary.defaultRenderFormat ?? formats[0]?.id,
            scopes,
            defaultScope: summary.defaultScope,
            scopeLabel: summary.scopeLabel,
            // The wire omits the member for a scheme that never set it, and
            // the engine's own view reports an explicit false. Reading an
            // omission as false makes the two profiles equal.
            roleAware: summary.roleAware === true,
            vocabulary: summary.vocabulary,
            referenceSurfaceLabel: summary.referenceSurfaceLabel,
            contextFormats: summary.contextFormats,
            defaultPartRenderFormat: summary.defaultPartRenderFormat,
            defaultWholeRenderFormat: summary.defaultWholeRenderFormat,
            embeddedMarking: summary.embeddedMarking,
            labelPresets,
        };
        return { view };
    }

    /**
     * Build a Context-scoped request path. Throws when the client is not bound
     * to a Context: every operation addresses one.
     *
     * Called by the domain operation objects.
     *
     * @internal
     */
    _ctxScopedPath(suffix: string): string {
        if (!this._contextId) {
            throw new EzClassifyError(
                'This operation requires a context-bound client (construct with a `contextId`).',
                ErrorCodes.INVALID_INPUT,
            );
        }
        const id = encodeURIComponent(this._contextId);
        if (this._contextVersion) {
            return `/v1/ctx/${id}/${encodeURIComponent(this._contextVersion)}/${suffix}`;
        }
        return `/v1/ctx/${id}/${suffix}`;
    }

    /**
     * Request one Context operation and unwrap its envelope. Every caller
     * builds its path with {@link _ctxScopedPath}.
     *
     * `shape` loosens the envelope's check of the result for the one kind of
     * route that needs it; see {@link ContextResultShape}.
     *
     * Called by domain operation objects.
     *
     * @internal
     */
    async _requestEngine<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
        signal?: AbortSignal,
        shape?: ContextResultShape,
    ): Promise<T> {
        const response = await this._request<unknown>(
            method,
            path,
            body,
            signal,
        );
        return parseContextOperationResult<T>(response, 'forbidden', shape)
            .result;
    }

    /**
     * Resolve the caller identity token for a single request.
     *
     * A supplier is called every time and its answer is never stored, so the
     * client sends whatever the host considers current rather than whatever it
     * held at construction. `forceRefresh` marks the replay: the token just
     * sent was refused, and returning it again wastes the one retry.
     */
    private async _resolveAccessToken(
        forceRefresh: boolean,
        budget: RequestBudget,
    ): Promise<string | undefined> {
        const supplier = this._authToken;
        if (typeof supplier !== 'function') return supplier;
        return budget.run(
            'the auth.token supplier',
            () => supplier({ forceRefresh }),
            (err) =>
                new EzClassifyError(
                    `auth.token supplier failed: ${err instanceof Error ? err.message : String(err)}`,
                    ErrorCodes.INVALID_INPUT,
                ),
        );
    }

    /**
     * Build request headers while keeping Context authorization off probes.
     *
     * `accessToken` arrives undefined when the caller supplied its own
     * Authorization header, so this method never has to defend it.
     */
    private _buildHeaders(
        resolvedPath: string,
        accessToken?: string,
        contextToken?: string,
    ): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...this._headers,
        };
        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }
        const isContext =
            resolvedPath === '/v1/ctx' || resolvedPath.startsWith('/v1/ctx/');
        if (isContext && this._applicationId !== undefined) {
            headers[APPLICATION_ID_HEADER] = this._applicationId;
        }
        if (contextToken && isContext) {
            headers['X-EzClassify-Context-Token'] = contextToken;
        }
        return headers;
    }

    /**
     * Execute an HTTP request against the API and return the parsed JSON body.
     *
     * A request that looks like it failed on authentication is replayed exactly
     * once when a token supplier can produce a fresh credential. See
     * {@link _isSuspectedAuthFailure} for what qualifies; there is no loop, a
     * second failure is the caller's.
     *
     * Called by sub-objects and internal infrastructure
     *
     * @internal
     */
    async _request<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
        signal?: AbortSignal,
    ): Promise<T> {
        // Read before the attempt: the replay decision is about the state the
        // request started from.
        const wasWorking = this._hasConnected;
        // One budget for the whole request, replay included, so no
        // caller-supplied code on the way can stretch it past `timeout`.
        const budget = new RequestBudget(path, this._timeout, signal);
        try {
            try {
                return await this._attempt<T>(
                    method,
                    path,
                    body,
                    budget,
                    false,
                );
            } catch (err: unknown) {
                if (!this._isSuspectedAuthFailure(err, wasWorking)) throw err;
                if (!this._canReplayWithFreshToken()) throw err;
                // The credential the host is about to hand back may belong to
                // a different caller than the one the held entries were
                // computed for, and a cache key names the operation and the
                // composition, not who asked. Dropping them here costs a round
                // trip and keeps the replay from inheriting the previous
                // caller's answers.
                this._cache?.clear();
                return await this._attempt<T>(method, path, body, budget, true);
            }
        } finally {
            budget.close();
        }
    }

    /**
     * Whether a failed request looks like the server refusing the credential.
     *
     * Two failures are suspicious: the constant denial-shaped 404, and an
     * opaque transport failure, which is what a browser sees when the preflight
     * for an expired credential is rejected cross-origin. Neither is provable
     * from here, which is why the host is told and the replay is capped at
     * one.
     *
     * A client that has never completed a request is excluded: its first
     * failure is far more likely a wrong base URL than a stale credential.
     */
    private _isSuspectedAuthFailure(
        err: unknown,
        wasWorking: boolean,
    ): boolean {
        if (!wasWorking) return false;
        if (!this._authConfigured) return false;
        if (!(err instanceof EzClassifyError)) return false;
        return (
            err.possiblyUnauthenticated === true ||
            err.code === ErrorCodes.NETWORK
        );
    }

    /**
     * Whether a second try could carry anything the first one did not.
     *
     * Only a supplier can produce a different credential. A static token cannot
     * change, and a caller who wrote the `Authorization` header owns it, so in
     * both cases the replay would put the identical bytes back on the wire.
     */
    private _canReplayWithFreshToken(): boolean {
        if (this._callerOwnsAuthorization) return false;
        return typeof this._authToken === 'function';
    }

    /**
     * Observe the concrete Context version a response came back resolved at.
     * When it differs from the version the held entries were answered under,
     * the composition has moved: drop every response entry at once, then bring
     * the scheme profile up to date.
     *
     * Only an unpinned binding can move. Under `{contextId, contextVersion}`
     * the composition is immutable, so there is nothing to notice. Under
     * `latest`, or a version a signed carrier defaulted, the composition can be
     * republished while the client runs, and every operation follows because
     * each one re-resolves per request. The entries would not: an unpinned
     * binding keys them under the same name before and after the move, so
     * without the clear they keep answering from the old composition until
     * their lifetime runs out.
     *
     * The clear does not wait for the profile rebuild and does not depend on it
     * succeeding, and it does not depend on the client having a profile at all.
     * The response that noticed the move is delivered either way.
     *
     * The rebuild runs in the background rather than blocking that response. It
     * cannot be awaited here without turning every operation into a six-request
     * call, and the stale profile is what the caller already has; the point is
     * that it stops being stale. `_profileContextVersion` is advanced before
     * the fetch so a burst of responses at the new version starts one rebuild.
     */
    private _noteResolvedVersion(header: string | null): void {
        if (!header) return;
        if (this._versionPinned) return;
        if (!this._contextId) return;

        const held = this._answeredVersion;
        this._answeredVersion = header;
        if (held !== null && held !== header) this._cache?.clear();

        if (!this._primaryState._activeProfile || !this._profileContextVersion)
            return;
        if (header === this._profileContextVersion) return;
        if (this._profileRewarm) return;

        const previous = this._profileContextVersion;
        this._profileContextVersion = header;
        console.warn(
            `@ezclassify/rest-client: context ${this._contextId} resolved to ${header}, but the cached ` +
                `scheme profile was built at ${previous}. Rebuilding it; synchronous reads may ` +
                `answer from the older composition until that finishes. Bind to a concrete ` +
                `contextVersion to remove this entirely.`,
        );
        this._profileRewarm = (async () => {
            try {
                // The memoized description is what named the old version, so it
                // is dropped rather than reused: re-describing is what resolves
                // the alias again.
                this._contextDescription = null;
                const description = await this.describeContext();
                this._installHeldProfiles(
                    await this._fetchHeldProfiles(description),
                );
                this._profileContextVersion = description.version;
            } catch (err) {
                // A failed rebuild leaves the previous profile in place, which
                // is the only answer the synchronous surface can still give.
                // Reset the marker so the next response at the new version
                // tries again rather than concluding the move was handled.
                this._profileContextVersion = previous;
                console.warn(
                    `@ezclassify/rest-client: rebuilding the scheme profile for context ${this._contextId} ` +
                        `at ${header} failed: ${err instanceof Error ? err.message : String(err)}. ` +
                        `The profile from ${previous} is still in use.`,
                );
            } finally {
                this._profileRewarm = null;
            }
        })();
    }

    /**
     * Settle any scheme-profile rebuild an alias move started.
     *
     * Tests and callers that need the synchronous surface to reflect the moved
     * version await this; nothing in the request path does, on purpose.
     *
     * @internal
     */
    async _settleProfileRewarm(): Promise<void> {
        await this._profileRewarm;
    }

    /**
     * One trip to the wire, with no replay of its own.
     *
     * Every wait in here runs under the request's budget: the token suppliers,
     * the transport and the body read. A `fetchImpl` that ignores its signal is
     * bounded the same way a supplier is.
     */
    private async _attempt<T>(
        method: 'GET' | 'POST',
        path: string,
        body: unknown,
        budget: RequestBudget,
        forceTokenRefresh: boolean,
    ): Promise<T> {
        const url = `${this._baseUrl}${path}`;
        const accessToken = this._callerOwnsAuthorization
            ? undefined
            : await this._resolveAccessToken(forceTokenRefresh, budget);
        const contextTokenSupplier = this._contextToken;
        let contextToken =
            typeof contextTokenSupplier === 'string'
                ? contextTokenSupplier
                : undefined;
        if (
            typeof contextTokenSupplier === 'function' &&
            (path === '/v1/ctx' || path.startsWith('/v1/ctx/'))
        ) {
            const renewed = await budget.run(
                'the contextToken supplier',
                contextTokenSupplier,
            );
            if (typeof renewed !== 'string' || !renewed.trim()) {
                throw new EzClassifyError(
                    'contextToken supplier must return a non-empty signed token',
                    ErrorCodes.INVALID_INPUT,
                );
            }
            contextToken = renewed;
        }
        const init: RequestInit = {
            method,
            headers: this._buildHeaders(path, accessToken, contextToken),
            signal: budget.signal,
        };
        if (method === 'POST' && body !== undefined) {
            init.body = JSON.stringify(body);
        }

        // A spent budget is reported as TIMEOUT or ABORTED before this mapping
        // runs.
        const response = await budget.run(
            undefined,
            () => this._fetch(url, init),
            (err) => {
                // An abort the client did not cause, from a transport that
                // raised its own.
                if (err instanceof DOMException && err.name === 'AbortError') {
                    return new EzClassifyError(
                        `Request aborted: ${path}`,
                        ErrorCodes.ABORTED,
                    );
                }
                const message =
                    err instanceof Error ? err.message : String(err);
                return new EzClassifyError(
                    `Network error calling ${method} ${path}: ${message}`,
                    ErrorCodes.NETWORK,
                );
            },
        );

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await budget.run('the response body', () =>
                    response.text(),
                );
            } catch (err: unknown) {
                if (budget.signal.aborted) throw err;
                errorBody = '(could not read response body)';
            }
            let parsedBody: unknown;
            try {
                parsedBody = errorBody ? JSON.parse(errorBody) : undefined;
            } catch {
                parsedBody = errorBody;
            }
            const errorField = readStringField(parsedBody, 'error');
            const responseCode =
                readStringField(parsedBody, 'code') ?? ErrorCodes.HTTP;
            const responseDetail = readStringField(parsedBody, 'detail');
            const denialShaped =
                response.status === 404 && isDenialShapedBody(parsedBody);
            const possiblyUnauthenticated =
                denialShaped && this._authConfigured;
            // A held answer must not survive the server refusing this
            // caller, whatever credential the client holds: a bearer, a
            // Context token alone, or a static one that cannot replay.
            // The decision is the response's, not the configuration's, so
            // it does not wait on `_authConfigured`. Clear before the auth
            // hook or replay: either may fail. Resource-specific 404s have
            // a different body and keep the cache; they do not establish
            // that the credential was refused.
            if (response.status === 401 || denialShaped) {
                this._cache?.clear();
            }
            const retryAfter =
                response.status === 429
                    ? readRetryAfter(response, parsedBody)
                    : undefined;
            const message = possiblyUnauthenticated
                ? `API error 404 from ${method} ${path}: ${errorField}. This deployment answers ` +
                  `unauthenticated requests with a constant not-found response, so check the ` +
                  `caller credentials before assuming the route or resource is missing.`
                : `API error ${response.status} from ${method} ${path}${errorField ? `: ${errorField}` : summarizeErrorBody(errorBody)}`;
            throw new EzClassifyError(message, responseCode, responseDetail, {
                status: response.status,
                body: parsedBody,
                requestPath: path,
                ...(retryAfter === undefined ? {} : { retryAfter }),
                ...(possiblyUnauthenticated
                    ? { possiblyUnauthenticated: true as const }
                    : {}),
            });
        }

        this._hasConnected = true;
        // Optional on purpose. `fetchImpl` is a caller-supplied seam, and
        // a host that hands over a minimal response object should not have
        // every request throw on a header this client only reads to notice
        // a moved alias.
        this._noteResolvedVersion(
            response.headers?.get(RESOLVED_VERSION_HEADER) ?? null,
        );

        const text = await budget.run('the response body', () =>
            response.text(),
        );
        if (!text) {
            throw new EzClassifyError(
                `Empty response body from ${method} ${path}`,
                ErrorCodes.MALFORMED_RESPONSE,
            );
        }
        // Every operation the contract declares answers JSON, so a body
        // that does not parse is a server fault and must not be handed
        // back, or cached, as if it were the answer.
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new EzClassifyError(
                `Malformed response from ${method} ${path}: the body is not JSON`,
                ErrorCodes.MALFORMED_RESPONSE,
            );
        }
        // Checked here, before any caller can file the body: a 200 that
        // lacks a member the contract requires is a failure, and a cache
        // entry settles on whatever its call resolves with.
        assertResponseShape(method, path, parsed);
        return parsed as T;
    }
}
