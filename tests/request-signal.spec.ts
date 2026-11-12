/**
 * Caller cancellation.
 *
 * Every operation that can take a while accepts a `signal` in its options bag.
 * The signal is transport, not payload: it reaches the fetch call and never the
 * request body.
 *
 * The second half of the file runs with the response cache on, which is the
 * default and the configuration typeahead actually hits: identical concurrent
 * calls share one wire trip there, so one signal cannot own it.
 */
import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError, ErrorCodes } from '../src/errors';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusResult } from './contract-fixtures';

const BASE_URL = 'https://api.example.com';
const CONTEXT = { contextId: 'test-context', contextVersion: '1.0.0' } as const;

function envelope(result: unknown): unknown {
    return {
        resolution: {
            contextId: CONTEXT.contextId,
            resolvedVersion: CONTEXT.contextVersion,
            artifacts: [],
        },
        result,
    };
}

/** The recorded corpus case whose result stands in for each operation's. */
const RESULT_CASES: Record<string, string> = {
    process: 'ctx-scheme-process.ok',
    suggest: 'ctx-scheme-suggest.ok',
    validate: 'ctx-scheme-validate.ok',
    explain: 'ctx-scheme-explain.ok',
    scan: 'ctx-scheme-scan.ok',
    render: 'ctx-scheme-render.ok',
    aggregate: 'ctx-scheme-aggregate.ok',
    aggregateAssertions: 'ctx-scheme-aggregate.assertion-sets',
    checkCoverage: 'ctx-scheme-check-coverage.ok',
    diff: 'ctx-scheme-diff.ok',
    normalize: 'ctx-scheme-normalize.ok',
};

/** A contract-valid successful result for the named operation. */
function operationResult(name: string): unknown {
    const caseId = RESULT_CASES[name];
    if (!caseId) throw new Error(`no recorded result for ${name}`);
    return corpusResult(caseId);
}

/** Every operation named in the cancellation contract, invoked options-first. */
const CANCELLABLE_OPS: Array<{
    name: string;
    call: (
        c: EzClassifyClient,
        options: { signal: AbortSignal },
    ) => Promise<unknown>;
}> = [
    { name: 'process', call: (c, o) => c.scheme.process('MARKING', o) },
    { name: 'suggest', call: (c, o) => c.scheme.suggest('MARKING', o) },
    { name: 'validate', call: (c, o) => c.scheme.validate('MARKING', o) },
    { name: 'explain', call: (c, o) => c.scheme.explain('MARKING', o) },
    { name: 'scan', call: (c, o) => c.scheme.scan('some text', o) },
    {
        name: 'render',
        call: (c, o) =>
            c.scheme.render(
                [{ conceptId: 'A', categoryId: 'a' }],
                undefined,
                o,
            ),
    },
    { name: 'aggregate', call: (c, o) => c.scheme.aggregate(['A', 'B'], o) },
    {
        name: 'aggregateAssertions',
        call: (c, o) => c.scheme.aggregateAssertions([[], []], o),
    },
    {
        name: 'checkCoverage',
        call: (c, o) => c.scheme.checkCoverage(['A'], 'PARENT', o),
    },
    { name: 'diff', call: (c, o) => c.scheme.diff('A', 'B', o) },
];

/** A fetch that settles only when its request is aborted. */
function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const fail = (): void =>
            reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
    });
}

describe('operation cancellation', () => {
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
            ...CONTEXT,
            disableCache: true,
            ...options,
        });
    }

    describe.each(CANCELLABLE_OPS)('$name', ({ name, call }) => {
        it('keeps the signal out of the request body', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(envelope(operationResult(name))),
                ),
            );
            const controller = new AbortController();
            await call(client(), { signal: controller.signal });
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            const body = JSON.parse(init.body as string);
            expect(body).not.toHaveProperty('signal');
        });

        it('passes the signal to fetch', async () => {
            fetchMock.mockResolvedValue(
                mockResponse(
                    200,
                    JSON.stringify(envelope(operationResult(name))),
                ),
            );
            const controller = new AbortController();
            await call(client(), { signal: controller.signal });
            const init = fetchMock.mock.calls[0][1] as RequestInit;
            expect(init.signal).toBeInstanceOf(AbortSignal);
            expect(init.signal?.aborted).toBe(false);
        });

        it('rejects with ABORTED when the caller aborts', async () => {
            const c = client({ fetchImpl: hangingFetch });
            const controller = new AbortController();
            const pending = call(c, { signal: controller.signal }).catch(
                (e: unknown) => e,
            );
            controller.abort();
            const err = await pending;
            expect(err).toBeInstanceOf(EzClassifyError);
            expect((err as EzClassifyError).code).toBe(ErrorCodes.ABORTED);
        });
    });

    it('leaves no abort listener behind on a signal it was handed', async () => {
        fetchMock.mockResolvedValue(
            mockResponse(
                200,
                JSON.stringify(envelope(operationResult('process'))),
            ),
        );
        const c = client();
        const controller = new AbortController();
        // One signal reused across a page's worth of requests is the shape
        // that turns a retained listener into a leak.
        for (let i = 0; i < 5; i++) {
            await c.scheme.process('MARKING', { signal: controller.signal });
        }
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('a signal aborted before the call fails without a second wire trip', async () => {
        const c = client({ fetchImpl: hangingFetch });
        const controller = new AbortController();
        controller.abort();
        const err = await c.scheme
            .suggest('MARKING', { signal: controller.signal })
            .catch((e: unknown) => e);
        expect((err as EzClassifyError).code).toBe(ErrorCodes.ABORTED);
    });
});

/** A fetch that records each request and lets the test settle it by hand. */
function recordingFetch(): {
    impl: typeof fetch;
    calls: Array<{ signal: AbortSignal; answer: (body: unknown) => void }>;
} {
    const calls: Array<{
        signal: AbortSignal;
        answer: (body: unknown) => void;
    }> = [];
    const impl = ((_url: string, init: RequestInit): Promise<Response> =>
        new Promise<Response>((resolve, reject) => {
            const signal = init.signal as AbortSignal;
            calls.push({
                signal,
                answer: (body: unknown) =>
                    resolve(mockResponse(200, JSON.stringify(envelope(body)))),
            });
            const fail = (): void =>
                reject(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        })) as unknown as typeof fetch;
    return { impl, calls };
}

describe('cancellation behind the response cache', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        stubFetch();
        vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
    });

    /** A client with the cache left on, which is the shipped default. */
    function cachingClient(fetchImpl: typeof fetch): EzClassifyClient {
        return new EzClassifyClient(BASE_URL, { ...CONTEXT, fetchImpl });
    }

    it('two callers of the same suggest share one wire trip', async () => {
        const { impl, calls } = recordingFetch();
        const c = cachingClient(impl);
        const a = new AbortController();
        const b = new AbortController();

        const first = c.scheme.suggest('MARKING', { signal: a.signal });
        const second = c.scheme.suggest('MARKING', { signal: b.signal });
        await Promise.resolve();

        expect(calls).toHaveLength(1);
        calls[0].answer(operationResult('suggest'));
        await expect(first).resolves.toBeDefined();
        await expect(second).resolves.toBeDefined();
    });

    it('one caller aborting does not cancel the other caller', async () => {
        const { impl, calls } = recordingFetch();
        const c = cachingClient(impl);
        const a = new AbortController();
        const b = new AbortController();

        const first = c.scheme.suggest('MARKING', { signal: a.signal });
        const second = c.scheme
            .suggest('MARKING', { signal: b.signal })
            .catch((e: unknown) => e);
        await Promise.resolve();

        b.abort();
        const err = await second;
        expect(err).toBeInstanceOf(EzClassifyError);
        expect((err as EzClassifyError).code).toBe(ErrorCodes.ABORTED);
        expect(calls[0].signal.aborted).toBe(false);

        calls[0].answer(operationResult('suggest'));
        await expect(first).resolves.toBeDefined();
    });

    it('a caller without a signal holds the shared request open', async () => {
        const { impl, calls } = recordingFetch();
        const c = cachingClient(impl);
        const b = new AbortController();

        const first = c.scheme.suggest('MARKING');
        const second = c.scheme
            .suggest('MARKING', { signal: b.signal })
            .catch((e: unknown) => e);
        await Promise.resolve();

        b.abort();
        expect((await second).code).toBe(ErrorCodes.ABORTED);
        expect(calls[0].signal.aborted).toBe(false);

        calls[0].answer(operationResult('suggest'));
        await expect(first).resolves.toBeDefined();
    });

    it('the wire trip is canceled once the last caller leaves', async () => {
        const { impl, calls } = recordingFetch();
        const c = cachingClient(impl);
        const a = new AbortController();
        const b = new AbortController();

        const first = c.scheme
            .suggest('MARKING', { signal: a.signal })
            .catch((e: unknown) => e);
        const second = c.scheme
            .suggest('MARKING', { signal: b.signal })
            .catch((e: unknown) => e);
        await Promise.resolve();

        a.abort();
        expect(calls[0].signal.aborted).toBe(false);
        b.abort();
        expect(calls[0].signal.aborted).toBe(true);

        expect((await first).code).toBe(ErrorCodes.ABORTED);
        expect((await second).code).toBe(ErrorCodes.ABORTED);
    });

    it('an abandoned entry is not served to the next caller', async () => {
        const { impl, calls } = recordingFetch();
        const c = cachingClient(impl);
        const a = new AbortController();

        const abandoned = c.scheme
            .suggest('MARKING', { signal: a.signal })
            .catch((e: unknown) => e);
        await Promise.resolve();
        a.abort();
        await abandoned;

        const retry = c.scheme.suggest('MARKING');
        await Promise.resolve();
        expect(calls).toHaveLength(2);
        calls[1].answer(operationResult('suggest'));
        await expect(retry).resolves.toBeDefined();
    });
});
