#!/usr/bin/env node
/**
 * Dependency quarantine gate.
 *
 * Refuses third-party packages that were published inside a quarantine window,
 * so a freshly compromised release has to sit on the registry for a while
 * before it can enter this repository's dependency tree.
 *
 * This is deliberately NOT npm's `min-release-age` setting. That setting is
 * tree-wide with no way to exempt a scope, so putting it in a committed
 * `.npmrc` also quarantines our own first-party packages: a package published
 * minutes ago fails to install with ETARGET, which breaks the ordinary
 * cross-repository loop of publishing a library and refreshing its consumer.
 * The window belongs on third-party intake only, so the check lives here where
 * it can tell the two apart.
 *
 * Reads the lockfile rather than the manifests: the lockfile names the exact
 * versions that would be installed, including transitive ones, which is the set
 * that actually matters.
 *
 * Usage:
 *
 *     node scripts/check-dependency-age.mjs [--days=N] [--lockfile=PATH] [--registry=URL]
 *     [--first-party-registry=URL,URL,...]
 *
 * Each flag also has an environment form, which is what the tests use:
 * `EZCLASSIFY_DEPENDENCY_AGE_DAYS`, `EZCLASSIFY_DEPENDENCY_AGE_LOCKFILE`,
 * `EZCLASSIFY_DEPENDENCY_AGE_REGISTRY` (the registry asked about an entry whose
 * lockfile record carries no `resolved` URL), and
 * `EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES` (comma-separated origins
 * trusted to serve `@ezclassify/*`; see `resolveFirstPartyRegistries`).
 *
 * @module
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Default quarantine window. A week is long enough that a malicious release has
 * usually been reported and unpublished, and short enough that ordinary
 * upgrades are not held up for a sprint.
 */
const DEFAULT_QUARANTINE_DAYS = 7;

/**
 * Package-name prefix owned by this project. An entry with this prefix is
 * exempt from the window only when it is also served by a registry this project
 * trusts with that scope (see `resolveFirstPartyRegistries` and
 * `collectThirdPartyPackages`). The prefix alone is not enough: a same-named
 * package served by any other registry is still checked.
 */
const FIRST_PARTY_PREFIX = '@ezclassify/';

/**
 * Registries known to be first-party regardless of local `npm config`, kept in
 * addition to whatever `@ezclassify:registry` currently resolves to.
 */
const KNOWN_FIRST_PARTY_REGISTRIES = ['https://npm.pkg.github.com'];

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * How long one publish-date request may take. A required check must fail on a
 * registry that accepts the connection and never answers, not hang the job.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Upper bound on the whole run. Anything not checked when it passes is reported
 * as unconfirmed and fails the gate.
 * `EZCLASSIFY_DEPENDENCY_AGE_OVERALL_TIMEOUT_MS` shortens it for tests.
 */
const OVERALL_TIMEOUT_MS = resolveOverallTimeout();

function resolveOverallTimeout() {
    const raw = process.env.EZCLASSIFY_DEPENDENCY_AGE_OVERALL_TIMEOUT_MS;
    if (raw === undefined) return 5 * 60_000;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(
            `EZCLASSIFY_DEPENDENCY_AGE_OVERALL_TIMEOUT_MS must be a positive integer, got "${raw}".`,
        );
    }
    return value;
}

/**
 * Registry consulted for a third-party entry whose lockfile record carries no
 * `resolved` URL, which is common when the lockfile was written with
 * `--package-lock-only`.
 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * The one recognized env var name for the first-party registry allowlist. An
 * unrecognized near-miss is rejected rather than ignored, so a typo cannot
 * quietly disable the override. See `rejectUnrecognizedTrustEnvVars`.
 */
const FIRST_PARTY_REGISTRIES_ENV_VAR =
    'EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fail loudly on an `EZCLASSIFY_*` env var that looks like it was meant to name
 * the first-party registry allowlist but does not match the one recognized
 * name. A near-miss (wrong pluralization, "TRUST" instead of "FIRST_PARTY", a
 * name copied from elsewhere) must not silently fall back to defaults, or the
 * control goes quietly unenforced.
 */
function rejectUnrecognizedTrustEnvVars() {
    const trustNamePattern = /^EZCLASSIFY_.*(FIRST_PARTY|TRUST).*REGISTR/i;
    for (const key of Object.keys(process.env)) {
        if (key === FIRST_PARTY_REGISTRIES_ENV_VAR) continue;
        if (trustNamePattern.test(key)) {
            throw new Error(
                `Unrecognized environment variable "${key}" looks like it was meant to configure the first-party registry allowlist. ` +
                    `The recognized name is ${FIRST_PARTY_REGISTRIES_ENV_VAR}; rename it or unset "${key}".`,
            );
        }
    }
}

function parseArguments(argv) {
    const options = {};
    for (const argument of argv) {
        const match =
            /^--(days|lockfile|registry|first-party-registry)=(.+)$/.exec(
                argument,
            );
        if (!match) {
            throw new Error(
                `Unrecognized argument "${argument}". Usage: check-dependency-age.mjs [--days=N] [--lockfile=PATH] [--registry=URL] [--first-party-registry=URL,URL,...]`,
            );
        }
        options[match[1]] = match[2];
    }
    return options;
}

function resolveQuarantineDays(options) {
    const raw =
        options.days ??
        process.env['EZCLASSIFY_DEPENDENCY_AGE_DAYS'] ??
        String(DEFAULT_QUARANTINE_DAYS);
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) {
        throw new Error(
            `Quarantine window must be a non-negative number of days, got "${raw}".`,
        );
    }
    return days;
}

function resolveLockfilePath(options) {
    const raw =
        options.lockfile ??
        process.env['EZCLASSIFY_DEPENDENCY_AGE_LOCKFILE'] ??
        resolve(repositoryRoot, 'package-lock.json');
    return resolve(raw);
}

function resolveDefaultRegistry(options) {
    const raw =
        options.registry ??
        process.env['EZCLASSIFY_DEPENDENCY_AGE_REGISTRY'] ??
        DEFAULT_REGISTRY;
    return raw.replace(/\/+$/, '');
}

/**
 * Registries trusted to serve `@ezclassify/*`, as a set of origins, the one npm
 * is configured with first.
 *
 * Seeded from whatever `@ezclassify:registry` currently resolves to in npm
 * config plus `KNOWN_FIRST_PARTY_REGISTRIES`. Tests override this with the
 * env/flag form so they never depend on the host's npm config or spawn a
 * subprocess.
 *
 * Public npm is a valid first-party origin when npm resolves the scope there.
 * An explicit allowlist still replaces npm configuration, and matching the
 * package name alone never exempts a different resolved origin.
 */
function resolveFirstPartyRegistries(options) {
    const raw =
        options['first-party-registry'] ??
        process.env[FIRST_PARTY_REGISTRIES_ENV_VAR];
    const candidates = raw
        ? raw
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : [
              readConfiguredFirstPartyRegistry(),
              ...KNOWN_FIRST_PARTY_REGISTRIES,
          ].filter((entry) => typeof entry === 'string');
    const origins = new Set();
    for (const candidate of candidates) {
        const origin = registryOf(candidate, null);
        if (origin === null) continue;
        origins.add(origin);
    }
    return origins;
}

/**
 * Follow npm's scope registry, falling back to its general registry when the
 * scope has no override. An unavailable npm config lookup leaves only the
 * explicitly known first-party origins.
 */
function readConfiguredFirstPartyRegistry() {
    try {
        for (const key of ['@ezclassify:registry', 'registry']) {
            const value = execFileSync('npm', ['config', 'get', key], {
                encoding: 'utf8',
            }).trim();
            if (value && value !== 'undefined' && value !== 'null')
                return value;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Collect the registry packages a lockfile would install that are not
 * first-party, keyed by `name@version` so a package pinned at two versions is
 * checked at both.
 *
 * Skips the root entry, workspace packages and links, and git or file
 * dependencies. `resolved` is consulted only for the registry origin, never as
 * a filter: a lockfile written with `--package-lock-only` omits it on many
 * entries, and skipping those would drop them from the check.
 *
 * A first-party entry is exempt only when it is served by a trusted first-party
 * registry. `deps:relock` strips `resolved` from every first-party entry, so an
 * `@ezclassify/*` entry with no origin is taken to come from the first trusted
 * registry, the one npm resolves the scope through, and is exempt without a
 * request. An `@ezclassify/*` entry whose `resolved` names any other origin is
 * held to the window like any third-party package. When no trusted registry is
 * known, the fallback is the third-party registry, which must still match a
 * trusted first-party origin for the entry to be exempted.
 */
function collectThirdPartyPackages(
    lockfile,
    defaultRegistry,
    firstPartyRegistries,
) {
    const entries = new Map();
    const firstPartyFallbackRegistry =
        [...firstPartyRegistries][0] ?? defaultRegistry;
    for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
        // The root entry, workspace packages (no `node_modules/` segment) and
        // links all describe local code.
        if (path === '' || entry.link === true) continue;
        if (!path.includes('node_modules/')) continue;
        if (typeof entry.version !== 'string') continue;
        const name = entry.name ?? nameFromLockfilePath(path);
        if (!name) continue;
        const isFirstPartyName = name.startsWith(FIRST_PARTY_PREFIX);
        const registry = registryOf(
            entry.resolved,
            isFirstPartyName ? firstPartyFallbackRegistry : defaultRegistry,
        );
        // A git, file, or link dependency has no registry to ask.
        if (registry === null) continue;
        if (isFirstPartyName && firstPartyRegistries.has(registry)) continue;
        entries.set(`${name}@${entry.version}`, {
            name,
            version: entry.version,
            registry,
        });
    }
    return [...entries.values()];
}

/**
 * Registry origin for a lockfile entry: the origin of its `resolved` tarball
 * when present, otherwise the configured default. Returns null for a non-http
 * source, which has no registry to query.
 */
function registryOf(resolved, defaultRegistry) {
    if (typeof resolved !== 'string') return defaultRegistry;
    let url;
    try {
        url = new URL(resolved);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
}

/**
 * Recover a package name from a lockfile path such as
 * `node_modules/a/node_modules/@scope/b`. The last `node_modules/` segment
 * wins, so a nested copy reports its own name rather than its parent's.
 */
function nameFromLockfilePath(path) {
    const marker = 'node_modules/';
    const index = path.lastIndexOf(marker);
    if (index < 0) return null;
    return path.slice(index + marker.length);
}

/**
 * Fetch a package's publish times from its registry.
 *
 * Asks for the full packument: the abbreviated install document npm normally
 * uses omits per-version timestamps, which are the whole point here.
 */
async function fetchPublishTimes(registry, name, deadline) {
    const url = `${registry}/${name.replace('/', '%2f')}`;
    let response;
    try {
        response = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.any([
                AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                deadline,
            ]),
        });
    } catch (cause) {
        throw new Error(
            `Could not reach ${registry} to check the publish date of ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
    }
    if (!response.ok) {
        throw new Error(
            `${registry} answered ${response.status} for ${name}; cannot confirm its publish date.`,
        );
    }
    const document = await response.json();
    const times = document?.time;
    if (!times || typeof times !== 'object') {
        throw new Error(
            `${registry} returned no publish times for ${name}; cannot confirm the quarantine window.`,
        );
    }
    return times;
}

async function main() {
    rejectUnrecognizedTrustEnvVars();
    const options = parseArguments(process.argv.slice(2));
    const quarantineDays = resolveQuarantineDays(options);
    const lockfilePath = resolveLockfilePath(options);

    const defaultRegistry = resolveDefaultRegistry(options);
    const firstPartyRegistries = resolveFirstPartyRegistries(options);

    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const packages = collectThirdPartyPackages(
        lockfile,
        defaultRegistry,
        firstPartyRegistries,
    );

    if (quarantineDays === 0) {
        console.log(
            'Dependency quarantine window is 0 days; nothing to check.',
        );
        return;
    }

    const cutoff = Date.now() - quarantineDays * MILLISECONDS_PER_DAY;
    const timesByPackage = new Map();
    const violations = [];
    const unknown = [];
    const overall = new AbortController();
    const timer = setTimeout(
        () => overall.abort(new Error('overall time limit reached')),
        OVERALL_TIMEOUT_MS,
    );
    timer.unref();

    for (const entry of packages) {
        if (overall.signal.aborted) {
            console.error(
                `Dependency quarantine: the run passed its ${OVERALL_TIMEOUT_MS} ms bound before ${entry.name}@${entry.version} was checked.`,
            );
            unknown.push(entry);
            continue;
        }
        const cacheKey = `${entry.registry} ${entry.name}`;
        if (!timesByPackage.has(cacheKey)) {
            // A single unreachable package must not discard every violation
            // already found in this loop: route the failure into the same
            // `unknown` bucket used for a missing publish date, and keep
            // going. `main()`'s own top-level `.catch` remains the backstop
            // for anything unrelated to a single package lookup.
            let times;
            try {
                times = await fetchPublishTimes(
                    entry.registry,
                    entry.name,
                    overall.signal,
                );
            } catch (cause) {
                console.error(
                    cause instanceof Error ? cause.message : String(cause),
                );
                unknown.push(entry);
                timesByPackage.set(cacheKey, null);
                continue;
            }
            timesByPackage.set(cacheKey, times);
        }
        const times = timesByPackage.get(cacheKey);
        if (times === null) {
            // A previous entry sharing this (registry, name) already failed
            // to fetch; every version of that package is unknown, not just
            // the one that triggered the fetch.
            unknown.push(entry);
            continue;
        }
        const published = times[entry.version];
        if (typeof published !== 'string') {
            unknown.push(entry);
            continue;
        }
        const publishedAt = Date.parse(published);
        if (Number.isNaN(publishedAt)) {
            unknown.push(entry);
            continue;
        }
        if (publishedAt > cutoff) {
            violations.push({
                ...entry,
                published,
                clears: new Date(
                    publishedAt + quarantineDays * MILLISECONDS_PER_DAY,
                ).toISOString(),
            });
        }
    }
    clearTimeout(timer);

    if (unknown.length > 0) {
        for (const entry of unknown) {
            console.error(
                `Dependency quarantine: ${entry.registry} reports no publish date for ${entry.name}@${entry.version}.`,
            );
        }
        process.exitCode = 1;
    }

    if (violations.length > 0) {
        console.error(
            `Dependency quarantine: ${violations.length} third-party package(s) were published less than ${quarantineDays} day(s) ago.`,
        );
        for (const violation of violations) {
            console.error(
                `  ${violation.name}@${violation.version} published ${violation.published}, clears ${violation.clears}`,
            );
        }
        console.error(
            'Wait out the window, or pin an older version, before taking these in.',
        );
        process.exitCode = 1;
    }

    if (process.exitCode) return;

    console.log(
        `Dependency quarantine passed: ${packages.length} third-party package(s) are all older than ${quarantineDays} day(s).`,
    );
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
