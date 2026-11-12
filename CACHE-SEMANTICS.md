# Response cache semantics

The cache contract every EzClassify REST client follows lives in the
[ezclassify/contracts](https://github.com/ezclassify/contracts) repository, beside the plans that measure it:
[`libs/conformance/cache/v1/CACHE-SEMANTICS.md`](https://github.com/ezclassify/contracts/blob/main/libs/conformance/cache/v1/CACHE-SEMANTICS.md).
Read that for what is cached, how entries are keyed, shared, canceled and
cleared, and why access decisions stay on the wire.

Users of this package want [the README](README.md) instead. What follows is how
`@ezclassify/rest-client` meets the contract, for anyone working on it.

## Where it lives

[`src/request-cache.ts`](src/request-cache.ts) is the cache: in-flight entries, refcounted
cancellation, TTL and LRU eviction. Every cached operation reaches it through
one chokepoint in [`src/ezclassify-client.ts`](src/ezclassify-client.ts):
`_cachedWire`. The two access decisions never enter it; they go straight to the
wire.

## This client's numbers

| Setting                                                           | Value               |
| ----------------------------------------------------------------- | ------------------- |
| Default unpinned TTL                                              | 5 minutes           |
| `scan`                                                            | 2 minutes           |
| `describeConcept`, `describeAllAccessRules`, `describeCrosswalks` | 1 hour              |
| LRU cap                                                           | 500 entries         |
| Pinned binding                                                    | no expiry; LRU only |

None of these is a constructor option.

## Scheme resources are connection state

A Context-bound connect reads the scheme resources once and builds the client's
profile from them, which the synchronous views read. The profile is not a
response-cache entry and `clearCache()` does not drop it. The profile and
everything in it is frozen when it is installed, so the views hand out shared
immutable values rather than copies.

On an unpinned binding, a response whose `X-EzClassify-Resolved-Version`
differs from the version the held entries were answered under clears the
response cache at once, whether or not the client has a profile and whether or
not the rebuild succeeds. The client then logs a warning and rebuilds the
profile in the background. Until that finishes a synchronous read can still
answer from the older composition. Bind to a concrete version to remove that
window.

The six resource reads are not separate operations on this client.
`fetchProfile()` is the public call that reads all six, it reaches the wire
every time, and the plans for the resource operations drive it.

## Independent results

The cache stores one value per entry and hands every caller a
`structuredClone()` of it. The clone is taken per caller, after the shared
request settles, so callers joined on one in-flight request do not share an
object either. The cost is proportional to the size of the result.

## Malformed responses

[`src/response-check.ts`](src/response-check.ts) checks every Context operation response for the members
the contract requires, at any depth, from tables generated out of the vendored
OpenAPI document by [`scripts/generate-response-shapes.mjs`](scripts/generate-response-shapes.mjs) into
[`src/response-shapes.ts`](src/response-shapes.ts). The check runs where the response is decoded, inside
the call the cache wraps, so a response that fails it settles the entry as a
failure and the entry is evicted.

## Cancellation

Every cached operation takes an `AbortSignal` as `signal`. It is split off
before the key and body are built, so it never affects either.

## Tests

[`tests/request-cache.spec.ts`](tests/request-cache.spec.ts) covers the cache as a data structure.
[`tests/wire-cache-conformance.spec.ts`](tests/wire-cache-conformance.spec.ts) runs every plan in the vendored
`plans.json` (harness in [`tests/cache-plan-runner.ts`](tests/cache-plan-runner.ts) and
[`tests/cache-plan-transport.ts`](tests/cache-plan-transport.ts)), asserting the contract in wire trips through
the real client against the vendored wire corpus. [`tests/cache-invalidation.spec.ts`](tests/cache-invalidation.spec.ts)
and [`tests/malformed-response.spec.ts`](tests/malformed-response.spec.ts) cover the clearing and malformed-response
rules beyond what the plans measure.
