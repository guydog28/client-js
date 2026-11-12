/**
 * A 200 that lacks a member the contract requires is a failed call, at any
 * depth, and is never filed in the response cache.
 *
 * The shared plans remove one member per operation. These remove members from
 * the envelope, from inside the result, and from inside a list element, on
 * routes that answer under the Context envelope and on the one that does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ErrorCodes, EzClassifyError } from '../src/errors';
import { loadWireCorpus } from './wire-corpus';
import { PLAN_BASE_URL, PlanTransport } from './cache-plan-transport';

const corpus = loadWireCorpus();

interface Case {
    name: string;
    caseId: string;
    remove: string;
    call: (client: EzClassifyClient) => Promise<unknown>;
}

const CASES: Case[] = [
    {
        name: 'a member of the envelope',
        caseId: 'ctx-scheme-process.ok',
        remove: '/resolution/resolvedVersion',
        call: (client) => client.scheme.process('OPEN'),
    },
    {
        name: 'a member of the result',
        caseId: 'ctx-scheme-validate.ok',
        remove: '/result/valid',
        call: (client) => client.scheme.validate('OPEN'),
    },
    {
        name: 'a member inside a list element of the result',
        caseId: 'ctx-scheme-process.ok',
        remove: '/result/assertions/0/conceptId',
        call: (client) => client.scheme.process('OPEN'),
    },
    {
        name: 'a nested member of a described rule',
        caseId: 'ctx-access-rules.ok',
        remove: '/rules/0/rule/ruleId',
        call: (client) => client.access.describeAllAccessRules(),
    },
    {
        name: 'a member of a scan outcome',
        caseId: 'ctx-scheme-scan.ok',
        remove: '/result/limits',
        call: (client) => client.scheme.scan('OPEN document for review'),
    },
    {
        name: 'a member of a concept description',
        caseId: 'ctx-scheme-describe-concept.ok',
        remove: '/result/lines',
        call: (client) => client.scheme.describeConcept('OPEN', 'level'),
    },
];

describe('a malformed success is never cached', () => {
    let transport: PlanTransport;
    let client: EzClassifyClient;

    beforeEach(() => {
        transport = new PlanTransport(corpus, 'denial.context-without-carrier');
        client = new EzClassifyClient(PLAN_BASE_URL, {
            contextId: 'ez-full',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
            fetchImpl: transport.fetch,
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        client.destroy();
        vi.restoreAllMocks();
    });

    it.each(CASES)(
        'when $name is missing',
        async ({ caseId, remove, call }) => {
            transport.scriptMalformed(caseId, [remove]);

            const failure = await call(client).then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(EzClassifyError);
            expect((failure as EzClassifyError).code).toBe(
                ErrorCodes.MALFORMED_RESPONSE,
            );
            expect((failure as EzClassifyError).message).toContain(remove);

            // The next call retries, and its answer is the one that is kept.
            await call(client);
            await call(client);
            expect(transport.countFor(caseId)).toBe(2);
        },
    );
});

describe('a 200 whose body is not a JSON answer is never kept', () => {
    // Every operation the contract declares answers JSON, so these bodies are
    // server faults. The profile warm is where one would otherwise land: its
    // legs are not Context envelopes and still require response validation.
    // Each body is served once,
    // in place of the concepts recording; the next warm must ask again.
    it.each([
        ['an empty body', ''],
        ['a body that is not JSON', '<html>gateway</html>'],
    ])('when the server answers %s', async (_name, served) => {
        const transport = new PlanTransport(
            corpus,
            'denial.context-without-carrier',
        );
        let replaced = false;
        const fetchImpl: typeof fetch = async (input, init) => {
            const response = await transport.fetch(input, init);
            if (replaced || !String(input).endsWith('/scheme/concepts')) {
                return response;
            }
            replaced = true;
            return new Response(served, {
                status: 200,
                headers: response.headers,
            });
        };
        const client = new EzClassifyClient(PLAN_BASE_URL, {
            contextId: 'ez-presets',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
            fetchImpl,
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const failure = await client.scheme.fetchProfile().then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(EzClassifyError);
            expect((failure as EzClassifyError).code).toBe(
                ErrorCodes.MALFORMED_RESPONSE,
            );
            expect(() => client.scheme.getScheme()).toThrow(EzClassifyError);

            const profile = await client.scheme.fetchProfile();
            expect(Array.isArray(profile.concepts)).toBe(true);
            expect(transport.countFor('ctx-scheme-concepts.ok')).toBe(2);
        } finally {
            client.destroy();
            vi.restoreAllMocks();
        }
    });
});
