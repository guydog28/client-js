# <img src="https://raw.githubusercontent.com/ezclassify/client-js/main/assets/icon.svg" alt="" width="32"> EzClassify JavaScript SDK

[![CI](https://github.com/ezclassify/client-js/actions/workflows/ci.yml/badge.svg)](https://github.com/ezclassify/client-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40ezclassify%2Frest-client?label=%40ezclassify%2Frest-client)](https://www.npmjs.com/package/@ezclassify/rest-client)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js 22 | 24](https://img.shields.io/badge/node-22%20%7C%2024-339933.svg)](package.json)

Typed HTTP client for a running EzClassify REST deployment. It covers the
scheme, guide, access and composed-context operations, and it ships no engine.

Classification, marking, and access decisions run on the server. Use this
client from a Node.js application, browser, or edge runtime with `fetch`.

The [ezclassify/contracts](https://github.com/ezclassify/contracts) repository owns
document and wire types; EzClassify Runtime owns
marking and access evaluation. This client owns HTTP transport, response decoding, caching, and
language-native conveniences. Evaluation operations address a published Context;
health and Context discovery use the deployment endpoint.

## Requirements

- Node.js 22 or 24 for Node.js applications.
- For a real runtime, a reachable, licensed EzClassify REST deployment. The
  Quickstart below needs none.

The published bundle imports no Node built-ins, so it also runs in a browser or
an edge runtime that provides a global `fetch`. Node is what the test suite and
the `engines` field cover.

## Quickstart

Start with the Cedar Valley replay server. It answers over real HTTP with
responses recorded from a real runtime for Cedar Valley, a fictional school
district policy, so you can see your integration work before you have a
runtime, a license or a credential.

```bash
npm install @ezclassify/rest-client @ezclassify/conformance-server
npx @ezclassify/conformance-server --scenario cedar-valley --port 4010
```

Leave the server running. In a second terminal, in the same directory, save
this as `quickstart.mjs`:

```js
import { connectContext } from '@ezclassify/rest-client';

const client = await connectContext({
    baseUrl: 'http://127.0.0.1:4010',
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
});

try {
    const result = await client.scheme.process('INTERNAL');
    console.log(result.rendered, result.valid);
} finally {
    client.destroy();
}
```

Run it with `node quickstart.mjs`. It prints:

```text
INTERNAL true
```

The server replays a fixed set of recorded requests, so stay with the inputs
the [Cedar Valley catalog](https://github.com/ezclassify/contracts/blob/main/packages/conformance-server/scenarios/cedar-valley/README.md)
lists, such as `PUBLIC`, `INTERNAL` and `CONFIDENTIAL`. Anything else gets a
501 diagnostic, not an invented answer. A browser application on another origin
also needs `--cors-origin <origin>`. The server accepts requests without
credentials by default; `--auth simulated` requires a published test bearer so
you can exercise your credential handling.

### Swap to your runtime

Your code stays the same. Change the URL, supply your credentials, and use
the Context your runtime administrator published. `EZC_ACCESS_TOKEN` is the
caller identity and `EZC_CONTEXT_TOKEN` is the signed Context credential, where
your deployment requires one.

```js
import { connectContext } from '@ezclassify/rest-client';

const client = await connectContext({
    baseUrl: process.env.EZC_API_URL,
    auth: { token: process.env.EZC_ACCESS_TOKEN },
    contextToken: process.env.EZC_CONTEXT_TOKEN,
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
});
```

`connectContext` checks that the server is reachable before it hands you a
client. A runtime evaluates any marking, so you are no longer limited to the
catalog.

`destroy()` is not optional bookkeeping. A connected client runs a background
health poll, and until you call it the client is still alive and still polling.
In a browser that means one timer per client you forgot about; on a server it
means a leak per request. Create the client once and destroy it when the thing
that owns it goes away.

Operations are grouped by what they act on:

| Group            | Examples                                                          |
| ---------------- | ----------------------------------------------------------------- |
| `client.scheme`  | `validate`, `process`, `explain`, `suggest`, `aggregate`, `scan`  |
| `client.guide`   | `scan`, `evaluate`, `evaluateMany`, `describeRule`, `filterRules` |
| `client.access`  | `check`, `describeAccessRule`, `describeAllAccessRules`           |
| `client.context` | `audit`, `checkAccess`, `translate`, `describeCrosswalks`         |

Each group is also the adapter contract for its family, so a component that
only marks text can take `client.scheme` and never learn a REST client is
behind it.

Scheme operations that read a marking take their format choices as options
named after the wire fields. `inputFormat` says which of the scheme's formats
the input is written in; leave it out and recognition works it out.
`outputFormat` picks the output the result is written in; leave it out and you
get the scheme's default format. A scheme that declares surfaces names its
outputs as `surface/view` addresses, such as `sensitivity/short`, and leaving
`outputFormat` out writes each surface in its default for the marking's role,
so a part and a whole can come back in different views. `surface` names which
of the scheme's scopes the input is, for a fragment such as a portion; leave it
out and the input is a whole marking. Each operation takes only the ones its
request declares, so `diff` has `inputFormat` alone and `suggestForCategories`
has no `inputFormat`. `render` and `applyPreset` only produce output, so they
take one output format: `render(assertions, format)` as its second argument, and
`applyPreset(presetId, { outputFormat })` as an option.

The defaults are in the profile, so a picker does not have to guess them.
`getSchemeMeta()` reports `defaultPartRenderFormat` and
`defaultWholeRenderFormat`. For a scheme that declares surfaces, each entry in
`formats` also lists in `defaultFor` the roles it is the default for. A
scheme without surfaces has one default, `defaultRenderFormat`, and its entries
carry no `defaultFor`.

The profile a connected client holds is shared by every caller of `getScheme()`,
`findConcept()`, `getConceptsInCategory()`, `listCategories()` and
`getCategory()`, so what they return is frozen: assigning to a concept or a
category throws a `TypeError` instead of changing what the next caller reads.
The lists those methods build are yours, so you can sort or filter them in place.
Copy a concept with `structuredClone()` if you want one to edit.

## Reading a marking and writing one

Two operations answer about one marking, and they are split by who is asking.

`validate` is the reader's call. Code that displays a marking, gates on it,
stores it, or hands its facts to an access check calls it, with the text or
with the facts a document states:

```ts
const read = await client.scheme.validate('confidential');
if (!read.valid) showErrors(read.errors);
```

Pass facts only as a document or an author stated them. The `assertions` of an
earlier result are already settled, and validating those can call a marking
valid whose text was not.

`process` is the author's call. It answers everything `validate` does, settled
the same way, plus what someone writing the marking needs: the corrections to
the text, the fix paths the server has proven, a rendering for each output you
name, and picker options for the categories you name. A composer sends what was
typed together with the facts already picked:

```ts
const draft = await client.scheme.process(typed, {
    assertions: pickedSoFar,
    outputs: ['short'],
    suggestFor: ['level'],
});

preview(draft.renders.short.rendered);
offer(draft.suggestionsFor?.level.suggestions);
```

`renders` holds only the outputs you name, and `suggestionsFor` is there only
when you ask for it. Outputs are spelled the way the scheme declares them: a
format id here, a `surface/view` address for a scheme that declares surfaces.
`valid` and `inputWasValid` mean the same thing on both calls, so the same
input is judged the same way by either one.

`explain` takes what `process` takes and returns the trace instead: what was
read, repaired, inferred and found wrong, and what was written. It is for the
moment someone asks why.

## Binding to a published Context

A Context pins a scheme, a guide and an access policy together at a version.
Bind one and every operation routes through it.

```ts
import { connectContext } from '@ezclassify/rest-client';

const client = await connectContext({
    baseUrl: 'http://localhost:3000',
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
    auth: { token: () => session.getAccessToken() },
});

await client.scheme.process('confidential');
// POST /v1/ctx/cedar-valley/1.0.0/scheme/process
```

The remote client has no scheme-addressed mode. A Context owns the complete
composition; discover available ids with `client.listContexts()` and versions
with `client.listContextVersions(contextId)` when those values are not already
configuration.

`auth` here is the same object the constructor takes, so a token supplier and an
auth-failure hook both work from this entry point. See
[Authentication](#authentication).

A Context also owns the operations no single family can answer alone. `audit`
uses the scheme and guides together, and
`translate` applies a crosswalk the Context declares:

```ts
const { result, resolution } = await client.translate({
    crosswalkId: 'state-to-district',
    marking: 'confidential',
});
// resolution names the exact artifact versions that answered
```

`describeCrosswalks()` lists the crosswalks the Context holds, each with its
source and target as the scheme selectors `describeSchemes()` reports and the
mappings and selections a translation applies. A translation view bound to one
scheme picks the crosswalk that reads from it:

```ts
const [scheme] = await client.describeSchemes();
const crosswalk = (await client.describeCrosswalks()).find(
    (entry) => entry.source === scheme.selector,
);
```

`client.scheme` marks in the Context's primary scheme. To mark in another
scheme the Context holds, such as a crosswalk's target, get its view by key. The
key is the `selector` `describeSchemes()` reports:

```ts
const target = client.schemes.get('district-records');
await target.validate('restricted');
// POST /v1/ctx/cedar-valley/1.0.0/scheme/validate?scheme=district-records
```

The view has every operation and read `client.scheme` has, and caches its
answers apart from the primary's. `connect()` loads each held scheme's profile,
so its synchronous reads answer at once. The server decides which keys exist:
an operation on a key the Context does not hold rejects with a 404
`scheme_not_found`, and nothing falls back to the primary.

`guide.evaluate(guideId, ruleIds)` evaluates one guide. `guide.evaluateMany`
rolls up a selection that spans guides, and each selection names its guide,
because two guides can use the same rule id:

```ts
await client.guide.evaluateMany([
    { guideId: 'records-guide', ruleId: 'personnel-file' },
    { guideId: 'legal-guide', ruleId: 'personnel-file' },
]);
```

### What a Context binding knows about itself

Connecting to a Context resolves its decomposition once and keeps it, because a
resolved Context is fixed for the life of a version. That is what lets the
synchronous accessors answer at all on a client that holds no documents:

```ts
client.access.schemeId; // 'cedar-valley', the base of the layer stack
client.guide.listGuideMeta(); // id, version, name and rule count per guide
client.guide.getGuideMeta('cedar-valley-guide');

await client.describeContext(); // the whole decomposition, if you want it
```

The decomposition lists the composed scheme with its layers, the guides, the
access policy and the crosswalks the Context declares. Each carries the version
the Context asked for and the concrete version that answered, so a Context
that follows `latest` shows what it resolved to.

Guide metadata is loaded on connect, one structural view per guide the Context
declares. A Context that declares no guide costs nothing extra, and
`buildGuideViews()` on one answers `[]` without a request. If a guide view will
not load, the connection stands and the metadata stays empty rather than being
filled in with guesses.

A client built with `new EzClassifyClient(...)` has resolved nothing yet.
`access.schemeId` throws there, the same way `getScheme()` does, until you
connect or call `describeContext()`.

## Authentication

Use the caller's bearer token together with independent Context authorization,
or a credential registered for the calling application.

```ts
const client = new EzClassifyClient('https://ezclassify.example', {
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
    auth: { token: '<caller identity token>' }, // Authorization: Bearer ...
    contextToken: '<signed Context envelope>', // X-EzClassify-Context-Token
    headers: { 'X-Request-Id': 'abc123' }, // merged into every request
});
```

`auth.token` says who is asking and goes on every request. `contextToken`
carries the signed Context authorization and is sent only on `/v1/ctx` paths,
so health probes and other deployment-level requests do not carry it.

`contextVersion` is optional. Omit the version to let the server choose: the
Context token's default, or the newest published. A client with no version is
unpinned, the same as one bound to `latest`; see
[Caching](#caching-and-the-connection-heartbeat).

### Application credentials

Get an application credential from your deployment's management plane. A browser
application uses a browser credential registered for the page's exact origin. Supply it through the existing headers option:

```ts
const client = new EzClassifyClient('https://runtime.example', {
    contextId: 'mission',
    headers: {
        'x-ezclassify-application-grant': '<browser application credential>',
    },
});
```

A backend application reads its own backend credential from protected server
configuration:

```ts
const credential = process.env.EZC_APPLICATION_CREDENTIAL;
if (!credential) throw new Error('Set EZC_APPLICATION_CREDENTIAL');

const client = new EzClassifyClient('https://runtime.example', {
    contextId: 'mission',
    headers: {
        'x-ezclassify-application-grant': credential,
    },
});
```

The client treats the credential as opaque and sends it only on `/v1/ctx`
requests. Health probes do not carry it. A configured application credential
can be combined with `auth.token` when its registered user policy requires a
user access token. Supply that token through `auth`, not a handwritten
Authorization header. A Context token cannot be combined with an application
credential.
Browser credentials are visible to the application's users. The runtime refuses
backend credentials on browser requests. The credential identifies the application.
Your application continues handling user sign-in and access policy.

### Using a saved client connection

Studio can provide connection JSON containing the Runtime URL, Context,
application credential and configured user policy. Keep this configuration
separate from each user's session:

```ts
import { clientFromConnection } from '@ezclassify/rest-client';

const connection = {
    baseUrl: 'https://runtime.example',
    contextId: 'mission',
    contextVersion: '1.0.0',
    headers: {
        'x-ezclassify-application-grant': applicationCredential,
    },
    auth: {
        issuer: 'https://identity.example',
        audience: 'runtime',
        required: true,
    },
};

const client = clientFromConnection(connection, {
    auth: { token: () => currentUserAccessToken() },
});
```

Create a client for each caller so credentials and cached responses stay scoped
to that caller. The helper validates the JSON and applies the supplied session;
it does not sign users in or acquire tokens. For a configured asserted-user
policy, the connection instead names `userHeader` and optional `userHeaders`
attribute mappings. Pass that caller's `user` and `attributes` to the helper.
Only send identity obtained through your application's configured authentication.
The Runtime enforces its registered policy; connection JSON cannot change it.
Protected standalone Runtime configuration supports the same application
definition without Studio.

### Where the token comes from

A deployment configured to verify user tokens trusts your OpenID Connect
provider, such as your existing Okta or Keycloak installation. Your app signs
the user in there, gets an access token back, and sends it to this API.
The client is not part of that exchange: it never talks to the provider, never
refreshes anything, and never stores a token. It sends the one you hand it.

Those tokens are short-lived by design, often five minutes. A browser tab that
stays open all afternoon will outlive many of them.

### Give it a supplier, not a string

A plain string is captured at construction and sent forever, which is fine for
a script that runs and exits. For anything that lives longer, pass a function.
The client calls it on every request and keeps nothing:

```ts
const client = await EzClassifyClient.connect('https://ezclassify.example', {
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
    auth: { token: () => auth.getAccessToken() }, // string or Promise<string>
});
```

Return whatever your auth library currently holds. If it refreshes in the
background, this client picks up the new token on the next request with no
rebuild and no lost cache.

A supplier also buys you one retry. If a request fails in a way that looks like
an expired credential, the client re-resolves the token and replays the request
once. There is no loop: a second failure is yours to handle.

The retry only helps if the second token is different from the first, so the
supplier is told which call it is answering:

```ts
const client = await EzClassifyClient.connect('https://ezclassify.example', {
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
    auth: {
        token: async ({ forceRefresh }) => {
            if (forceRefresh) await identitySession.refresh();
            return identitySession.accessToken!;
        },
        onAuthFailure: (err) => console.warn('re-authenticating', err.message),
    },
});
```

`onAuthFailure` runs before the replay and is awaited, so it is also a fine
place to do the refresh itself. Throw from it and the request fails there
instead of being replayed, which is what you want when the session is really
gone and the right move is to send the user back to the login page.

All of this happens inside the request's `timeout`. The supplier, the hook and
the replay share one deadline, so a refresh that hangs fails the call with
`TIMEOUT` instead of leaving it waiting. A `signal` you abort still cancels with
`ABORTED`.

The hook fires on every suspected auth failure, whatever you passed as `token`.
A static string cannot be re-resolved and a header you wrote yourself is yours,
so neither of those gets a replay, but both still get the call. Redirecting to
the login page is exactly the thing an app with a static token needs to do.

If you would rather manage the header yourself, put `Authorization` in
`headers`. It wins over `auth`, the supplier is never called, and the client
will not touch the header.

## A form with many marking fields

One `suggest` call per field per edit is a lot of requests for one answer.
`suggestForCategories` takes the committed assertions once and returns a result
per category:

```ts
const byCategory = await client.scheme.suggestForCategories(
    committedAssertions,
    ['level', 'sensitive_content', 'handling'],
);

render(byCategory.level.suggestions);
```

Each category is answered as if its own assertions were not chosen yet, so a
picker shows the alternatives to the current selection rather than only what is
still addable beside it. You do not have to strip anything out first, and each
entry holds that category's options only.

If the same edit also processes the marking, name the categories in
`suggestFor` on that `process` call instead. The same map comes back in
`suggestionsFor`, and the edit costs one request instead of two.

The route is part of the 1.0 Context contract. A deployment that does not serve
it is version-incompatible, and the call reports that rather than fanning out
one request per category behind your back.

## Notices come back with the marking

A scheme can attach notices to its concepts: text the user has to see, and
sometimes acknowledge, whenever a marking asserts that concept. Every result
that describes a marking carries them.

```ts
const result = await client.scheme.process('confidential');

for (const notice of result.notices) {
    showNotice(notice.text, { mustAcknowledge: notice.required });
}
```

The list is always present, empty when the marking has none, so there is
nothing to check for before reading it. `process`, `validate`, `applyPreset`,
`aggregate` and every span in the `results` of a `scan` carry the same list. A
`scan` answers `{ results, limits }`: `limits.status` tells a clean document
from one the scan stopped reading, which an empty list alone cannot.

`client.scheme.collectNotices(assertions)` answers the same question from a set
of assertions on their own. Reach for it when assertions are all you have. If
you just processed a marking, the notices are already in the result and a
second call buys you nothing.

## Errors

Every failure is an `EzClassifyError`. It carries the server's error code, the
HTTP status, and the parsed response body when there was one.

```ts
import { EzClassifyError } from '@ezclassify/rest-client';

try {
    await client.context.audit({ text: '' });
} catch (err) {
    if (err instanceof EzClassifyError) {
        console.error(err.status, err.code, err.detail);
        // 400 INVALID_INPUT empty-document
    }
}
```

`detail` says what the failure is about. When a request names a format, a
concept or a category the scheme does not declare, it is the field and the id,
written `field: id`. An output format the scheme lacks comes back as a 400
`INVALID_INPUT` with `outputFormat: nope`, and an unknown concept passed to
`describeConcept` as a 404 `NOT_FOUND` with `conceptId: NOPE`. The server
refuses a query parameter or body field an operation does not declare in the
same way, with `query: name` or `body: name`; the client sends none.

### Rate limits

A 429 means the server is limiting your request rate. `retryAfter` on the error
is the number of seconds it asked you to wait. It comes from the `Retry-After`
header, and from the body when the header is absent. It is unset on every other
failure, and on a 429 that names no delay.

```ts
try {
    await client.scheme.validate(text);
} catch (err) {
    if (err instanceof EzClassifyError && err.status === 429) {
        await sleep((err.retryAfter ?? 1) * 1000);
        // then retry
    }
}
```

The client does not retry on its own.

A marking that does not read is not a failure. `process('principal only')`
resolves with `valid: false` and the errors that say why; only a request the
server refuses, or one that never completes, throws.

`status` and `body` are set only on a non-2xx response. On every other failure
`code` names the failure class:

| `code`               | What happened                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `NETWORK`            | The request never completed. Refused, DNS, CORS block.                                    |
| `TIMEOUT`            | The client's own deadline elapsed. See `timeout`.                                         |
| `ABORTED`            | You canceled it through a `signal`. A `signal` that timed out is `TIMEOUT`.               |
| `UNREACHABLE`        | Skipped: an earlier request failed and the client is waiting for the server to come back. |
| `INVALID_INPUT`      | A bad argument, or a call the client is not set up for.                                   |
| `MALFORMED_RESPONSE` | The server answered 2xx with a body the contract does not allow.                          |

A non-2xx response keeps whatever `code` the server sent. When the body carries
none, `code` is `HTTP` and `status` is the thing to branch on.

### A 404 may mean you are not authenticated

This is the part that surprises people. A deployment running authentication
checks the credential before it routes the request, and an unauthenticated
request gets back a 404 with a constant body:

```json
{ "error": "not_found" }
```

That is deliberate. The server will not tell an anonymous caller which routes
exist. The consequence for you is that a 404 is not proof a Context or route is
missing.

The client tells the two apart by the body. A 404 that names what was missing is
a real not-found and carries no flag. A 404 carrying exactly the
constant shape above, on a client that has a credential configured, comes back
with `possiblyUnauthenticated` set:

```ts
if (err instanceof EzClassifyError && err.possiblyUnauthenticated) {
    // check the token before you go looking for a missing route
}
```

The flag needs a credential to be worth raising, so a client built without one
never gets it. If you point a client with no `auth` at a deployment that
requires it, every call comes back as a plain 404 and nothing looks like an auth
problem. That is the first thing to check when a fresh integration reports that
none of the routes exist.

## Canceling a request

`process`, `validate`, `explain`, `suggest`, `suggestForCategories`, `scan`,
`render`, `aggregate`, `aggregateAssertions`, `checkCoverage`, `diff` and
`normalize` take a `signal` in their options bag.
Typeahead is the obvious case: drop the keystroke you no longer care about
instead of racing it.

An `AbortController` is single use. Once aborted it stays aborted, and every
later request handed the same signal fails immediately. Typeahead therefore
needs a fresh controller per keystroke, aborting the previous one:

```ts
let inFlight: AbortController | null = null;

input.addEventListener('input', async () => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    try {
        const result = await client.scheme.suggest(input.value, {
            signal: controller.signal,
        });
        render(result);
    } catch (err) {
        if (err instanceof EzClassifyError && err.code === 'ABORTED') return;
        throw err;
    }
});
```

An aborted request throws with `code === 'ABORTED'` and does not count against
the connection.

Cancellation is per caller. The cache below collapses identical concurrent calls
onto one request, so aborting yours ends your call and leaves anyone else on
that request alone. The request is dropped when the last caller has gone.

## Caching and the connection heartbeat

Marking-family responses are cached in memory, keyed by operation, composition
and request body, with an LRU cap. The cache belongs to the client instance, so
two clients holding different credentials never share entries.

What it holds: `process`, `validate`, `explain`, `normalize`, `render`, `diff`,
`aggregate`, `aggregateAssertions`, `applyPreset`, `suggest`,
`suggestForCategories`, `scan`, `describeConcept`, `describeAllAccessRules`,
and `describeCrosswalks`. Every field of the request is part of the key, so two
`process` calls that name different `outputs` or `suggestFor` are two entries.
Everything else reaches the server on every call, including the guide
operations and the composed Context operations. The full list, with the
reasoning, is in the [cache contract](https://github.com/ezclassify/contracts/blob/main/libs/conformance/cache/v1/CACHE-SEMANTICS.md).

| Option                 | Default  | Effect                                          |
| ---------------------- | -------- | ----------------------------------------------- |
| `disableCache`         | `false`  | Turn the cache off entirely                     |
| `cacheTtlMs`           | `300000` | Entry lifetime, 5 minutes; at most one hour     |
| `cacheMaxEntries`      | `500`    | LRU cap before eviction                         |
| `cacheAccessDecisions` | `false`  | Cache access decisions; see below before you do |
| `timeout`              | `30000`  | Whole-request deadline in ms                    |
| `heartbeat`            | on       | Pass `false` to never start the health poll     |

### Every caller gets its own result

A cached answer is stored once and each caller is handed a copy of it, including
callers that joined one request already in flight. Change a result however you
like: it does not change what anyone else holds or what the next identical call
returns. The copy is a `structuredClone()` of the decoded response, so its cost
grows with the size of the result, most noticeably for `scan` on a long document.
A call that cannot be answered from the cache costs one clone after the request;
a repeat costs one clone and no request.

### A malformed response is a failure

A 200 that lacks a member the contract requires, at any depth, throws an
`EzClassifyError` with `code === 'MALFORMED_RESPONSE'` naming the missing
member, and is not cached; the next identical call asks the server again. An
empty body and one that is not JSON fail the same way. The required
members come from the OpenAPI contract this release was built against.

### When the cache is cleared

`clearCache()` drops every entry. The client also drops them without being
asked when a response says the entries are stale: a 401, the deployment's
constant denial-shaped 404, or, on a `latest` or omitted version, an
`X-EzClassify-Resolved-Version` different from the one the held entries were
answered under. The last one clears at once; the scheme profile behind the
synchronous accessors is rebuilt in the background. A 404 that names a missing
concept or rule leaves the cache alone.

### Pinned versions are cached until they are evicted

Bind a client to `{contextId, contextVersion}` and the TTL stops applying.
A published version is immutable, so the same request answers the same next
week, and expiring the entry would buy a round trip that returns what you
already have. Entries under a pin go away when the LRU cap pushes them out, or
when you call `clearCache()`.

`latest` and an omitted Context version keep the TTL because either can resolve
to a newer immutable version on a later request. That is also why `cacheTtlMs`
tops out at one hour: the constructor refuses zero, a negative or non-finite
value, and anything above `3600000` with `INVALID_INPUT`, rather than letting an
entry on a binding that can move live longer.

### Access decisions are not cached, unless you say so

`access.check` and `client.context.checkAccess` reach the server every time.
That is not an oversight. The request is what puts the decision in the
deployment's audit record, against the exact artifact versions that answered it,
and a decision served out of client memory is one the deployment cannot show
anyone later.

If your integration checks the same subject against the same data often enough
for that traffic to hurt, you can trade it:

```ts
const client = await connectContext({
    baseUrl: 'https://ezclassify.example',
    contextId: 'cedar-valley',
    contextVersion: '1.0.0', // required: not `latest`, not omitted
    cacheAccessDecisions: true,
});
```

The decision you get back is the same one the server would have returned, since
a pinned version fixes both the policy and the inputs. What you are giving up is
the completeness of the audit trail, and only that. The option is refused on a
binding that can move, so it cannot quietly become a correctness problem.

The whole contract, written for anyone porting these semantics to another
language, is in the [cache contract](https://github.com/ezclassify/contracts/blob/main/libs/conformance/cache/v1/CACHE-SEMANTICS.md).

### The connection heartbeat

A connected client polls `/v1/health` on a background timer, backing off from
15 s to 60 s while the server is unreachable. The timer is unref'd, so it will
not by itself keep a Node process from exiting, but the client is still running
until you call `client.destroy()`.

The poll does more than keep the connection warm. When a request fails on the
transport, the client marks the server unreachable and refuses everything else
with `UNREACHABLE` rather than piling requests onto a server that is not
answering. The poll is one of the two things that notice the server come back.
The other is a plain request: five seconds after a failure the client lets one
through, whether or not the poll is running. It succeeds and the client is
connected again, or it fails and the next one waits another five seconds. That
five-second ceiling is why a blip does not cost you the poll's full backoff.

## Server rendering and serverless

A handler that builds and throws away a client per request has nothing for the
health poll to keep warm. Turn it off there:

```ts
const client = await EzClassifyClient.connect(process.env.EZCLASSIFY_URL!, {
    contextId: 'cedar-valley',
    contextVersion: '1.0.0',
    heartbeat: false,
});
try {
    return await client.scheme.process(marking);
} finally {
    client.destroy();
}
```

Two more things matter on a request path.
`connect()` costs a health round trip, one for the Context decomposition, the
scheme profile resources, and one per declared guide. A per-request client pays
that every time. And the
response cache belongs to the instance, so a client you throw away is a cache
you throw away.

If your runtime keeps modules warm between invocations, build the client once at
module scope and let it live. Leave the heartbeat on for that one: it is a
long-lived client, the poll keeps it warm, and `destroy()` belongs in the
shutdown path rather than in the handler.

## Version skew

`client.engineSpecVersion()` returns the wire spec version this build was
compiled against. `client.ping()` returns what the deployment reports. If the
major.minor pair differs, the first `ping()` logs a warning. Mixed minor
versions are not supported.

### A newer server may send fields this build does not know

Responses are open and requests are closed. A deployment ahead of your client
can add fields to what it sends back, and this client passes them through
rather than rejecting the response or stripping them: the result object you get
from an operation is the one the server sent. New fields arrive optional, and
removing or re-meaning one is a major version, so an old client stays correct
against a newer runtime.

Going the other way, a body you send is checked against the contract and the
server refuses a field it does not recognize. A typo in a request is an error,
not a silently ignored key.

## Integration testing

Start with the runnable [first application walkthrough](examples/first-app/README.md).
It runs the same backend code against the Cedar Valley replay server, your
runtime and your application's approved Context. The example ships in the npm
package.

The replay server from the [Quickstart](#quickstart) also covers access
decisions and the failures an integration has to survive. It is Apache-2.0 and
needs Node.js 22 or 24. Supported requests are listed in the
[scenario server guide](https://github.com/ezclassify/contracts/tree/main/packages/conformance-server#testing-an-application-integration).
Unrecorded requests return a diagnostic rather than computing a new answer.
With it running on port 4010, use your normal client to test connectivity,
response handling and access-decision logging:

```ts
import { connectContext, type EzClassifyClient } from '@ezclassify/rest-client';

let client: EzClassifyClient | undefined;
try {
    client = await connectContext({
        baseUrl: 'http://127.0.0.1:4010',
        contextId: 'cedar-valley',
        contextVersion: '1.0.0',
    });
    const result = await client.scheme.process('INTERNAL');
    console.log(result.rendered, result.valid);
    const decision = await client.context.checkAccess(
        'CONFIDENTIAL',
        {},
        {
            audit: {
                userId: 'cedar-valley-demo-user',
                resourceId: 'cedar-valley-demo-document',
            },
        },
    );
    console.log({
        granted: decision.result.granted,
        rules: decision.result.rules.map(({ rule, granted, reason }) => ({
            rule,
            granted,
            reason,
        })),
    });
} catch (error) {
    console.error('Integration request failed', error);
} finally {
    client?.destroy();
}
```

The example logs the outcome and rule explanations without copying subject
attributes or credentials into the log. In your backend, derive attributes
from trusted identity data and add your application's correlation ID and
resource reference. Apply your log retention and redaction policy to returned
explanations too. A denied access decision is a successful response with
`granted: false`; handle transport or authentication failures separately.

Restart with `--scenario transient-error`, `rate-limit`, `unavailable`,
`slow-response`, `disconnected`, `malformed-json`, or `malformed-envelope` to
exercise failures on the recorded process request. Clear the client response
cache or create a new client between runs so an earlier answer does not hide
the scenario. The guide lists authentication, validation, empty-result, and
complex access cases. These recordings test your integration, not the
correctness of a production authorization policy.

## Contributing and security

For contributor setup and the contribution process, see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Report
vulnerabilities through [`SECURITY.md`](SECURITY.md), never a public issue.

Issues are tracked centrally for the whole EzClassify family, at
[ezclassify/ezclassify](https://github.com/ezclassify/ezclassify/issues).

## License

[Apache-2.0](LICENSE) © EzClassify, LLC

## API reference

The [reference guide](docs/API.md) covers package APIs and links the separate
maintainer source reference.
