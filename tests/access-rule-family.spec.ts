/**
 * The access family on a context-bound client: rule descriptions, the ids
 * derived from them, and the requirements description in its bare form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

function ruleDescription(ruleId: string) {
    return {
        rule: {
            artifact: {
                id: 'records-access',
                kind: 'access',
                version: '1.0.0',
            },
            ruleId,
            ruleDigest: `sha256-${ruleId}`,
        },
        access: { id: 'records-access', kind: 'access', version: '1.0.0' },
        scheme: { id: 'levels', kind: 'scheme', version: '2.0.0' },
        name: `Rule ${ruleId}`,
        requirementText: 'clearance >= LEVEL-HIGH',
        attributesNeeded: ['clearance'],
        dependsOn: [],
        overrides: [],
        lines: [`Rule ${ruleId}`],
    };
}

function envelope(result: unknown) {
    return {
        resolution: {
            contextId: 'records',
            resolvedVersion: '1.2.3',
            artifacts: [],
            sources: [],
        },
        result,
        operationLimitations: [],
    };
}

describe('AccessOps rule family', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function ctxClient(options?: { disableCache?: boolean }) {
        return new EzClassifyClient('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.2.3',
            disableCache: options?.disableCache ?? false,
        });
    }

    it('describes every rule from the context rule list', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({
                    rules: [ruleDescription('r1'), ruleDescription('r2')],
                }),
            ),
        );

        const rules = await ctxClient().access.describeAllAccessRules();

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/access/rules',
        );
        expect(fetchMock.mock.calls[0][1].method).toBe('GET');
        expect(rules.map((r) => r.rule.ruleId)).toEqual(['r1', 'r2']);
    });

    it('reads the rule ids off the response the descriptions already fetched', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({
                    rules: [ruleDescription('r1'), ruleDescription('r2')],
                }),
            ),
        );
        const c = ctxClient();

        await c.access.describeAllAccessRules();
        const ids = await c.access.listAccessRuleIds();

        expect(ids).toEqual(['r1', 'r2']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports the policy marking off the response the rules already fetched', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({
                    marking: 'OPEN',
                    rules: [ruleDescription('r1')],
                }),
            ),
        );
        const c = ctxClient();

        const rules = await c.access.describeAllAccessRules();
        const marking = await c.access.describeAccessMarking();

        expect(rules.map((r) => r.rule.ruleId)).toEqual(['r1']);
        expect(marking).toBe('OPEN');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports no marking for a policy that declares none', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify({ rules: [ruleDescription('r1')] }),
            ),
        );

        await expect(
            ctxClient().access.describeAccessMarking(),
        ).resolves.toBeUndefined();
    });

    it('rejects a rule list with no rules array', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify({ items: [] })),
        );

        await expect(ctxClient().access.listAccessRuleIds()).rejects.toThrow(
            /Malformed response from GET access\/rules: \/rules/,
        );
    });

    it('describes one rule through the context envelope', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(ruleDescription('r1')))),
        );

        const rule = await ctxClient().access.describeAccessRule('r1');

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/access/describe-rule',
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            ruleId: 'r1',
        });
        expect(rule.name).toBe('Rule r1');
    });

    it('answers requirements without the envelope its context sibling keeps', async () => {
        const description = corpusResult('ctx-access-describe-requirements.ok');
        fetchMock.mockResolvedValue(
            mockResponse(200, JSON.stringify(envelope(description))),
        );
        const c = ctxClient({ disableCache: true });

        const bare = await c.access.describeAccessRequirements({
            marking: 'LEVEL-HIGH',
        });
        const enveloped = await c.context.accessRequirements({
            marking: 'LEVEL-HIGH',
        });

        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://api.example.com/v1/ctx/records/1.2.3/access/describe-requirements',
        );
        expect(bare).toEqual(description);
        expect(enveloped.result).toEqual(description);
        expect(enveloped.resolution.resolvedVersion).toBe('1.2.3');
    });

    it('refuses the rule family on a client bound to no context', async () => {
        const flat = new EzClassifyClient('https://api.example.com', {
            heartbeat: false,
        });

        await expect(flat.access.describeAllAccessRules()).rejects.toThrow(
            /requires a context-bound client/,
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('schemeId', () => {
        it('reports the base of the layer stack on a context-bound client', async () => {
            // The Context resolves the scheme server-side, and its
            // decomposition is what reports the id: same plain string on both
            // client shapes, which is what the base contract types it as.
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify({
                        id: 'records',
                        version: '1.2.3',
                        scheme: {
                            id: 'levels',
                            version: '2.0.0',
                            resolvedVersion: '2.0.0',
                        },
                        schemes: [
                            {
                                selector: 'levels',
                                id: 'levels',
                                version: '2.0.0',
                                roles: ['primary'],
                            },
                        ],
                    }),
                ),
            );
            const c = ctxClient();

            await c.describeContext();

            expect(c.access.schemeId).toBe('levels');
        });

        it('says so rather than inventing one before any composition resolves', () => {
            // Built but never connected: the same state getScheme() refuses in.
            expect(() => ctxClient().access.schemeId).toThrow(
                /access\.schemeId is unknown: this client has resolved no composition/,
            );
        });
    });
});
