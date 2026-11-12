# Development

## Requirements

- Node.js 22 or 24

## Setup

```bash
npm run deps:relock
npm ci
```

Five EzClassify packages land in the tree, and that is the whole list:
`@ezclassify/types` and `@ezclassify/tsconfig` for the build,
`@ezclassify/conformance` and `@ezclassify/conformance-server` for the wire
corpus in tests, and `@ezclassify/openapi` for the wire types the tests check
against and the contract the replay server validates requests with. All five are
published Apache-2.0 from the [ezclassify/contracts](https://github.com/ezclassify/contracts) repository. Nothing here
resolves a proprietary package, and nothing should: public code never depends
on private code. The conformance packages are test-only and carry no engine;
see [The wire corpus](#the-wire-corpus).

The `No proprietary dependency crept in` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs [`scripts/check-installed-public-deps.mjs`](scripts/check-installed-public-deps.mjs), which checks every installed
package path and declared package name against those five public names. The
names are matched whole in the script; the workflow records why each is
allowed. This gate keeps the repository publishable. A sixth name gets added
to the script and explained in the workflow deliberately or not at all.

`@ezclassify/types` is a real `dependency`, not a devDependency: the emitted
`.d.ts` files re-export its types, so a consumer has to install it too.

`npm run deps:relock` removes both `node_modules` and the root lockfile, then
resolves a new lockfile with optional native packages included, against the
registry configured for the current environment. Third-party packages resolve
only from versions published at least seven days ago: the script removes the
`@ezclassify` ranges, resolves everything else with `--before`, puts the ranges
back and resolves those without the bound, so a contracts build published
minutes ago still installs. It then drops the registry URL from each
first-party entry and runs `check:lockfile-portable` and
`check:dependency-age`, which fail on a machine-local registry URL and on any
third-party package younger than seven days. Never edit a generated lockfile
by hand.

## The development mirror

[`.github/workflows/publish-mirror.yml`](.github/workflows/publish-mirror.yml) republishes `@ezclassify/rest-client` to
a GitHub Packages development mirror every night a commit landed, and
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) installs the contracts packages from the same
mirror. The routing is written to a throwaway user config on the runner, so the
committed [`.npmrc`](.npmrc), and the `ignore-scripts=true` in it, stay as they are. The
publish job runs only on official `ezclassify/sdk-js` main when its nonsecret
`EZ_DEVELOPMENT_MIRROR_PUBLISHER` repository variable is deliberately set to
`true`. A maintainer assigns that native publisher role after reviewing and
qualifying its source; forks and non-main dispatches cannot publish.

Before dependency installation, the publisher requires a completed successful
full `.github/workflows/ci.yml` run at the exact checked-out official main SHA.
Run that existing workflow manually on the final merged source: ordinary push
and PR CI are not full qualification. The guard checks both Node 22 and 24,
`policy / plan`, `qualification / accept`, and `ci / accept` in the same run
attempt. It refuses missing, skipped, failed, duplicate, or truncated evidence
and a newer unsuccessful full run. Immediately before publication it rechecks
main and the same qualification tuple. `force` bypasses only the 24-hour age
check. Scheduled publication uses the same qualification gate; it does not
create new qualification runs automatically.

The job uses its ephemeral `github.token` for dependency reads, restricted
publication, and the cold-install proof, with `contents: read`, `actions: read`,
and `packages: write`. It needs no PAT or additional secret. The existing
package must also authorize this repository's workflow token to write it;
successful dependency reads do not prove that package write ACL. Actual native
publication followed by the exact-version cold install is the write/readback
proof. A permission failure requires maintainer diagnosis, not an automatic
credential or access fallback. The qualification record contains source SHA,
run/attempt, and required job IDs; SDK CI does not emit a qualified package
artifact.

The mirror carries prerelease versions only, stamped `1.0.0-mirror.N` from the
run number. A range of `^1.0.0` does not match `1.0.0-mirror.7`, because npm
excludes prereleases from a range that names none. Write every `@ezclassify`
range as `^1.0.0-0` or the published tarball resolves in this workspace and
nowhere else. [`scripts/check-mirror-publish.mjs`](scripts/check-mirror-publish.mjs) runs in the job, after the
version stamp and before the publish, and fails on a range that would do that,
on a stamp that did not land, and on workspaces appearing in a repository whose
publish step knows about one package. Run it yourself with
`node scripts/check-mirror-publish.mjs`; [`scripts/check-mirror-publish.spec.ts`](scripts/check-mirror-publish.spec.ts)
covers it.

The job's last step leaves the repository, installs the version it just
published from the registry it pushed it to, imports both entry points and
calls into the published bundle, so a publish that produced something no
consumer can use fails in the run that caused it.

## Commands

| Command                           | What it does                                                            |
| --------------------------------- | ----------------------------------------------------------------------- |
| `npm test`                        | Vitest suite                                                            |
| `npm run test:conformance-server` | The wire corpus over real HTTP against a replay server (also a CI step) |
| `npm run typecheck`               | `tsc` over [`src/`](src/), then the contract spec                       |
| `npm run build`                   | ESM + CJS + `.d.ts` into `dist/lib`                                     |
| `npm run lint`                    | ESLint over `src`, `tests`, `scripts`                                   |
| `npm run format:check`            | Prettier check                                                          |
| `npm run verify:publish-ready`    | test + typecheck + build + `npm pack --dry-run`                         |

Both ESLint rules are errors and CI runs them. A test file that genuinely needs
`any` disables the rule at the top of that file, with the reason, rather than
turning it down across the repository.

[`tsconfig.json`](tsconfig.json) covers [`src/`](src/) only, so a type-level assertion written in a test
file is transpiled by Vitest and never checked. [`tsconfig.contract.json`](tsconfig.contract.json) is the
second project `npm run typecheck` compiles, and it adds the test files that
have to be checked rather than the whole directory: [`tests/contract.spec.ts`](tests/contract.spec.ts),
where the adapter conformance assertions live,
[`tests/request-schema-conformance.spec.ts`](tests/request-schema-conformance.spec.ts), whose option names have to be ones
the client declares, and the wire harness
(`tests/wire-*.ts` and [`tests/integration/`](tests/integration/)), which reads the filesystem and
hashes a spec through `node:` APIs. Anything added to the list needs
`@types/node` present, which is why that devDependency exists.

`test`, `typecheck` and `build` each regenerate [`src/spec-version.ts`](src/spec-version.ts) first
([`scripts/generate-spec-version.mjs`](scripts/generate-spec-version.mjs)), stamping `CLIENT_SPEC_VERSION` from
[`vendor/spec/openapi.yaml`](vendor/spec/openapi.yaml). The file is generated; do not hand-edit it. It is
written only when the stamp changes, so a test run does not move its
modification time and a finished build does not look stale afterward.

The same three scripts regenerate [`src/response-shapes.ts`](src/response-shapes.ts) next
([`scripts/generate-response-shapes.mjs`](scripts/generate-response-shapes.mjs)): the members the contract requires of
every Context operation response, reduced out of [`vendor/spec/openapi.yaml`](vendor/spec/openapi.yaml).
[`src/response-check.ts`](src/response-check.ts) reads them to refuse a malformed 200 before the cache
can file it. Generated, never hand-edited, and written only when its bytes
change.

### `prepublishOnly` is a declaration, not a hook

[`package.json`](package.json) declares `prepublishOnly: npm run verify:publish-ready`, and npm
will not run it here: [`.npmrc`](.npmrc) sets `ignore-scripts=true`, which suppresses
npm's own lifecycle hooks along with dependencies'. Leave the key alone anyway.
A publication-boundary scan of the tarball starts from the publish lifecycle
keys, follows `npm run` from there, and reaches [`vite.config.ts`](vite.config.ts), which keeps
`@ezclassify/*` imports out of the published bundle. `npm run` is not
suppressed by `ignore-scripts`, so on that path the verification really runs.

[`tests/publish-lifecycle.spec.ts`](tests/publish-lifecycle.spec.ts) fails if the key or the chain to `vite build`
goes away.

## Generated references

Run `npm run docs` to write the public API reference to `docs/api/index.html`.
Run `npm run docs:source` to write the separate maintained-source reference to
`docs/source/index.html`. Both commands use pinned npm tools; generated HTML is
local build output. See [the reference guide](docs/API.md) for coverage and
source exclusions.

## Layout

```
src/               the client
tests/             Vitest suite, including the OpenAPI request-body contract
                   test and the in-process wire-corpus replay
tests/integration/ the conformance-server lane, its own script because it
                   binds a port
scripts/           spec-version stamper, response-shape generator, and the specs that
                   guard the vendored spec
vendor/            the vendored public contract (read-only, see below)
```

## The vendored spec

[`vendor/spec/`](vendor/spec/) and [`vendor/SPEC.md`](vendor/SPEC.md) are written only by the
`ezclassify-spec-bot` GitHub App, which vendors the published contract from
[ezclassify/contracts](https://github.com/ezclassify/contracts). Do not edit those paths by hand. Change the source in
[ezclassify/contracts](https://github.com/ezclassify/contracts) and the spec bot re-vendors it. The `vendor-readonly` workflow
enforces this.

It gates on two things, on both the push and the pull-request path: every
commit touching [`vendor/`](vendor/) must be authored as
`ezclassify-spec-bot[bot] <ezclassify-spec-bot[bot]@users.noreply.github.com>`,
name and email both, and its subject must start with `chore(spec):`. A pull
request must also be opened by the bot, unless a maintainer attaches the
`spec-mirror-override` label, which exists only on the pull-request path.

What that catches is the hand-edit. Author name, author email and subject are
all free-text fields of the commit object, chosen by whoever writes the commit,
so a writer who sets all three passes. The gate stops the accident; it does not
authenticate anyone.
Authenticating the writer would take branch protection on the vendored paths or
required signature verification, and neither is configured.

[`scripts/vendor-readonly-gate.spec.ts`](scripts/vendor-readonly-gate.spec.ts) runs that workflow's own shell against
throwaway git history, so the gate's behavior is checked locally rather than
inferred from reading the YAML. That includes the forged-identity case above,
asserted as passing, so the limit is pinned rather than described.

## Tests that read the spec

[`tests/openapi-contract.spec.ts`](tests/openapi-contract.spec.ts) validates every request body the client sends
against the schema the vendored spec declares for that operation. It is the
reason a wire change in [ezclassify/contracts](https://github.com/ezclassify/contracts) can fail this repository's build: that is
working as intended.

[`tests/request-schema-conformance.spec.ts`](tests/request-schema-conformance.spec.ts) is the stricter half. It drives every
client call that sends a body with every option set, validates the body against
the operation's JSON Schema 2020-12 request schema with AJV in strict-schema
mode, which rejects unknown keywords, and fails when a contract operation with a
request body has no case. Because the request schemas close their objects, an
option the client sends under a name the contract does not declare fails there.
It also fails the other way round: a top-level field some request schema
declares that no case sends, which means the client has no option for it.

## The wire corpus

The golden wire corpus, vendored at [`vendor/spec/wire/v1/`](vendor/spec/wire/v1/), holds recorded
request and response pairs from a real runtime, validated against the contract as they were
recorded. Nothing in it was authored. Every EzClassify SDK replays the same
corpus through its own client, which is what makes behavioral parity across five
languages something checked rather than something claimed.

Two lanes read it, and both drive the same set of calls out of
[`tests/wire-drivers.ts`](tests/wire-drivers.ts):

- **`npm test`** runs [`tests/wire-corpus-replay.spec.ts`](tests/wire-corpus-replay.spec.ts) and
  [`tests/wire-cache-conformance.spec.ts`](tests/wire-cache-conformance.spec.ts) in process. A transport stub answers
  only the requests the named cases recorded, so a client that changes a path,
  a method, a body field, or an array's order stops matching and the case fails
  with the emitted request beside the recorded one.
- **`npm run test:conformance-server`** boots `@ezclassify/conformance-server`
  and runs the same drivers over real HTTP. It binds a port, which is why it is
  its own script. The server answers only what the corpus recorded and refuses
  everything else with a 501 and a diagnostic that names the nearest recording
  and validates the request against the contract.

CI runs both. The second lane is the only place header casing, query parsing as
a server sees it, and a status the platform fetch surfaces its own way are
actually exercised; a transport stub in process cannot show any of that.

Every corpus case is either driven or listed in `EXCLUDED_CASES` with a reason.
A case that is neither fails the coverage check, so a corpus that grows a new
operation cannot quietly read as covered.

[`tests/spec-operation-coverage.spec.ts`](tests/spec-operation-coverage.spec.ts) runs the same drivers and watches which
of them reach a private member such as `_request`. Every operation the vendored
contract declares has to go on the wire from a driver that does not, or be
listed in `NOT_SENT` with the reason the client never sends it. A case only the
request transport can drive, such as a body the typed signature cannot build,
is listed in `PRIVATE_SEAM` under one of its few reasons. A new case driven that
way fails until it is filed, and a listed case that a public call now drives
fails until it is taken off the list.

The corpus is read from [`vendor/spec/wire/v1/corpus.json`](vendor/spec/wire/v1/corpus.json), and its recorded
contract digest is checked against
[`vendor/spec/openapi.yaml`](vendor/spec/openapi.yaml): replaying a recording of one contract against a
client compiled from another proves nothing about either.

The manifest beside the corpus records any place where the recorded runtime and
the published contract disagree. It is empty, and
[`tests/wire-corpus-replay.spec.ts`](tests/wire-corpus-replay.spec.ts) pins that empty set while separately proving
the manifest loaded. A future divergence therefore arrives as a failing test
rather than as an unread manifest entry; investigate whether the runtime or the
contract is wrong before changing the client.
