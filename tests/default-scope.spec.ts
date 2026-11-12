/**
 * Which scope a scheme defaults to, as a Context-bound client learns it.
 *
 * The contract names the default scope once, in the scheme summary's
 * `defaultScope`, and on no scope in the scopes list. This replays what the
 * runtime answered when a client warmed the Cedar Valley scheme, so the profile
 * and the metadata are checked against the server's own answer rather than a
 * fixture written beside the code.
 */

import { describe, it, expect } from 'vitest';
import { readScenarioCases } from '@ezclassify/conformance-server';
import { EzClassifyClient } from '../src/ezclassify-client';
import type { WireCase } from './wire-corpus';
import { ReplayTransport, REPLAY_BASE_URL } from './wire-replay-transport';

const scenario = {
    byId: new Map<string, WireCase>(
        readScenarioCases('cedar-valley').map((entry) => [entry.id, entry]),
    ),
};

/** The description and the six scheme resources a profile warm reads. */
const WARM = [
    'context.describe',
    'profile.summary',
    'profile.concepts',
    'profile.categories',
    'profile.formats',
    'profile.scopes',
    'profile.label-presets',
];

function recordedBody(caseId: string): unknown {
    const entry = scenario.byId.get(caseId);
    if (!entry) throw new Error(`the scenario records no case ${caseId}`);
    return entry.response.body;
}

describe('the default scope of a Context-bound scheme', () => {
    it('comes from the summary, and each scope carries its id and label only', async () => {
        const summary = recordedBody('profile.summary') as {
            defaultScope?: string;
        };
        const scopes = recordedBody('profile.scopes');
        // A recording without both would make the assertions below vacuous.
        expect(summary.defaultScope).toEqual(expect.any(String));
        expect(scopes).toEqual(expect.arrayContaining([expect.anything()]));

        const transport = new ReplayTransport(scenario, WARM);
        const c = new EzClassifyClient(REPLAY_BASE_URL, {
            contextId: 'cedar-valley',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
            fetchImpl: transport.fetch,
        });
        try {
            const profile = await c.scheme.fetchProfile();
            const meta = c.scheme.getSchemeMeta();
            expect(profile.defaultScope).toBe(summary.defaultScope);
            expect(meta.defaultScope).toBe(summary.defaultScope);
            // Strict, so a member the contract does not declare on a scope
            // fails here even when it is undefined.
            expect(profile.scopes).toStrictEqual(scopes);
            expect(meta.scopes).toStrictEqual(scopes);
        } finally {
            c.destroy();
        }
        transport.assertEveryCaseEmitted();
    });
});
