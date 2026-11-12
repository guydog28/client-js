# REST client reference

`@ezclassify/rest-client` connects a JavaScript application to an EzClassify
REST deployment. The server evaluates markings, guides, and access policies.
The client handles transport, response decoding, connection state, and caching.

## Generate and browse

After installing the repository's dependencies, run `npm run docs` and open
`docs/api/index.html`. The public reference starts at [`src/index.ts`](../src/index.ts) and follows
the client facade, operation classes, and inherited adapter methods. The
`client-ops` and `scheme-state` modules explain types reachable through client
properties; they are not supported package import subpaths. Shared request and result
types come from the public `@ezclassify/types` package.

`npm run docs:source` separately writes `docs/source/index.html` for maintained
source modules and scripts. Those exports include internal implementation
details; they are not additional supported npm import subpaths. Tests,
generated spec-version output, vendored specifications, build output, and
dependency trees are excluded. TypeDoc describes exported source symbols;
it does not document shell workflows or prove implementation behavior.

Both commands fetch pinned TypeDoc and TypeScript tools through npm when they
are not cached. Generated references stay local and are excluded from Git and
the npm tarball.

## Connect and dispose

Use `connectContext` to establish a ready client. It returns a promise and
performs the connection work before resolving. The constructor creates an
unconnected client and performs no handshake. Prefer `connectContext` for a
ready adapter. The client runs no timers; `destroy()` releases cached state when
the host is finished with it.

Connection arguments select a Context and may supply separate credentials:
`auth` identifies the caller, while `contextToken` authorizes the application
and Context binding. `applicationId` names the registered application for usage
reporting and authorizes nothing; it is 1 to 128 visible ASCII characters and
the constructor refuses anything else. `connectContext` requires `contextId` and
refuses a connection without one before sending a request. Omit the version to
let the server choose: the Context token's default, or the newest published. A
concrete `contextVersion` pins the client to that version. One `timeout` covers
the whole request, including the token suppliers and the single replay, so
caller code that never settles ends in `TIMEOUT`. See generated option
descriptions for token suppliers, refresh behavior, headers, deadlines, and
cancellation.

## Operation surfaces

| Surface          | Responsibility                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `client.scheme`  | Marking processing, validation, aggregation, rendering, scanning, suggestions, and scheme descriptions           |
| `client.schemes` | The other schemes the Context holds: `get(key)` returns a view with the same operations as `client.scheme`       |
| `client.guide`   | Guide scanning, evaluation, and guide views                                                                      |
| `client.access`  | Access checks and access-policy rule lists                                                                       |
| `client.context` | Operations on the resolved composition, including document audits, access assessments, and crosswalk translation |

`EzClassifyClient` also satisfies `RemoteContextAdapter`, so consumers can use
its adapter methods directly. Public operations can reject with
`EzClassifyError`; inspect `code`, `status`, and the documented error fields.
A 429 response sets `retryAfter`, the seconds the server asked the caller to
wait.
`ErrorCodes` describes the codes the client raises itself: transport
failures, caller-input failures (`INVALID_INPUT`), and a 2xx response whose
body the contract does not allow (`MALFORMED_RESPONSE`), which is never
cached. Server responses can carry other codes, so `ErrorCode` is a string
rather than a closed enum. `isDenialShapedBody` recognizes the constant denial
body; it does not make an authorization decision.

## Caching

Response caching is enabled by default. Access decisions are never cached. A
`latest` or omitted version is mutable, so its entries expire after five
minutes. Entries under a concrete version pin do not expire. The generated
reference explains profile refresh, `disableCache`, and lifecycle methods at
their owning symbols.

See [the README](../README.md) for application examples and
[DEVELOPMENT.md](../DEVELOPMENT.md) for native tests and conformance replay.
