import { expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';

it('reads renewed Context tokens per decision without reconstructing the client', async () => {
    let token = 'first-signed-token';
    const headers: Record<string, string>[] = [];
    const fetch = vi.fn(async (_url, init) => {
        headers.push(init.headers);
        return new Response(
            JSON.stringify({
                result: { granted: false, rules: [], warnings: [] },
                resolution: {
                    contextId: 'example',
                    requestedVersion: '1.0.0',
                    resolvedVersion: '1.0.0',
                    artifacts: [],
                },
            }),
        );
    });
    const client = new EzClassifyClient('https://runtime.test', {
        contextId: 'example',
        contextVersion: '1.0.0',
        contextToken: async () => token,
        fetchImpl: fetch,
    });
    try {
        await client.context.checkAccess('CONFIDENTIAL', {});
        token = 'renewed-signed-token';
        await client.context.checkAccess('CONFIDENTIAL', {});
        expect(
            headers.map((value) => value['X-EzClassify-Context-Token']),
        ).toEqual(['first-signed-token', 'renewed-signed-token']);
    } finally {
        client.destroy();
    }
});

it.each(['', '   '])(
    'refuses an empty renewed token before sending a Context request',
    async (token) => {
        const fetch = vi.fn();
        const client = new EzClassifyClient('https://runtime.test', {
            contextId: 'example',
            contextVersion: '1.0.0',
            contextToken: () => token,
            fetchImpl: fetch,
        });
        try {
            await expect(
                client.context.checkAccess('CONFIDENTIAL', {}),
            ).rejects.toThrow('non-empty signed token');
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            client.destroy();
        }
    },
);

it('keeps Context-token suppliers off health probes', async () => {
    const contextToken = vi.fn(() => {
        throw new Error('credential unavailable');
    });
    const fetch = vi.fn(
        async () => new Response(JSON.stringify({ status: 'ok' })),
    );
    const client = new EzClassifyClient('https://runtime.test', {
        contextId: 'example',
        contextVersion: '1.0.0',
        contextToken,
        fetchImpl: fetch,
    });
    try {
        await client.ping();
        expect(contextToken).not.toHaveBeenCalled();
    } finally {
        client.destroy();
    }
});

it('bounds a stalled Context renewal by the request timeout', async () => {
    const fetchImpl = vi.fn();
    const client = new EzClassifyClient('https://runtime.test', {
        contextId: 'example',
        contextVersion: '1.0.0',
        contextToken: () => new Promise<string>(() => {}),
        timeout: 10,
        fetchImpl,
    });
    try {
        await expect(
            client.context.checkAccess('CONFIDENTIAL', {}),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
        client.destroy();
    }
});

it('cancels a stalled Context renewal without sending a request', async () => {
    const fetchImpl = vi.fn();
    const signal = new AbortController();
    const client = new EzClassifyClient('https://runtime.test', {
        contextId: 'example',
        contextVersion: '1.0.0',
        contextToken: () => new Promise<string>(() => {}),
        fetchImpl,
    });
    try {
        const request = client._request(
            'POST',
            '/v1/ctx/example/1.0.0/access/check',
            {},
            signal.signal,
        );
        signal.abort();
        await expect(request).rejects.toMatchObject({ code: 'ABORTED' });
        expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
        client.destroy();
    }
});
