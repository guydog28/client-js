/**
 * Caller identity supply.
 *
 * Covers the static string, the per-request supplier, the precedence of an
 * explicit Authorization header, and the single replay a suspected
 * authentication failure earns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

function ok(): Response {
    return mockResponse(200, JSON.stringify({ ok: true }));
}

/** The constant body a deployment returns for an unauthenticated request. */
function denial(): Response {
    return mockResponse(404, JSON.stringify({ error: 'not_found' }));
}

describe('caller identity supply', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = stubFetch();
        vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    function client(
        options?: ConstructorParameters<typeof EzClassifyClient>[1],
    ): EzClassifyClient {
        return new EzClassifyClient(BASE_URL, {
            disableCache: true,
            ...options,
        });
    }

    /**
     * A client that has already completed one request, so the replay gate is
     * open.
     */
    async function workingClient(
        options?: ConstructorParameters<typeof EzClassifyClient>[1],
    ): Promise<EzClassifyClient> {
        fetchMock.mockResolvedValueOnce(ok());
        const c = client(options);
        await c._request('GET', '/v1/ctx');
        fetchMock.mockReset();
        return c;
    }

    function sentAuthorization(callIndex: number): string | undefined {
        const init = fetchMock.mock.calls[callIndex][1];
        return (init.headers as Record<string, string>)['Authorization'];
    }

    // -----------------------------------------------------------------------
    // Resolution
    // -----------------------------------------------------------------------
    describe('resolution', () => {
        it('sends a static string as a bearer token', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({ auth: { token: 'static-token' } })._request(
                'GET',
                '/v1/ctx',
            );
            expect(sentAuthorization(0)).toBe('Bearer static-token');
        });

        it('calls a supplier and sends what it returned', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({ auth: { token: () => 'thunk-token' } })._request(
                'GET',
                '/v1/ctx',
            );
            expect(sentAuthorization(0)).toBe('Bearer thunk-token');
        });

        it('awaits a supplier that returns a promise', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({
                auth: { token: () => Promise.resolve('async-token') },
            })._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBe('Bearer async-token');
        });

        it('re-resolves on every request rather than holding the first answer', async () => {
            fetchMock.mockResolvedValue(ok());
            let issued = 0;
            const c = client({ auth: { token: () => `token-${++issued}` } });
            await c._request('GET', '/v1/ctx');
            await c._request('GET', '/v1/ctx/next');
            expect(sentAuthorization(0)).toBe('Bearer token-1');
            expect(sentAuthorization(1)).toBe('Bearer token-2');
        });

        it('calls the supplier exactly once per request', async () => {
            fetchMock.mockResolvedValue(ok());
            const supplier = vi.fn(() => 'token');
            await client({ auth: { token: supplier } })._request(
                'GET',
                '/v1/ctx',
            );
            expect(supplier).toHaveBeenCalledTimes(1);
        });

        it('omits Authorization when no token is configured', async () => {
            fetchMock.mockResolvedValue(ok());
            await client()._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBeUndefined();
        });

        it('omits Authorization for an empty token rather than sending "Bearer "', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({ auth: { token: '' } })._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBeUndefined();
        });

        it('wraps a supplier failure in an EzClassifyError that names the cause', async () => {
            fetchMock.mockResolvedValue(ok());
            const c = client({
                auth: {
                    token: () => {
                        throw new Error('refresh endpoint down');
                    },
                },
            });
            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                /auth\.token supplier failed: refresh endpoint down/,
            );
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // Precedence
    // -----------------------------------------------------------------------
    describe('an explicit Authorization header wins', () => {
        it('is not overwritten by a static token', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({
                auth: { token: 'ignored-token' },
                headers: { Authorization: 'Basic caller-owned' },
            })._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBe('Basic caller-owned');
        });

        it('is not overwritten by a supplier, which is never called', async () => {
            fetchMock.mockResolvedValue(ok());
            const supplier = vi.fn(() => 'ignored-token');
            await client({
                auth: { token: supplier },
                headers: { Authorization: 'Basic caller-owned' },
            })._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBe('Basic caller-owned');
            expect(supplier).not.toHaveBeenCalled();
        });

        it('matches the header name case-insensitively', async () => {
            fetchMock.mockResolvedValue(ok());
            await client({
                auth: { token: 'ignored-token' },
                headers: { authorization: 'Basic lowercase' },
            })._request('GET', '/v1/ctx');
            const init = fetchMock.mock.calls[0][1];
            const headers = init.headers as Record<string, string>;
            expect(headers['authorization']).toBe('Basic lowercase');
            expect(headers['Authorization']).toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Replay
    // -----------------------------------------------------------------------
    describe('replay on a suspected authentication failure', () => {
        it('replays a denial-shaped 404 once with a re-resolved token', async () => {
            const c = await workingClient({
                auth: {
                    token: (() => {
                        let issued = 0;
                        return () => `token-${++issued}`;
                    })(),
                },
            });
            fetchMock
                .mockResolvedValueOnce(denial())
                .mockResolvedValueOnce(ok());

            await expect(c._request('GET', '/v1/ctx')).resolves.toEqual({
                ok: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(sentAuthorization(0)).toBe('Bearer token-2');
            expect(sentAuthorization(1)).toBe('Bearer token-3');
        });

        it('replays exactly once: a second denial is the caller problem', async () => {
            const c = await workingClient({ auth: { token: () => 'stale' } });
            fetchMock.mockResolvedValue(denial());

            const err = await c
                ._request('GET', '/v1/ctx')
                .catch((e: unknown) => e as EzClassifyError);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(err).toBeInstanceOf(EzClassifyError);
            expect((err as EzClassifyError).possiblyUnauthenticated).toBe(true);
        });

        it('replays an opaque transport failure once', async () => {
            const c = await workingClient({
                auth: { token: () => 'rotating' },
            });
            fetchMock
                .mockRejectedValueOnce(new TypeError('Failed to fetch'))
                .mockResolvedValueOnce(ok());

            await expect(c._request('GET', '/v1/ctx')).resolves.toEqual({
                ok: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('does not replay for a static token, which cannot change', async () => {
            const c = await workingClient({ auth: { token: 'static-token' } });
            fetchMock.mockResolvedValue(denial());

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not replay when the caller owns the Authorization header', async () => {
            const supplier = vi.fn(() => 'never-sent');
            const c = await workingClient({
                auth: { token: supplier },
                headers: { Authorization: 'Bearer caller-owned' },
            });
            supplier.mockClear();
            fetchMock.mockResolvedValue(denial());

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            // Replaying would put the caller's own header back on the wire
            // byte for byte, so there is nothing to try.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(supplier).not.toHaveBeenCalled();
        });

        it('does not replay on a client that never completed a request', async () => {
            const c = client({ auth: { token: () => 'token' } });
            fetchMock.mockResolvedValue(denial());

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not replay a 404 that names the missing resource', async () => {
            const c = await workingClient({ auth: { token: () => 'token' } });
            fetchMock.mockResolvedValue(
                mockResponse(
                    404,
                    JSON.stringify({ error: 'not_found', id: 'nope' }),
                ),
            );

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not replay a server error', async () => {
            const c = await workingClient({ auth: { token: () => 'token' } });
            fetchMock.mockResolvedValue(
                mockResponse(500, JSON.stringify({ error: 'boom' })),
            );

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not replay a timeout', async () => {
            const c = await workingClient({
                auth: { token: () => 'token' },
                timeout: 10,
            });
            fetchMock.mockImplementation(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () =>
                            reject(new DOMException('aborted', 'AbortError')),
                        );
                    }),
            );
            // The client's own deadline fires while the request is in flight.

            const pending = c
                ._request('GET', '/v1/ctx')
                .catch((e: unknown) => e as EzClassifyError);
            await vi.advanceTimersByTimeAsync(20);
            const err = await pending;
            expect((err as EzClassifyError).code).toBe(ErrorCodes.TIMEOUT);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
    // -----------------------------------------------------------------------
    // Refresh hints
    // -----------------------------------------------------------------------
    describe('what the supplier is told', () => {
        it('asks for the held token on an ordinary request', async () => {
            fetchMock.mockResolvedValue(ok());
            const supplier = vi.fn(() => 'token');
            await client({ auth: { token: supplier } })._request(
                'GET',
                '/v1/ctx',
            );
            expect(supplier).toHaveBeenCalledWith({ forceRefresh: false });
        });

        it('asks for a fresh token on the replay', async () => {
            const supplier = vi.fn(() => 'token');
            const c = await workingClient({ auth: { token: supplier } });
            supplier.mockClear();
            fetchMock
                .mockResolvedValueOnce(denial())
                .mockResolvedValueOnce(ok());

            await c._request('GET', '/v1/ctx');
            expect(supplier.mock.calls).toEqual([
                [{ forceRefresh: false }],
                [{ forceRefresh: true }],
            ]);
        });

        it('sends what the refreshed call returned', async () => {
            const c = await workingClient({
                auth: {
                    token: ({ forceRefresh }) =>
                        forceRefresh ? 'refreshed' : 'stale',
                },
            });
            fetchMock
                .mockResolvedValueOnce(denial())
                .mockResolvedValueOnce(ok());

            await c._request('GET', '/v1/ctx');
            expect(sentAuthorization(0)).toBe('Bearer stale');
            expect(sentAuthorization(1)).toBe('Bearer refreshed');
        });
    });

    // -----------------------------------------------------------------------
    // What cannot be replayed
    // -----------------------------------------------------------------------
    describe('a refusal with nothing different to send', () => {
        it('is not replayed for a static token', async () => {
            const c = await workingClient({ auth: { token: 'static-token' } });
            fetchMock.mockResolvedValue(denial());

            await expect(c._request('GET', '/v1/ctx')).rejects.toMatchObject({
                possiblyUnauthenticated: true,
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('is not replayed when the caller owns the Authorization header', async () => {
            const supplier = vi.fn(() => 'never-sent');
            const c = await workingClient({
                auth: { token: supplier },
                headers: { Authorization: 'Bearer caller-owned' },
            });
            supplier.mockClear();
            fetchMock.mockResolvedValue(denial());

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(supplier).not.toHaveBeenCalled();
        });

        it('is not replayed for a failure that is not an auth failure', async () => {
            const supplier = vi.fn(() => 'token');
            const c = await workingClient({ auth: { token: supplier } });
            fetchMock.mockResolvedValue(
                mockResponse(500, JSON.stringify({ error: 'boom' })),
            );

            await expect(c._request('GET', '/v1/ctx')).rejects.toThrow(
                EzClassifyError,
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    // -----------------------------------------------------------------------
    // Unsupported constructor configuration
    // -----------------------------------------------------------------------
    describe('unsupported constructor options', () => {
        it.each([
            ['own property', { callerCredential: 'not-sent' }],
            [
                'inherited property',
                Object.create({ callerCredential: 'not-sent' }),
            ],
            [
                'non-enumerable inherited property',
                Object.create(
                    Object.defineProperty({}, 'callerCredential', {
                        value: 'not-sent',
                    }),
                ),
            ],
            ['symbol property', { [Symbol('callerCredential')]: 'not-sent' }],
        ])('refuses an unsupported %s before transport', (_name, options) => {
            expect(
                () =>
                    new EzClassifyClient(
                        BASE_URL,
                        options as unknown as ConstructorParameters<
                            typeof EzClassifyClient
                        >[1],
                    ),
            ).toThrow('EzClassifyClient: unsupported constructor option.');
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('refuses unsupported root-prototype configuration before transport', () => {
            const previous = Object.getOwnPropertyDescriptor(
                Object.prototype,
                'callerCredential',
            );
            try {
                Object.defineProperty(Object.prototype, 'callerCredential', {
                    configurable: true,
                    value: 'not-sent',
                });
                expect(() => new EzClassifyClient(BASE_URL, {})).toThrow(
                    'EzClassifyClient: unsupported constructor option.',
                );
                expect(fetchMock).not.toHaveBeenCalled();
            } finally {
                if (previous) {
                    Object.defineProperty(
                        Object.prototype,
                        'callerCredential',
                        previous,
                    );
                } else {
                    Reflect.deleteProperty(
                        Object.prototype,
                        'callerCredential',
                    );
                }
            }
        });

        it('retains caller auth in plain, null-prototype, and class options', async () => {
            class CallerOptions {
                auth = { token: 'current-token' };
                disableCache = true;
            }
            const plain = {
                auth: { token: 'current-token' },
                disableCache: true,
            };
            const nullPrototype = Object.assign(Object.create(null), plain);
            for (const options of [plain, nullPrototype, new CallerOptions()]) {
                fetchMock.mockClear();
                fetchMock.mockResolvedValue(ok());
                await new EzClassifyClient(BASE_URL, options)._request(
                    'GET',
                    '/v1/ctx',
                );
                expect(sentAuthorization(0)).toBe('Bearer current-token');
                expect(fetchMock).toHaveBeenCalledTimes(1);
            }
        });
    });
});
