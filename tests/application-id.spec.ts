import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

const header = 'x-ezclassify-application-id';
const originalFetch = globalThis.fetch;
type Options = ConstructorParameters<typeof EzClassifyClient>[1];

function client(options?: Options) {
    return new EzClassifyClient('https://runtime.example', {
        disableCache: true,
        ...options,
    });
}

function sentHeaders(transport: ReturnType<typeof stubFetch>) {
    return transport.mock.lastCall![1]!.headers as Record<string, string>;
}

describe('application id', () => {
    let transport: ReturnType<typeof stubFetch>;
    beforeEach(() => {
        transport = stubFetch();
        transport.mockResolvedValue(
            mockResponse(200, JSON.stringify({ ok: true })),
        );
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('labels Context requests with the registered id beside the caller token', async () => {
        const c = client({
            applicationId: 'case-intake-portal',
            auth: { token: () => 'user-token' },
            contextToken: 'context-token',
        });
        await c._request('GET', '/v1/ctx');
        const sent = sentHeaders(transport);
        expect(sent[header]).toBe('case-intake-portal');
        expect(sent.Authorization).toBe('Bearer user-token');
        expect(sent['X-EzClassify-Context-Token']).toBe('context-token');
    });

    it('keeps the id off health and other non-Context paths', async () => {
        const c = client({ applicationId: 'case-intake-portal' });
        for (const path of ['/v1/health', '/v1/ready', '/v1/ctx-other']) {
            await c._request('GET', path);
            expect(Object.keys(sentHeaders(transport))).not.toContain(header);
        }
    });

    it('sends nothing when no id is configured', async () => {
        await client()._request('GET', '/v1/ctx');
        expect(Object.keys(sentHeaders(transport))).not.toContain(header);
    });

    it.each([
        '',
        '   ',
        ' padded',
        'padded ',
        'inner space',
        'line\nbreak',
        'tab\tid',
        'caf\u00e9',
        'a'.repeat(129),
    ])(
        'refuses the id %j outside the grammar without sending a request',
        (applicationId) => {
            expect(() => client({ applicationId })).toThrow(
                /`applicationId` must be 1 to 128 characters, each a visible ASCII character/,
            );
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it.each(['a', '!~', 'a'.repeat(128)])(
        'accepts the id %j inside the grammar',
        async (applicationId) => {
            await client({ applicationId })._request('GET', '/v1/ctx');
            expect(sentHeaders(transport)[header]).toBe(applicationId);
        },
    );

    it.each([header, 'X-EzClassify-Application-Id'])(
        'refuses the header %s written by hand beside the option',
        (name) => {
            expect(() =>
                client({
                    applicationId: 'case-intake-portal',
                    headers: { [name]: 'other' },
                }),
            ).toThrow(/not in `headers`/);
            expect(transport).not.toHaveBeenCalled();
        },
    );

    it('takes the id once, at construction', async () => {
        const options = { applicationId: 'case-intake-portal' };
        const c = client(options);
        options.applicationId = 'replacement';
        await c._request('GET', '/v1/ctx');
        expect(sentHeaders(transport)[header]).toBe('case-intake-portal');
    });
});
