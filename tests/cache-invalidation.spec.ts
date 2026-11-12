/**
 * When the response cache has to let go of what it holds, beyond the plans in
 * the shared contract: a composition that moves while the profile rebuild is
 * slow, fails, or has nothing to rebuild.
 *
 * The contract's plan for a composition change waits for the rebuild to finish
 * and then looks. That proves the cache is clear afterwards. These prove it is
 * clear at once and does not depend on the rebuild, which is what the contract
 * says: the clearing neither waits for the rebuild nor depends on its success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { connectContext } from '../src/connect';
import { loadWireCorpus } from './wire-corpus';
import { PLAN_BASE_URL, PlanTransport } from './cache-plan-transport';

const corpus = loadWireCorpus();
const DENIAL = 'denial.context-without-carrier';
const PROCESS = 'ctx-scheme-process.ok';
const DESCRIBE = 'ctx-describe.ok';

function options(transport: PlanTransport) {
    return {
        contextId: 'ez-full',
        contextToken: 'conformance-context-carrier',
        contextVersion: 'latest',
        fetchImpl: transport.fetch,
    };
}

describe('a moved resolved version clears the response cache', () => {
    let transport: PlanTransport;

    beforeEach(() => {
        transport = new PlanTransport(corpus, DENIAL);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('before the profile rebuild has finished', async () => {
        const client = await connectContext({
            baseUrl: PLAN_BASE_URL,
            ...options(transport),
        });
        transport.mark();
        try {
            await client.scheme.process('OPEN');
            transport.moveResolvedVersion('1.0.1');
            // Hold the rebuild's first request so it cannot finish.
            transport.gate(DESCRIBE);
            await client.scheme.suggest('');
            await transport.untilHeld(DESCRIBE);

            await client.scheme.process('OPEN');
            expect(transport.countFor(PROCESS)).toBe(2);

            transport.release(DESCRIBE);
            await client._settleProfileRewarm();
        } finally {
            client.destroy();
        }
    });

    it('when the profile rebuild fails', async () => {
        const client = await connectContext({
            baseUrl: PLAN_BASE_URL,
            ...options(transport),
        });
        transport.mark();
        try {
            await client.scheme.process('OPEN');
            transport.moveResolvedVersion('1.0.1');
            // A description with no version is refused, so the rebuild fails.
            transport.scriptMalformed(DESCRIBE, ['/version']);
            await client.scheme.suggest('');
            await client._settleProfileRewarm();

            await client.scheme.process('OPEN');
            expect(transport.countFor(PROCESS)).toBe(2);
        } finally {
            client.destroy();
        }
    });

    it('on a client that never built a profile', async () => {
        const client = new EzClassifyClient(PLAN_BASE_URL, options(transport));
        try {
            await client.scheme.process('OPEN');
            transport.moveResolvedVersion('1.0.1');
            await client.scheme.suggest('');

            await client.scheme.process('OPEN');
            expect(transport.countFor(PROCESS)).toBe(2);
        } finally {
            client.destroy();
        }
    });

    it('leaves a pinned client alone, whatever a response names', async () => {
        const client = new EzClassifyClient(PLAN_BASE_URL, {
            ...options(transport),
            contextVersion: '1.0.0',
        });
        try {
            await client.scheme.process('OPEN');
            transport.moveResolvedVersion('1.0.1');
            await client.scheme.suggest('');
            await client.scheme.process('OPEN');
            expect(transport.countFor(PROCESS)).toBe(1);
        } finally {
            client.destroy();
        }
    });

    it('files later answers at the new version and serves repeats from them', async () => {
        const client = new EzClassifyClient(PLAN_BASE_URL, options(transport));
        try {
            await client.scheme.process('OPEN');
            transport.moveResolvedVersion('1.0.1');
            await client.scheme.suggest('');
            // Answered at 1.0.1 and filed after the clear: a repeat is free.
            await client.scheme.process('OPEN');
            await client.scheme.process('OPEN');
            expect(transport.countFor(PROCESS)).toBe(2);
        } finally {
            client.destroy();
        }
    });
});
