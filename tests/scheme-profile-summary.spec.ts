/**
 * What the scheme summary contributes to the profile a context-bound client
 * holds, and so to the metadata view read off it.
 *
 * The wire summary carries the scheme's own definition and guidance, and omits
 * `roleAware` for a scheme that never set it. The engine's view of the same
 * scheme reports both text members and an explicit boolean, so a client that
 * dropped the text or passed the omission through would answer differently from
 * the engine on identical input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ctxSchemeResourceBody, mockResponse, stubFetch } from './fetch-mock';

const DESCRIPTION = {
    id: 'records',
    version: '1.0.0',
    scheme: { id: 'levels', version: '1.0.0', resolvedVersion: '1.0.0' },
    schemes: [
        {
            selector: 'levels',
            id: 'levels',
            version: '1.0.0',
            roles: ['primary'],
        },
    ],
};

describe('scheme summary in the profile', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    /** Answer a connect with the given members added to the summary. */
    async function connectWith(summary: Record<string, unknown>) {
        fetchMock.mockImplementation((url: string) => {
            const resource = ctxSchemeResourceBody(url, 'levels');
            const payload = url.endsWith('/scheme')
                ? { ...(resource as object), ...summary }
                : (resource ??
                  (url.includes('/v1/ctx/') ? DESCRIPTION : { status: 'ok' }));
            return Promise.resolve(mockResponse(200, JSON.stringify(payload)));
        });
        return EzClassifyClient.connect('https://api.example.com', {
            contextId: 'records',
            contextVersion: '1.0.0',
            heartbeat: false,
        });
    }

    it('carries the definition and guidance into the profile and the metadata view', async () => {
        const client = await connectWith({
            definition: 'Three handling levels.',
            guidance: 'Mark every page.',
        });
        try {
            expect(client.getScheme().definition).toBe(
                'Three handling levels.',
            );
            expect(client.getScheme().guidance).toBe('Mark every page.');
            expect(client.getSchemeMeta()).toMatchObject({
                definition: 'Three handling levels.',
                guidance: 'Mark every page.',
            });
        } finally {
            client.destroy();
        }
    });

    it("carries the scheme document's own whole marking, and leaves it out when there is none", async () => {
        const marked = await connectWith({ marking: 'HIGH' });
        try {
            expect(marked.getScheme().marking).toBe('HIGH');
            expect(marked.getSchemeMeta().marking).toBe('HIGH');
        } finally {
            marked.destroy();
        }

        const plain = await connectWith({});
        try {
            expect(plain.getScheme().marking).toBeUndefined();
            expect(plain.getSchemeMeta().marking).toBeUndefined();
        } finally {
            plain.destroy();
        }
    });

    it('reads an omitted roleAware as false and keeps an explicit true', async () => {
        const unset = await connectWith({});
        try {
            expect(unset.getScheme().roleAware).toBe(false);
            expect(unset.getSchemeMeta().roleAware).toBe(false);
        } finally {
            unset.destroy();
        }

        const aware = await connectWith({ roleAware: true });
        try {
            expect(aware.getScheme().roleAware).toBe(true);
            expect(aware.getSchemeMeta().roleAware).toBe(true);
        } finally {
            aware.destroy();
        }
    });
});
