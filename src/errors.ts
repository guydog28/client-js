/**
 * String constants for error codes the client raises on its own.
 *
 * A non-2xx response keeps whatever `code` the server put in the body; when the
 * body carries none, the code falls back to {@link ErrorCodes.HTTP} and the
 * numeric `status` is the discriminant. `INVALID_INPUT` is reserved for genuine
 * input and usage validation, so neither a transport failure nor a server
 * answer the contract does not allow ever wears it.
 */
export const ErrorCodes = {
    /** A bad argument or a missing prerequisite on the caller's side. */
    INVALID_INPUT: 'INVALID_INPUT',
    /**
     * A 2xx response the contract does not allow: an empty or non-JSON body, or
     * one missing a member the contract requires. It is never cached.
     */
    MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
    /** The request never completed: connection refused, DNS failure, CORS block. */
    NETWORK: 'NETWORK',
    /** The client's own per-request deadline elapsed before the response. */
    TIMEOUT: 'TIMEOUT',
    /** A caller-supplied `AbortSignal` canceled the request. */
    ABORTED: 'ABORTED',
    /** A non-2xx response whose body carried no code of its own. */
    HTTP: 'HTTP',
} as const;

/** Stable machine-readable error code returned by the client or server. */
export type ErrorCode = string;

/**
 * The response body a deployment running authentication returns for every
 * unauthenticated request. Authentication runs before routing, so the runtime
 * cannot say more than this without leaking which routes exist.
 */
const DENIAL_BODY_FIELD = 'error';
const DENIAL_BODY_VALUE = 'not_found';

/**
 * Whether a parsed response body is exactly the constant denial shape.
 *
 * A deployment with authentication enabled answers every unauthenticated
 * request with a 404 carrying this body, so a 404 is not proof that a route or
 * a resource is absent. The match is exact: a genuine not-found response that
 * names the missing thing carries extra fields and is not a denial.
 *
 * @param body - Parsed response body, or the raw text when it was not JSON
 * @returns True when the body is the constant denial shape
 */
export function isDenialShapedBody(body: unknown): boolean {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return false;
    }
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    return (
        keys.length === 1 &&
        keys[0] === DENIAL_BODY_FIELD &&
        record[DENIAL_BODY_FIELD] === DENIAL_BODY_VALUE
    );
}

/** Base error class for all client failures. */
export class EzClassifyError extends Error {
    /** Machine-readable error code. */
    public readonly code?: ErrorCode;
    /**
     * HTTP status when the error originated from a non-2xx server response.
     * Absent for errors raised before/after the wire call (input validation,
     * cache lookups, etc).
     */
    public readonly status?: number;
    /**
     * Parsed response body when the error originated from a non-2xx server
     * response. JSON-decoded when possible, otherwise the raw text.
     */
    public readonly body?: unknown;
    /**
     * The resolved request path (after Context-prefix rewriting) when the error
     * originated from a non-2xx server response. This is the exact `pathname`
     * the runtime saw, which is what its catch-all 404 body echoes back, the
     * fingerprint a caller needs to tell a genuinely missing route apart from
     * any other 404.
     */
    public readonly requestPath?: string;
    /**
     * Set when the failure was a 404 carrying the constant denial shape while
     * the client had a caller credential configured. The route may be fine and
     * the credential may be stale: check the credential before treating this as
     * a missing route or resource.
     */
    public readonly possiblyUnauthenticated?: true;
    /**
     * Seconds the server asked the caller to wait, set on a 429 response. It
     * comes from the `Retry-After` header when that carries a number of
     * seconds, and from the body's `retryAfter` otherwise. Absent when the
     * server named no delay, and on every other failure.
     */
    public readonly retryAfter?: number;

    constructor(
        message: string,
        code?: ErrorCode,
        public detail?: string,
        opts?: {
            status?: number;
            body?: unknown;
            possiblyUnauthenticated?: true;
            requestPath?: string;
            retryAfter?: number;
        },
    ) {
        super(message);
        this.name = 'EzClassifyError';
        this.code = code;
        if (opts) {
            this.status = opts.status;
            this.body = opts.body;
            this.possiblyUnauthenticated = opts.possiblyUnauthenticated;
            this.requestPath = opts.requestPath;
            this.retryAfter = opts.retryAfter;
        }
    }
}
