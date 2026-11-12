import { afterEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';

const clients: EzClassifyClient[] = [];
afterEach(() => {
    clients.forEach((client) => client.destroy());
    clients.length = 0;
    vi.unstubAllGlobals();
});

function deployment(body: unknown) {
    const fetch = vi.fn().mockImplementation(
        async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new EzClassifyClient('https://api.example.test', {});
    clients.push(client);
    return { client, fetch };
}

describe('Context discovery', () => {
    it('preserves server order and sends no query string', async () => {
        const { client, fetch } = deployment({
            contexts: ['second', 2, 'first', null],
        });
        expect(await client.listContexts()).toEqual(['second', 'first']);
        expect(String(fetch.mock.calls[0][0])).toBe(
            'https://api.example.test/v1/ctx',
        );
    });
    // The route declares no parameters and refuses any it is sent with a 400,
    // so a stray argument from an untyped caller must not reach the wire.
    it('declares no parameter and sends none an untyped caller supplies', async () => {
        const { client, fetch } = deployment({ contexts: [] });
        expect(client.listContexts.length).toBe(0);
        await (client.listContexts as (org: string) => Promise<string[]>)(
            'org-one',
        );
        expect(String(fetch.mock.calls[0][0])).toBe(
            'https://api.example.test/v1/ctx',
        );
    });
    it('encodes a Context id as one path segment and ignores non-string versions', async () => {
        const { client, fetch } = deployment({
            versions: ['2.0.0', {}, '1.0.0', false],
        });
        expect(
            await client.listContextVersions('records/one?all=true'),
        ).toEqual(['2.0.0', '1.0.0']);
        expect(String(fetch.mock.calls[0][0])).toBe(
            'https://api.example.test/v1/ctx/records%2Fone%3Fall%3Dtrue',
        );
    });
    it.each([
        {},
        { contexts: null, versions: null },
        { contexts: 'invalid', versions: {} },
    ])(
        'treats absent or non-list response fields as an empty discovery: %j',
        async (body) => {
            const { client } = deployment(body);
            expect(await client.listContexts()).toEqual([]);
            expect(await client.listContextVersions('records')).toEqual([]);
        },
    );
});
