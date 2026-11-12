/**
 * Facts handed in as the marking, together with the facts already chosen.
 *
 * A composer calls `process(facts, { assertions: chosen })`, and the engine
 * settles both lists as one marking. The wire has one `assertions` list, so the
 * client has to send both in it. These tests replay what the runtime answered
 * for that list in the Cedar Valley integration scenario. A client that sends
 * the marking's facts alone puts a request on the wire the runtime never
 * answered, and the transport refuses it.
 */

import { describe, it, expect } from 'vitest';
import type { Assertion } from '@ezclassify/types';
import { readScenarioCases } from '@ezclassify/conformance-server';
import { EzClassifyClient } from '../src/ezclassify-client';
import type { WireCase } from './wire-corpus';
import { ReplayTransport, REPLAY_BASE_URL } from './wire-replay-transport';

const scenario = {
    byId: new Map<string, WireCase>(
        readScenarioCases('cedar-valley').map((entry) => [entry.id, entry]),
    ),
};

/** Every fact a Cedar Valley author picked for a complex marking, no text. */
const COMPLEX = 'process.authored-complex';
/** The level of that marking alone. */
const LEVEL_ONLY = 'process.authored-confidential';

function recorded(caseId: string): WireCase {
    const entry = scenario.byId.get(caseId);
    if (!entry) throw new Error(`the scenario records no case ${caseId}`);
    return entry;
}

function recordedFacts(caseId: string): Assertion[] {
    return (recorded(caseId).request.body as { assertions: Assertion[] })
        .assertions;
}

function recordedResult(caseId: string): unknown {
    return (recorded(caseId).response.body as { result: unknown }).result;
}

/** A client pinned to the scenario's Context, so its cache is on. */
function client(fetchImpl: typeof fetch): EzClassifyClient {
    return new EzClassifyClient(REPLAY_BASE_URL, {
        contextId: 'cedar-valley',
        contextToken: 'conformance-context-carrier',
        contextVersion: '1.0.0',
        fetchImpl,
    });
}

const facts = recordedFacts(COMPLEX);
/** The level and the sensitive content, handed in as the marking. */
const marking = facts.slice(0, 3);
/** The schools, the recipient and the handling, chosen elsewhere. */
const chosen = facts.slice(3);

describe('process with facts and the facts already chosen', () => {
    it('sends both lists and gets what the runtime answered for both', async () => {
        const transport = new ReplayTransport(scenario, [COMPLEX]);
        const c = client(transport.fetch);
        try {
            const answer = await c.scheme.process(marking, {
                assertions: chosen,
                outputFormat: 'long',
            });
            expect(answer).toEqual(recordedResult(COMPLEX));
        } finally {
            c.destroy();
        }
        transport.assertEveryCaseEmitted();
    });

    it('sends a fact both lists state once, as the marking states it', async () => {
        const restated: Assertion = { ...marking[0], source: 'user' };
        const transport = new ReplayTransport(scenario, [COMPLEX]);
        const c = client(transport.fetch);
        try {
            const answer = await c.scheme.process(marking, {
                assertions: [restated, ...chosen],
                outputFormat: 'long',
            });
            expect(answer).toEqual(recordedResult(COMPLEX));
        } finally {
            c.destroy();
        }
        transport.assertEveryCaseEmitted();
    });

    it('caches the marking alone and the marking with chosen facts apart', async () => {
        const level = recordedFacts(LEVEL_ONLY);
        expect(level).toEqual(facts.slice(0, 1));
        const transport = new ReplayTransport(scenario, [LEVEL_ONLY, COMPLEX], {
            repeatable: true,
        });
        const c = client(transport.fetch);
        try {
            const alone = await c.scheme.process(level, {
                outputFormat: 'long',
            });
            const withChosen = await c.scheme.process(level, {
                assertions: facts.slice(1),
                outputFormat: 'long',
            });
            expect(alone).toEqual(recordedResult(LEVEL_ONLY));
            expect(withChosen).toEqual(recordedResult(COMPLEX));

            // Each request asked again is answered from the cache.
            await c.scheme.process(level, { outputFormat: 'long' });
            await c.scheme.process(level, {
                assertions: facts.slice(1),
                outputFormat: 'long',
            });
        } finally {
            c.destroy();
        }
        expect(transport.countFor(LEVEL_ONLY)).toBe(1);
        expect(transport.countFor(COMPLEX)).toBe(1);
    });
});
