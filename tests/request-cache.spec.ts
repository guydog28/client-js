import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import {
    RequestCache,
    cacheKeyForWireValue,
    wireSnapshot,
} from '../src/request-cache';
import { EzClassifyClient } from '../src/ezclassify-client';
import { mockResponse, stubFetch } from './fetch-mock';

describe('RequestCache', () => {
    it('calls the thunk once for repeat gets within TTL', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        const thunk = (): Promise<number> => {
            calls++;
            return Promise.resolve(42);
        };

        const a = await cache.get('key', thunk);
        const b = await cache.get('key', thunk);

        expect(a).toBe(42);
        expect(b).toBe(42);
        expect(calls).toBe(1);
    });

    it('de-duplicates in-flight callers onto a single Promise', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        let resolveInner: (value: string) => void = () => {};
        const thunk = (): Promise<string> => {
            calls++;
            return new Promise<string>((resolve) => {
                resolveInner = resolve;
            });
        };

        const p1 = cache.get('k', thunk);
        const p2 = cache.get('k', thunk);
        const p3 = cache.get('k', thunk);
        resolveInner('OK');

        const results = await Promise.all([p1, p2, p3]);
        expect(results).toEqual(['OK', 'OK', 'OK']);
        expect(calls).toBe(1);
    });

    it('joins a pending request even after its TTL has elapsed', async () => {
        const cache = new RequestCache();
        let resolveInner: (value: string) => void = () => {};
        let calls = 0;
        const thunk = (): Promise<string> => {
            calls++;
            return new Promise<string>((resolve) => {
                resolveInner = resolve;
            });
        };
        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = (): number => t;

        try {
            const first = cache.get('key', thunk, { ttlMs: 100 });
            t += 200;
            const second = cache.get('key', thunk, { ttlMs: 100 });
            expect(calls).toBe(1);

            resolveInner('answer');
            expect(await Promise.all([first, second])).toEqual([
                'answer',
                'answer',
            ]);
            t += 50;
            expect(await cache.get('key', thunk, { ttlMs: 100 })).toBe(
                'answer',
            );
            expect(calls).toBe(1);
        } finally {
            Date.now = realNow;
        }
    });

    it('retries on rejection (failed entry is evicted)', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        const thunk = (): Promise<number> => {
            calls++;
            return calls === 1
                ? Promise.reject(new Error('boom'))
                : Promise.resolve(7);
        };

        await expect(cache.get('k', thunk)).rejects.toThrow('boom');
        const v = await cache.get('k', thunk);

        expect(v).toBe(7);
        expect(calls).toBe(2);
    });

    it('honors per-call TTL and re-fetches after expiry', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        const thunk = (): Promise<number> => {
            calls++;
            return Promise.resolve(calls);
        };

        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = (): number => t;

        try {
            await cache.get('k', thunk, { ttlMs: 1000 });
            t += 500;
            await cache.get('k', thunk, { ttlMs: 1000 });
            expect(calls).toBe(1);
            t += 600;
            await cache.get('k', thunk, { ttlMs: 1000 });
            expect(calls).toBe(2);
        } finally {
            Date.now = realNow;
        }
    });

    it('evicts LRU past maxEntries', async () => {
        const cache = new RequestCache({ maxEntries: 2, defaultTtlMs: 60_000 });

        await cache.get('a', () => Promise.resolve(1));
        await cache.get('b', () => Promise.resolve(2));
        await cache.get('c', () => Promise.resolve(3));

        expect(cache.size).toBe(2);
        let calls = 0;
        await cache.get('a', () => {
            calls++;
            return Promise.resolve(1);
        });
        expect(calls).toBe(1);
    });

    it('touching an entry refreshes its LRU position', async () => {
        const cache = new RequestCache({ maxEntries: 2, defaultTtlMs: 60_000 });
        await cache.get('a', () => Promise.resolve(1));
        await cache.get('b', () => Promise.resolve(2));
        await cache.get('a', () => Promise.resolve(1));
        await cache.get('c', () => Promise.resolve(3));

        let calls = 0;
        await cache.get('a', () => {
            calls++;
            return Promise.resolve(1);
        });
        expect(calls).toBe(0);
        await cache.get('b', () => {
            calls++;
            return Promise.resolve(2);
        });
        expect(calls).toBe(1);
    });

    it('an entry that replaces an expired one is the most recently used', async () => {
        const cache = new RequestCache({ maxEntries: 2, defaultTtlMs: 1000 });
        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = (): number => t;

        try {
            await cache.get('a', () => Promise.resolve(1));
            await cache.get('b', () => Promise.resolve(2));
            // 'a' expires, then is fetched again. The replacement is the
            // newest entry in the cache, not the oldest.
            t += 1500;
            await cache.get('a', () => Promise.resolve(1));
            await cache.get('c', () => Promise.resolve(3));

            let calls = 0;
            await cache.get('a', () => {
                calls++;
                return Promise.resolve(1);
            });
            expect(calls).toBe(0);
        } finally {
            Date.now = realNow;
        }
    });

    it('clear() drops every entry', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        await cache.get('a', () => Promise.resolve(1));
        await cache.get('b', () => Promise.resolve(2));
        cache.clear();
        expect(cache.size).toBe(0);
    });

    it('delete() force-evicts a key so the next get re-fetches', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        const thunk = (): Promise<number> => {
            calls++;
            return Promise.resolve(calls);
        };

        const first = await cache.get('k', thunk);
        expect(first).toBe(1);
        expect(calls).toBe(1);

        cache.clear();
        expect(cache.size).toBe(0);

        const second = await cache.get('k', thunk);
        expect(second).toBe(2);
        expect(calls).toBe(2);
    });

    it('size reflects entries after get and clear', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        expect(cache.size).toBe(0);

        await cache.get('a', () => Promise.resolve(1));
        expect(cache.size).toBe(1);

        await cache.get('b', () => Promise.resolve(2));
        expect(cache.size).toBe(2);

        cache.clear();
        expect(cache.size).toBe(0);
    });

    it('multiple entries past cap are evicted in one get call', async () => {
        const cache = new RequestCache({ maxEntries: 2, defaultTtlMs: 60_000 });
        // Fill well past the cap in a single loop: each get triggers _evictIfFull
        for (let i = 0; i < 6; i++) {
            await cache.get(`key-${i}`, () => Promise.resolve(i));
        }
        expect(cache.size).toBe(2);
    });

    it('rejection eviction does not remove a replacement entry (race guard)', async () => {
        // Scenario: thunk1 starts but is still in-flight (pending). An explicit
        // invalidation replaces it with thunk2.
        // When thunk1 later rejects, the guard `current.value === entry.value` must
        // prevent the new entry from being evicted.
        const cache = new RequestCache({ defaultTtlMs: 60_000 });

        let rejectThunk1: (err: Error) => void = () => {};
        const thunk1 = (): Promise<number> =>
            new Promise<number>((_, reject) => {
                rejectThunk1 = reject;
            });

        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = () => t;

        try {
            // First get: caches thunk1's pending promise
            const p1 = cache.get('k', thunk1, { ttlMs: 500 });
            expect(cache.size).toBe(1);

            cache.clear();

            // Second get: the invalidated entry is replaced by thunk2
            let thunk2Calls = 0;
            const p2 = cache.get(
                'k',
                () => {
                    thunk2Calls++;
                    return Promise.resolve(99);
                },
                { ttlMs: 500 },
            );
            expect(thunk2Calls).toBe(1);

            // Resolve p2 so we can inspect the cache
            expect(await p2).toBe(99);

            // Now reject thunk1, the race guard should leave thunk2's entry intact
            rejectThunk1(new Error('late rejection'));
            await p1.catch(() => {});

            // Give the microtask queue a turn so the .catch() handler runs
            await Promise.resolve();

            expect(cache.size).toBe(1);
            // The surviving entry is thunk2's
            let calls = 0;
            const hit = await cache.get(
                'k',
                () => {
                    calls++;
                    return Promise.resolve(0);
                },
                { ttlMs: 500 },
            );
            expect(hit).toBe(99);
            expect(calls).toBe(0);
        } finally {
            Date.now = realNow;
        }
    });

    it('uses default TTL of 5 minutes when none specified', async () => {
        const cache = new RequestCache(); // no options
        let calls = 0;
        const thunk = (): Promise<number> => {
            calls++;
            return Promise.resolve(calls);
        };

        const realNow = Date.now;
        let t = 1_000_000;
        Date.now = () => t;

        try {
            await cache.get('k', thunk);
            expect(calls).toBe(1);

            // Just under 5 minutes: still fresh
            t += 4 * 60 * 1000 + 59_000;
            await cache.get('k', thunk);
            expect(calls).toBe(1);

            // Past 5 minutes: stale
            t += 2_000;
            await cache.get('k', thunk);
            expect(calls).toBe(2);
        } finally {
            Date.now = realNow;
        }
    });
});

/** The key a request body files under, as the client builds it. */
function cacheKeyFor(op: string, composition: string, payload: unknown) {
    return cacheKeyForWireValue(op, composition, wireSnapshot(payload));
}

describe('cache keys', () => {
    it('produces the same key for objects that differ only in key order', () => {
        const a = cacheKeyFor('op', 'p', { a: 1, b: 2 });
        const b = cacheKeyFor('op', 'p', { b: 2, a: 1 });
        expect(a).toBe(b);
    });

    it('differentiates by op, profile, and payload', () => {
        const a = cacheKeyFor('process', 'my-scheme', { input: 'HIGH' });
        const b = cacheKeyFor('suggest', 'my-scheme', { input: 'HIGH' });
        const c = cacheKeyFor('process', 'other-scheme', { input: 'HIGH' });
        const d = cacheKeyFor('process', 'my-scheme', { input: 'LOW' });

        expect(new Set([a, b, c, d]).size).toBe(4);
    });

    it('handles nested objects + arrays recursively', () => {
        const a = cacheKeyFor('op', 'p', {
            tags: ['a', 'b'],
            nested: { x: 1 },
        });
        const b = cacheKeyFor('op', 'p', {
            nested: { x: 1 },
            tags: ['a', 'b'],
        });
        expect(a).toBe(b);
    });

    it('uses * when schemeId is undefined', () => {
        const k = cacheKeyFor('op', undefined, { input: 'X' });
        expect(k).toContain('*');

        const k2 = cacheKeyFor('op', 'scheme', { input: 'X' });
        expect(k).not.toBe(k2);
    });

    it('handles primitive payloads (null, string, number)', () => {
        const kNull = cacheKeyFor('op', 'p', null);
        const kStr = cacheKeyFor('op', 'p', 'hello');
        const kNum = cacheKeyFor('op', 'p', 42);

        // all distinct
        expect(new Set([kNull, kStr, kNum]).size).toBe(3);

        // stable: same input produces same key
        expect(cacheKeyFor('op', 'p', null)).toBe(kNull);
        expect(cacheKeyFor('op', 'p', 'hello')).toBe(kStr);
        expect(cacheKeyFor('op', 'p', 42)).toBe(kNum);
    });

    it('array element ORDER is preserved: different order means different key', () => {
        // Object keys are sorted; array positions are not: order matters.
        const k1 = cacheKeyFor('op', 'p', ['a', 'b']);
        const k2 = cacheKeyFor('op', 'p', ['b', 'a']);
        expect(k1).not.toBe(k2);
    });

    it('objects nested inside arrays are sorted by key', () => {
        // The elements are the same objects, just with keys in different insertion order.
        const k1 = cacheKeyFor('op', 'p', [{ a: 1, b: 2 }]);
        const k2 = cacheKeyFor('op', 'p', [{ b: 2, a: 1 }]);
        expect(k1).toBe(k2);
    });

    it('empty object and empty array produce distinct keys', () => {
        const kObj = cacheKeyFor('op', 'p', {});
        const kArr = cacheKeyFor('op', 'p', []);
        expect(kObj).not.toBe(kArr);
    });

    it('key includes the op name at the start', () => {
        const k = cacheKeyFor('process', 'scheme-1', { input: 'HIGH' });
        expect(k.startsWith('process::')).toBe(true);
    });

    it('ignores undefined members, which the wire body drops anyway', () => {
        // An options bag spread into a body puts `outputFormat: undefined`
        // there when the caller named no format. `JSON.stringify` drops it, so
        // both calls send identical bytes; keying them apart would buy a
        // second round trip for an answer already held. It also keeps the key
        // expressible in a language with no undefined.
        const spread = cacheKeyFor('suggest', 'p', {
            input: '',
            outputFormat: undefined,
            surface: undefined,
        });
        const bare = cacheKeyFor('suggest', 'p', { input: '' });

        expect(spread).toBe(bare);
    });

    it('keeps an undefined array element positional, as null', () => {
        // JSON.stringify writes null for a hole; the key has to agree, and the
        // position still matters.
        const withHole = cacheKeyFor('op', 'p', ['a', undefined, 'b']);
        const withNull = cacheKeyFor('op', 'p', ['a', null, 'b']);
        const withoutIt = cacheKeyFor('op', 'p', ['a', 'b']);

        expect(withHole).toBe(withNull);
        expect(withHole).not.toBe(withoutIt);
    });

    it('still separates a member set to null from one left out', () => {
        // null is a value the server reads; undefined is the absence of the
        // field. Collapsing those would be a different, wrong claim.
        const explicitNull = cacheKeyFor('op', 'p', { surface: null });
        const absent = cacheKeyFor('op', 'p', {});

        expect(explicitNull).not.toBe(absent);
    });
});

describe('EzClassifyClient cache integration', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('serves repeated scheme.process calls from cache (single fetch)', async () => {
        const mockResult = {
            assertions: [],
            rendered: 'UNCLASSIFIED',
            valid: true,
            inputWasValid: true,
            errors: [],
            warnings: [],
            appliedFixes: [],
            proposedFixes: [],
            assessment: {
                emitted: [],
                omitted: [],
                collapsed: [],
                conflicts: [],
                unrepresentable: [],
            },
            renders: {},
            notices: [],
        };
        const fetch = stubFetch();
        const response = {
            resolution: {
                contextId: 'test-context',
                resolvedVersion: '1.0.0',
                artifacts: [],
            },
            result: mockResult,
        };
        fetch.mockResolvedValue(mockResponse(200, JSON.stringify(response)));

        const client = new EzClassifyClient('https://api.example.com', {
            contextId: 'test-context',
            contextVersion: '1.0.0',
        });
        const r1 = await client.scheme.process('UNCLASSIFIED');
        const r2 = await client.scheme.process('UNCLASSIFIED');

        expect(r1.rendered).toBe('UNCLASSIFIED');
        expect(r2.rendered).toBe('UNCLASSIFIED');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('sends a second fetch when disableCache is true', async () => {
        const mockResult = {
            assertions: [],
            rendered: 'UNCLASSIFIED',
            valid: true,
            inputWasValid: true,
            errors: [],
            warnings: [],
            appliedFixes: [],
            proposedFixes: [],
            assessment: {
                emitted: [],
                omitted: [],
                collapsed: [],
                conflicts: [],
                unrepresentable: [],
            },
            renders: {},
            notices: [],
        };
        const fetch = stubFetch();
        const response = {
            resolution: {
                contextId: 'test-context',
                resolvedVersion: '1.0.0',
                artifacts: [],
            },
            result: mockResult,
        };
        fetch.mockResolvedValue(mockResponse(200, JSON.stringify(response)));

        const client = new EzClassifyClient('https://api.example.com', {
            contextId: 'test-context',
            contextVersion: '1.0.0',
            disableCache: true,
        });
        await client.scheme.process('UNCLASSIFIED');
        await client.scheme.process('UNCLASSIFIED');

        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('RequestCache: maxEntries boundary values', () => {
    it('maxEntries: 0 evicts every entry immediately after insert', async () => {
        const cache = new RequestCache({ maxEntries: 0, defaultTtlMs: 60_000 });
        await cache.get('a', () => Promise.resolve(1));
        expect(cache.size).toBe(0);
    });

    it('maxEntries: 0 re-fetches on every call (never cache hits)', async () => {
        const cache = new RequestCache({ maxEntries: 0, defaultTtlMs: 60_000 });
        let calls = 0;
        const thunk = () => Promise.resolve(++calls);

        await cache.get('k', thunk);
        await cache.get('k', thunk);
        await cache.get('k', thunk);
        expect(calls).toBe(3);
    });

    it('a negative maxEntries evicts immediately without looping forever', async () => {
        // With maxEntries: -1 the eviction loop's guard (size > -1) stays true
        // after the map empties; the defensive break must end the loop.
        const cache = new RequestCache({ maxEntries: -1 });
        const p = cache.get('k', () => Promise.resolve(99));
        // The promise is returned before eviction, so it still resolves.
        await expect(p).resolves.toBe(99);
        expect(cache.size).toBe(0);
    });

    it('the returned Promise resolves even though its cache entry was evicted', async () => {
        const cache = new RequestCache({ maxEntries: -1 });
        let resolved = false;
        const p = cache.get('x', async () => {
            resolved = true;
            return 'value';
        });
        const result = await p;
        expect(result).toBe('value');
        expect(resolved).toBe(true);
        expect(cache.size).toBe(0);
    });

    it('callers joined on one in-flight request share its single thunk call', async () => {
        const cache = new RequestCache({
            maxEntries: 10,
            defaultTtlMs: 60_000,
        });
        let resolve!: (v: string) => void;
        const pending = new Promise<string>((r) => {
            resolve = r;
        });
        const thunk = vi.fn(() => pending);

        const p1 = cache.get('k', thunk);
        const p2 = cache.get('k', thunk);
        expect(cache.pendingWaiters).toBe(2);
        resolve('ok');
        expect(await p1).toBe('ok');
        expect(await p2).toBe('ok');
        expect(thunk).toHaveBeenCalledTimes(1);
        expect(cache.pendingWaiters).toBe(0);
    });
});

describe('RequestCache: independent results', () => {
    const payload = () => ({ items: [{ id: 'a' }], label: 'x' });

    it('gives each caller joined on one request its own copy', async () => {
        const cache = new RequestCache({ maxEntries: 10 });
        const first = cache.get('k', async () => payload());
        const second = cache.get('k', async () => payload());
        const [a, b] = await Promise.all([first, second]);

        expect(a).toEqual(b);
        expect(a).not.toBe(b);
        expect(a.items).not.toBe(b.items);
        expect(a.items[0]).not.toBe(b.items[0]);
    });

    it('does not let a caller change what a later cached read returns', async () => {
        const cache = new RequestCache({ maxEntries: 10 });
        const thunk = vi.fn(async () => payload());
        const a = await cache.get('k', thunk);
        a.items.push({ id: 'added' });
        a.label = 'changed';
        a.items[0]!.id = 'edited';

        const b = await cache.get('k', thunk);
        expect(b).toEqual(payload());
        expect(thunk).toHaveBeenCalledTimes(1);
    });

    it('copies for a caller that arrived with a signal as well', async () => {
        const cache = new RequestCache({ maxEntries: 10 });
        const signal = new AbortController().signal;
        const a = await cache.get('k', async () => payload(), { signal });
        const b = await cache.get('k', async () => payload(), { signal });
        expect(b).toEqual(a);
        expect(b).not.toBe(a);
    });

    it('returns primitives as they are', async () => {
        const cache = new RequestCache({ maxEntries: 10 });
        expect(await cache.get('k', async () => 'plain')).toBe('plain');
    });
});

describe('cacheKeyFor: additional payload shapes', () => {
    it('boolean payload produces a stable key', () => {
        const k1 = cacheKeyFor('op', 'p', true);
        const k2 = cacheKeyFor('op', 'p', true);
        expect(k1).toBe(k2);
        expect(k1).not.toBe(cacheKeyFor('op', 'p', false));
    });

    it('deeply nested objects with out-of-order keys hash identically', () => {
        const k1 = cacheKeyFor('op', 'p', { a: { x: 1, y: 2 }, b: 3 });
        const k2 = cacheKeyFor('op', 'p', { b: 3, a: { y: 2, x: 1 } });
        expect(k1).toBe(k2);
    });

    it('arrays of objects are treated as ordered: different order means different key', () => {
        const k1 = cacheKeyFor('op', 'p', [{ id: 'a' }, { id: 'b' }]);
        const k2 = cacheKeyFor('op', 'p', [{ id: 'b' }, { id: 'a' }]);
        expect(k1).not.toBe(k2);
    });
});

describe('RequestCache: per-caller cancellation', () => {
    /** A thunk that never settles on its own, recording the signal it got. */
    function pendingThunk(): {
        thunk: (signal: AbortSignal) => Promise<string>;
        signals: AbortSignal[];
        settle: (value: string) => void;
    } {
        const signals: AbortSignal[] = [];
        let settle!: (value: string) => void;
        const thunk = (signal: AbortSignal): Promise<string> => {
            signals.push(signal);
            return new Promise<string>((resolve, reject) => {
                settle = resolve;
                signal.addEventListener(
                    'abort',
                    () => reject(new Error('aborted')),
                    { once: true },
                );
            });
        };
        return { thunk, signals, settle: (v) => settle(v) };
    }

    it('hands the thunk a signal that is not the caller signal', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        const { thunk, signals, settle } = pendingThunk();
        const caller = new AbortController();

        const p = cache.get('k', thunk, { signal: caller.signal });
        expect(signals[0]).not.toBe(caller.signal);

        settle('done');
        await expect(p).resolves.toBe('done');
    });

    it('rejects an already-aborted caller without starting a request', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        let calls = 0;
        const caller = new AbortController();
        caller.abort();

        await expect(
            cache.get(
                'k',
                () => {
                    calls++;
                    return Promise.resolve('x');
                },
                { signal: caller.signal, label: 'suggest' },
            ),
        ).rejects.toMatchObject({ code: 'ABORTED' });
        expect(calls).toBe(0);
        expect(cache.size).toBe(0);
    });

    it('keeps the shared request alive while another caller waits', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        const { thunk, signals, settle } = pendingThunk();
        const first = new AbortController();
        const second = new AbortController();

        const a = cache.get('k', thunk, { signal: first.signal });
        const b = cache
            .get('k', thunk, { signal: second.signal })
            .catch((e: unknown) => e);

        second.abort();
        await expect(b).resolves.toMatchObject({ code: 'ABORTED' });
        expect(signals[0].aborted).toBe(false);
        expect(cache.size).toBe(1);

        settle('done');
        await expect(a).resolves.toBe('done');
    });

    it('aborts the shared request and evicts once every caller has left', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        const { thunk, signals } = pendingThunk();
        const first = new AbortController();
        const second = new AbortController();

        const a = cache
            .get('k', thunk, { signal: first.signal })
            .catch((e: unknown) => e);
        const b = cache
            .get('k', thunk, { signal: second.signal })
            .catch((e: unknown) => e);

        first.abort();
        second.abort();

        await expect(a).resolves.toMatchObject({ code: 'ABORTED' });
        await expect(b).resolves.toMatchObject({ code: 'ABORTED' });
        expect(signals[0].aborted).toBe(true);
        expect(cache.size).toBe(0);
    });

    it('leaves a settled entry cached when a caller aborts afterwards', async () => {
        const cache = new RequestCache({ defaultTtlMs: 60_000 });
        const caller = new AbortController();

        await cache.get('k', () => Promise.resolve('done'), {
            signal: caller.signal,
        });
        caller.abort();

        expect(cache.size).toBe(1);
    });
});
