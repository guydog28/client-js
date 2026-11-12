/**
 * One deadline bounds the whole request.
 *
 * Every piece of caller-supplied code a request waits on runs inside the
 * client's `timeout`: the access-token supplier, the Context-token supplier,
 * the transport, the response body and the replay after it. Code that never
 * settles fails the request with `TIMEOUT`, a caller that cancels still sees
 * `ABORTED`, and nothing of the abandoned request is left attached to the
 * caller's signal or held by the client.
 */
import { getEventListeners } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { ErrorCodes, EzClassifyError } from '../src/errors';
import { mockResponse } from './fetch-mock';

const BASE_URL = 'https://api.example.com';

type Options = NonNullable<ConstructorParameters<typeof EzClassifyClient>[1]>;

function never<T>(): Promise<T> {
    return new Promise<T>(() => {});
}

function contexts(): Response {
    return mockResponse(200, JSON.stringify({ contexts: ['records'] }));
}

/** The constant body a deployment returns for an unauthenticated request. */
function denial(): Response {
    return mockResponse(404, JSON.stringify({ error: 'not_found' }));
}

/** Settle the call and report how it ended, without letting it throw. */
async function outcome(call: Promise<unknown>): Promise<EzClassifyError> {
    const err = await call.then(
        () => new Error('the call resolved'),
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EzClassifyError);
    return err as EzClassifyError;
}

describe('a stalled supplier or hook is bounded by the request timeout', () => {
    let client: EzClassifyClient | undefined;

    afterEach(() => {
        client?.destroy();
        client = undefined;
        vi.useRealTimers();
    });

    function build(options: Options): EzClassifyClient {
        client = new EzClassifyClient(BASE_URL, {
            disableCache: true,
            ...options,
        });
        return client;
    }

    it('times out an access-token supplier that never settles, with no wire call', async () => {
        const fetchImpl = vi.fn();
        const c = build({
            timeout: 20,
            auth: { token: () => never() },
            fetchImpl,
        });

        const started = Date.now();
        const err = await outcome(c.listContexts());

        expect(err.code).toBe(ErrorCodes.TIMEOUT);
        expect(err.message).toContain('auth.token');
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    describe.each([
        ['with the cache on', false],
        ['with the cache off', true],
    ])('a caller signal on a public operation, %s', (_label, disableCache) => {
        function bound(): {
            c: EzClassifyClient;
            fetchImpl: ReturnType<typeof vi.fn>;
        } {
            const fetchImpl = vi.fn();
            const c = build({
                contextId: 'records',
                contextVersion: '1.0.0',
                disableCache,
                auth: { token: () => never() },
                fetchImpl,
            });
            return { c, fetchImpl };
        }

        it('reports a cancellation during a stalled supplier as ABORTED', async () => {
            const { c, fetchImpl } = bound();
            const controller = new AbortController();

            const pending = outcome(
                c.scheme.process('OPEN', { signal: controller.signal }),
            );
            controller.abort();
            const err = await pending;

            expect(err.code).toBe(ErrorCodes.ABORTED);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('reports a deadline signal during a stalled supplier as TIMEOUT', async () => {
            const { c, fetchImpl } = bound();

            const err = await outcome(
                c.scheme.process('OPEN', { signal: AbortSignal.timeout(10) }),
            );

            expect(err.code).toBe(ErrorCodes.TIMEOUT);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('reports a deadline signal that already elapsed as TIMEOUT', async () => {
            const { c, fetchImpl } = bound();
            const signal = AbortSignal.timeout(1);
            await new Promise((resolve) => setTimeout(resolve, 20));

            const err = await outcome(c.scheme.process('OPEN', { signal }));

            expect(err.code).toBe(ErrorCodes.TIMEOUT);
            expect(fetchImpl).not.toHaveBeenCalled();
        });
    });

    it('gives the replay what is left of the deadline, not a fresh one', async () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn().mockResolvedValueOnce(contexts());
        const c = build({
            timeout: 100,
            auth: { token: () => 'token' },
            fetchImpl,
        });
        await c.listContexts();
        // The first attempt spends most of the budget before it is refused;
        // the replay then hangs on a transport that ignores its signal.
        fetchImpl
            .mockImplementationOnce(
                () =>
                    new Promise<Response>((resolve) =>
                        setTimeout(() => resolve(denial()), 80),
                    ),
            )
            .mockImplementationOnce(() => never());

        const pending = outcome(c.listContexts());
        await vi.advanceTimersByTimeAsync(100);
        const err = await pending;

        expect(err.code).toBe(ErrorCodes.TIMEOUT);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('times out a fetchImpl that ignores its signal', async () => {
        const c = build({ timeout: 20, fetchImpl: () => never() });

        const err = await outcome(c.listContexts());

        expect(err.code).toBe(ErrorCodes.TIMEOUT);
    });

    it('times out a response body that never finishes', async () => {
        const stalled = {
            ...mockResponse(200, '{}'),
            ok: true,
            status: 200,
            headers: new Headers(),
            text: () => never<string>(),
        } as unknown as Response;
        const c = build({ timeout: 20, fetchImpl: async () => stalled });

        const err = await outcome(c.listContexts());

        expect(err.code).toBe(ErrorCodes.TIMEOUT);
        expect(err.message).toContain('response body');
    });
});

describe('an abandoned wait leaves nothing behind', () => {
    let gc: () => void;

    beforeEach(() => {
        setFlagsFromString('--expose-gc');
        gc = runInNewContext('gc') as () => void;
    });

    it.each([
        ['with the cache on', false],
        ['with the cache off', true],
    ])(
        'detaches from the caller signal once a stalled supplier times out, %s',
        async (_label, disableCache) => {
            const c = new EzClassifyClient(BASE_URL, {
                contextId: 'records',
                contextVersion: '1.0.0',
                timeout: 10,
                disableCache,
                auth: { token: () => never() },
                fetchImpl: vi.fn(),
            });
            const controller = new AbortController();
            try {
                for (let i = 0; i < 3; i++) {
                    const err = await outcome(
                        c.scheme.process(`OPEN ${i}`, {
                            signal: controller.signal,
                        }),
                    );
                    expect(err.code).toBe(ErrorCodes.TIMEOUT);
                }
                expect(
                    getEventListeners(controller.signal, 'abort'),
                ).toHaveLength(0);
            } finally {
                c.destroy();
            }
        },
    );

    it('calls fetchImpl as a plain function, never with the client as its receiver', async () => {
        // A transport that records its receiver, as a spy does, would
        // otherwise keep every client it served alive; a browser's
        // window.fetch refuses the call outright.
        const receivers: unknown[] = [];
        const c = new EzClassifyClient(BASE_URL, {
            disableCache: true,
            fetchImpl: function (this: unknown) {
                receivers.push(this);
                return Promise.resolve(contexts());
            },
        });
        try {
            await c.listContexts();
        } finally {
            c.destroy();
        }
        expect(receivers).toEqual([undefined]);
    });

    /**
     * The host's work is one shared promise that never settles. It is still
     * reachable after the request gives up, so anything the request chained
     * onto it stays reachable too, unless the client lets go.
     */
    it.each([
        [
            'an access-token supplier',
            (held: Promise<never>): Options => ({
                auth: { token: () => held },
            }),
        ],
        [
            'a contextToken supplier',
            (held: Promise<never>): Options => ({ contextToken: () => held }),
        ],
    ])(
        'does not keep the client alive through %s the host holds pending',
        async (_label, configure) => {
            const held = never<never>();
            const clientRef = await (async () => {
                const fetchImpl = vi.fn().mockResolvedValueOnce(contexts());
                const c = new EzClassifyClient(BASE_URL, {
                    contextId: 'records',
                    contextVersion: '1.0.0',
                    timeout: 10,
                    disableCache: true,
                    fetchImpl,
                    ...configure(held),
                });
                const err = await outcome(c.listContexts());
                expect(err.code).toBe(ErrorCodes.TIMEOUT);
                c.destroy();
                return new WeakRef(c);
            })();

            for (let i = 0; i < 5 && clientRef.deref(); i++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                gc();
            }

            expect(clientRef.deref()).toBeUndefined();
            expect(held).toBeInstanceOf(Promise);
        },
    );
});
