import type { ContextOperationResult } from '@ezclassify/types';
import { ErrorCodes, EzClassifyError } from './errors';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidEnvelope(reason: string): never {
    throw new EzClassifyError(
        `Invalid Context operation response: ${reason}`,
        ErrorCodes.MALFORMED_RESPONSE,
    );
}

const RESPONSE_COUNT_FIELDS = [
    'nominations',
    'evidenceSpans',
    'guideUnits',
] as const;

function hasResponseCounts(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return RESPONSE_COUNT_FIELDS.every(
        (field) =>
            Number.isInteger(value[field]) && (value[field] as number) >= 0,
    );
}

/** How a route's result may legitimately look, beyond being present. */
export interface ContextResultShape {
    /**
     * Whether `{}` is a real answer. Most results are records whose members the
     * contract requires, so an empty object is a malformed body and is refused
     * before anything can cache it. A result that is a map keyed by ids the
     * caller named is empty exactly when the caller named none, and the route
     * that sends one checks its keys itself.
     */
    emptyResult?: 'refused' | 'allowed';
}

/**
 * Validate a remote Context envelope without rewriting its projected result.
 *
 * @remarks
 * The caller validates the operation-specific result payload.
 * @param value - Decoded JSON response from a Context operation.
 * @param projection - Whether this route requires or forbids response
 *   projection metadata.
 * @param shape - Whether the route permits an empty result map.
 * @returns The original envelope after structural validation.
 * @throws {EzClassifyError} If required envelope fields or projection metadata
 *   are malformed.
 */
export function parseContextOperationResult<T>(
    value: unknown,
    projection: 'required' | 'forbidden',
    shape: ContextResultShape = {},
): ContextOperationResult<T> {
    if (!isRecord(value)) invalidEnvelope('expected an object');
    const resolution = value.resolution;
    if (!isRecord(resolution)) invalidEnvelope('resolution must be an object');
    if (
        typeof resolution.contextId !== 'string' ||
        typeof resolution.resolvedVersion !== 'string' ||
        !Array.isArray(resolution.artifacts)
    ) {
        invalidEnvelope('resolution is incomplete');
    }
    if (!Object.hasOwn(value, 'result') || value.result == null) {
        invalidEnvelope('result is required and cannot be null');
    }
    if (
        shape.emptyResult !== 'allowed' &&
        isRecord(value.result) &&
        Object.keys(value.result).length === 0
    ) {
        invalidEnvelope('result must not be an empty object');
    }
    const hasProjection = Object.hasOwn(value, 'responseProjection');
    if (projection === 'required' && !hasProjection) {
        invalidEnvelope('responseProjection is required');
    }
    if (projection === 'forbidden' && hasProjection) {
        invalidEnvelope('responseProjection is not allowed');
    }
    if (hasProjection) {
        const projection = value.responseProjection;
        if (!isRecord(projection)) {
            invalidEnvelope('responseProjection must be an object');
        }
        if (
            (projection.profile !== 'summary' &&
                projection.profile !== 'standard' &&
                projection.profile !== 'full') ||
            typeof projection.detailsComplete !== 'boolean' ||
            !Array.isArray(projection.omittedFields) ||
            !projection.omittedFields.every(
                (field) => typeof field === 'string',
            ) ||
            !hasResponseCounts(projection.counts)
        ) {
            invalidEnvelope('responseProjection is invalid');
        }
    }
    return value as unknown as ContextOperationResult<T>;
}
