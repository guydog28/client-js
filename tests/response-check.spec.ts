/**
 * The presence checks a Context operation response goes through before any
 * caller, or the response cache, can hold it.
 */

import { describe, expect, it } from 'vitest';
import {
    assertResponseShape,
    findShapeViolation,
    type ResponseShape,
} from '../src/response-check';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import { loadWireCorpus } from './wire-corpus';

const corpus = loadWireCorpus();

describe('findShapeViolation', () => {
    const shape: ResponseShape = {
        kind: 'object',
        required: ['id', 'items'],
        properties: {
            items: {
                kind: 'array',
                items: {
                    kind: 'object',
                    required: ['name'],
                    properties: { tags: { kind: 'array', items: 'Tag' } },
                },
            },
            pinned: { kind: 'object', required: ['at'], nullable: true },
        },
    };

    it('accepts a value that carries every required member', () => {
        expect(
            findShapeViolation({ id: 'a', items: [{ name: 'n' }] }, shape),
        ).toBeUndefined();
    });

    it('names a required member missing at the top', () => {
        expect(findShapeViolation({ items: [] }, shape)).toBe('/id');
    });

    it('names a required member missing inside an array element', () => {
        expect(
            findShapeViolation({ id: 'a', items: [{ name: 'n' }, {}] }, shape),
        ).toBe('/items/1/name');
    });

    it('treats a null in a required member as missing unless null is allowed', () => {
        expect(findShapeViolation({ id: null, items: [] }, shape)).toBe('/id');
        expect(
            findShapeViolation({ id: 'a', items: [], pinned: null }, shape),
        ).toBeUndefined();
    });

    it('treats a null in an optional member as absent', () => {
        expect(
            findShapeViolation({ id: 'a', items: [], pinned: null }, shape),
        ).toBeUndefined();
    });

    it('refuses a value of the wrong container kind', () => {
        expect(findShapeViolation([], shape)).toBe('');
        expect(findShapeViolation({ id: 'a', items: {} }, shape)).toBe(
            '/items',
        );
    });

    it('checks the values of a map', () => {
        const map: ResponseShape = {
            kind: 'object',
            values: { kind: 'object', required: ['suggestions'] },
        };
        expect(
            findShapeViolation({ level: { suggestions: [] }, other: {} }, map),
        ).toBe('/other/suggestions');
    });
});

describe('assertResponseShape', () => {
    const complete = {
        resolution: {
            artifacts: [],
            contextId: 'c',
            resolvedVersion: '1',
        },
    };

    it('reads the route whether or not the path carries a version', () => {
        for (const path of [
            '/v1/ctx/c/1.0.0/scheme/validate',
            '/v1/ctx/c/latest/scheme/validate',
            '/v1/ctx/c/scheme/validate',
        ]) {
            expect(() => assertResponseShape('POST', path, complete)).toThrow(
                /POST scheme\/validate: \/result/,
            );
        }
    });

    it('ignores the query string', () => {
        expect(() =>
            assertResponseShape(
                'GET',
                '/v1/ctx/c/1.0.0/scheme/describe-concept?conceptId=A&categoryId=b',
                complete,
            ),
        ).toThrow(/GET scheme\/describe-concept/);
    });

    it('lets a path the contract declares no shape for through', () => {
        expect(() =>
            assertResponseShape('GET', '/v1/health', {}),
        ).not.toThrow();
        expect(() =>
            assertResponseShape('GET', '/v1/ctx/c/1.0.0', {}),
        ).not.toThrow();
        expect(() =>
            assertResponseShape(
                'POST',
                '/v1/ctx/c/1.0.0/scheme/unheard-of',
                {},
            ),
        ).not.toThrow();
    });

    it('raises the client error for an off-contract body', () => {
        try {
            assertResponseShape('POST', '/v1/ctx/c/1.0.0/scheme/validate', {});
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(EzClassifyError);
            expect((error as EzClassifyError).code).toBe(
                ErrorCodes.MALFORMED_RESPONSE,
            );
        }
    });
});

describe('the recorded responses', () => {
    /** Every recorded 200 from a Context operation route. */
    const recorded = corpus.cases.filter(
        (entry) =>
            entry.response.status === 200 &&
            entry.request.pathTemplate?.startsWith(
                '/v1/ctx/{ctxId}/{version}/',
            ),
    );

    it('are recorded for the shapes to be measured against', () => {
        expect(recorded.length).toBeGreaterThan(30);
    });

    it('all satisfy the shapes generated from the contract', () => {
        for (const entry of recorded) {
            expect(
                () =>
                    assertResponseShape(
                        entry.request.method,
                        entry.request.path,
                        entry.response.body,
                    ),
                entry.id,
            ).not.toThrow();
        }
    });

    it('each lose their validity when a member the contract requires is removed', () => {
        // Guards the shapes against being vacuous: for every recorded exchange,
        // some member of the envelope, of the result, or of the first element
        // of a list body is required, and taking it out must be noticed.
        const holders: Array<(root: unknown) => unknown> = [
            (root) => root,
            (root) => (root as Record<string, unknown>)['result'],
            (root) => (Array.isArray(root) ? root[0] : undefined),
        ];
        // An empty list has no member to take out.
        const withMembers = recorded.filter(
            (entry) =>
                !(
                    Array.isArray(entry.response.body) &&
                    entry.response.body.length === 0
                ),
        );
        for (const entry of withMembers) {
            const noticed = holders.some((holderOf) => {
                const sample = holderOf(entry.response.body);
                if (sample === null || typeof sample !== 'object') return false;
                return Object.keys(sample).some((name) => {
                    const copy = structuredClone(entry.response.body);
                    delete (holderOf(copy) as Record<string, unknown>)[name];
                    try {
                        assertResponseShape(
                            entry.request.method,
                            entry.request.path,
                            copy,
                        );
                        return false;
                    } catch {
                        return true;
                    }
                });
            });
            expect(noticed, `${entry.id} has a required member`).toBe(true);
        }
    });
});
