/**
 * Contract tests for check-dependency-age.mjs, the third-party publish-date
 * quarantine.
 *
 * Hermetic: the guard is pointed at a throwaway lockfile whose `resolved` URLs
 * name a local http server standing in for a registry, so no test reaches the
 * network.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = resolve(repositoryRoot, 'scripts/check-dependency-age.mjs');

const DAY_MS = 86_400_000;
const publishTimes: Record<string, Record<string, string>> = {};

let server: Server;
let registry: string;

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * DAY_MS).toISOString();
}

beforeAll(async () => {
    server = createServer((req, res) => {
        const name = decodeURIComponent((req.url ?? '/').slice(1));
        if (name.startsWith('stalled-')) {
            // Accepts the request and never answers, until the test ends.
            res.on('close', () => undefined);
            return;
        }
        const times = publishTimes[name];
        if (!times) {
            res.writeHead(404).end('{}');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, time: times }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('fake registry did not bind a port');
    registry = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((done, fail) =>
        server.close((err) => (err ? fail(err) : done())),
    );
});

/**
 * Write a lockfile naming the given packages and return its path. Each entry is
 * `[name, version]`; `resolved` points at the fake registry.
 */
function lockfileWith(entries: Array<[string, string]>): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'ezclassify-dependency-age-'));
    const packages: Record<string, unknown> = {
        '': { name: 'fixture', version: '1.0.0' },
    };
    for (const [name, version] of entries) {
        packages[`node_modules/${name}`] = {
            version,
            resolved: `${registry}/${name}/-/${name}-${version}.tgz`,
        };
    }
    const path = resolve(dir, 'package-lock.json');
    writeFileSync(
        path,
        JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }),
    );
    return path;
}

/** Write a lockfile with the given `packages` entries and return its path. */
function lockfileAt(entries: Record<string, unknown>): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'ezclassify-dependency-age-'));
    const path = resolve(dir, 'package-lock.json');
    writeFileSync(
        path,
        JSON.stringify({
            name: 'fixture',
            lockfileVersion: 3,
            packages: {
                '': { name: 'fixture', version: '1.0.0' },
                ...entries,
            },
        }),
    );
    return path;
}

/**
 * Run the guard against a lockfile.
 *
 * Asynchronous on purpose: the fake registry is served from this same process,
 * so a synchronous spawn would block the event loop and the guard's fetch would
 * never be answered.
 */
function run(
    lockfile: string,
    envOverrides: Record<string, string> = {},
): Promise<{ status: number; output: string }> {
    return new Promise((settle) => {
        execFile(
            process.execPath,
            [guard],
            {
                cwd: repositoryRoot,
                env: {
                    ...process.env,
                    EZCLASSIFY_DEPENDENCY_AGE_LOCKFILE: lockfile,
                    EZCLASSIFY_DEPENDENCY_AGE_REGISTRY: registry,
                    // Declares the fake registry as first-party by default so
                    // most tests can exercise the exemption without touching
                    // the host's npm config. The impostor-registry test
                    // overrides this to a registry the entry does NOT
                    // resolve from, which is the case the exemption must
                    // reject.
                    EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES: registry,
                    ...envOverrides,
                },
                encoding: 'utf8',
            },
            (error, stdout, stderr) => {
                const status =
                    error === null
                        ? 0
                        : ((error as { code?: number }).code ?? 1);
                settle({ status, output: `${stdout}${stderr}` });
            },
        );
    });
}

describe('third-party dependency quarantine guard', () => {
    it('accepts a third-party package published outside the window', async () => {
        publishTimes['settled-lib'] = { '1.2.3': isoDaysAgo(30) };
        const result = await run(lockfileWith([['settled-lib', '1.2.3']]));
        expect(result.status).toBe(0);
        expect(result.output).toContain('Dependency quarantine passed');
    });

    it('rejects a third-party package published inside the window', async () => {
        publishTimes['fresh-lib'] = { '9.9.9': isoDaysAgo(1) };
        const result = await run(lockfileWith([['fresh-lib', '9.9.9']]));
        expect(result.status).toBe(1);
        expect(result.output).toContain('fresh-lib@9.9.9');
        expect(result.output).toContain('published less than 7 day(s) ago');
    });

    it('exempts first-party packages, the case npm could not express', async () => {
        // The whole reason this guard exists instead of `min-release-age`:
        // a package we published seconds ago must still install.
        publishTimes['@ezclassify/rest-client'] = {
            '1.0.0': new Date().toISOString(),
        };
        const result = await run(
            lockfileWith([['@ezclassify/rest-client', '1.0.0']]),
        );
        expect(result.status).toBe(0);
        expect(result.output).toContain('Dependency quarantine passed');
    });

    it('does NOT exempt an @ezclassify/*-named package served from a non-first-party registry', async () => {
        // Exemption requires both a first-party package name and a trusted
        // registry origin. A matching name from an untrusted registry remains
        // subject to quarantine.
        publishTimes['@ezclassify/engine'] = {
            '9.9.9': new Date().toISOString(),
        };
        const result = await run(
            lockfileWith([['@ezclassify/engine', '9.9.9']]),
            // Declares a DIFFERENT registry as first-party, so the fake
            // server this entry resolves from is not on the allowlist.
            {
                EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES:
                    'https://npm.pkg.github.com',
            },
        );
        expect(result.status).toBe(1);
        expect(result.output).toContain('@ezclassify/engine@9.9.9');
        expect(result.output).toContain('published less than 7 day(s) ago');
    });

    it('exempts a first-party entry with no resolved URL without asking any registry', async () => {
        // `deps:relock` strips `resolved` from every first-party entry, so
        // this is the ordinary shape of one. It is taken to come from the
        // registry npm resolves the scope through, which the guard trusts,
        // so it is exempt without a request: the fake registry knows no
        // such package and would answer 404.
        const result = await run(
            lockfileAt({
                'node_modules/@ezclassify/types': { version: '1.0.0' },
            }),
        );
        expect(result.status).toBe(0);
        expect(result.output).toContain('Dependency quarantine passed');
    });

    it('exempts a first-party entry when public npm is the configured scope registry', async () => {
        // A normalized lock entry uses the configured first-party origin.
        // The fake default registry keeps a refusal observable without any
        // public npm request.
        publishTimes['@ezclassify/fresh'] = {
            '1.0.0': new Date().toISOString(),
        };
        const result = await run(
            lockfileAt({
                'node_modules/@ezclassify/fresh': { version: '1.0.0' },
            }),
            {
                EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES:
                    'https://registry.npmjs.org',
            },
        );
        expect(result.status).toBe(0);
        expect(result.output).toContain('Dependency quarantine passed');

        const pinned = await run(
            lockfileAt({
                'node_modules/@ezclassify/fresh': {
                    version: '1.0.0',
                    resolved:
                        'https://registry.npmjs.org/@ezclassify/fresh/-/fresh-1.0.0.tgz',
                },
            }),
            {
                EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES:
                    'https://registry.npmjs.org',
            },
        );
        expect(pinned.status).toBe(0);
        const npmDirectory = mkdtempSync(
            resolve(tmpdir(), 'ezclassify-npm-config-'),
        );
        const npm = resolve(npmDirectory, 'npm');
        writeFileSync(
            npm,
            `#!/bin/sh\nif [ "$3" = "@ezclassify:registry" ]; then echo undefined; else echo ${registry}; fi\n`,
        );
        chmodSync(npm, 0o755);
        const defaultRegistry = await run(
            lockfileAt({
                'node_modules/@ezclassify/fresh': {
                    version: '1.0.0',
                    resolved: `${registry}/@ezclassify/fresh/-/fresh-1.0.0.tgz`,
                },
            }),
            {
                EZCLASSIFY_DEPENDENCY_AGE_FIRST_PARTY_REGISTRIES: '',
                PATH: `${npmDirectory}:${process.env.PATH}`,
            },
        );
        expect(defaultRegistry.status).toBe(0);
        expect(defaultRegistry.output).toContain(
            'Dependency quarantine passed',
        );
    });

    it('checks entries that carry no resolved URL', async () => {
        // `npm install --package-lock-only` (what `deps:relock` runs) omits
        // `resolved` on most entries. Treating a missing `resolved` as
        // "not a registry package" skipped the majority of the real tree.
        publishTimes['lock-only-lib'] = { '3.0.0': isoDaysAgo(1) };
        const dir = mkdtempSync(
            resolve(tmpdir(), 'ezclassify-dependency-age-'),
        );
        const path = resolve(dir, 'package-lock.json');
        writeFileSync(
            path,
            JSON.stringify({
                name: 'fixture',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'fixture', version: '1.0.0' },
                    'libs/demo': { name: 'demo', version: '1.0.0' },
                    'libs/demo/node_modules/lock-only-lib': {
                        version: '3.0.0',
                    },
                },
            }),
        );
        const result = await run(path);
        expect(result.status).toBe(1);
        expect(result.output).toContain('lock-only-lib@3.0.0');
    });

    it('fails when the registry reports no publish date for a version', async () => {
        publishTimes['silent-lib'] = { '1.0.0': isoDaysAgo(30) };
        const result = await run(lockfileWith([['silent-lib', '2.0.0']]));
        expect(result.status).toBe(1);
        expect(result.output).toContain('no publish date for silent-lib@2.0.0');
    });

    it('fails loudly when the registry cannot be reached', async () => {
        // Points at a port nothing is listening on: an unreachable registry
        // must be an error, never a silent pass.
        const unreachable = lockfileWith([]);
        writeFileSync(
            unreachable,
            JSON.stringify({
                name: 'fixture',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'fixture', version: '1.0.0' },
                    'node_modules/settled-lib': {
                        version: '1.2.3',
                        resolved:
                            'http://127.0.0.1:1/settled-lib/-/settled-lib-1.2.3.tgz',
                    },
                },
            }),
        );
        const result = await run(unreachable);
        expect(result.status).toBe(1);
        expect(result.output).toContain('Could not reach http://127.0.0.1:1');
    });

    it('still reports a real violation found alongside an unreachable package', async () => {
        // An unreachable entry listed first must not discard the genuine
        // violation from the reachable entry that follows it.
        publishTimes['fresh-lib'] = { '9.9.9': isoDaysAgo(1) };
        const dir = mkdtempSync(
            resolve(tmpdir(), 'ezclassify-dependency-age-'),
        );
        const path = resolve(dir, 'package-lock.json');
        writeFileSync(
            path,
            JSON.stringify({
                name: 'fixture',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'fixture', version: '1.0.0' },
                    'node_modules/unreachable-lib': {
                        version: '1.0.0',
                        resolved:
                            'http://127.0.0.1:1/unreachable-lib/-/unreachable-lib-1.0.0.tgz',
                    },
                    'node_modules/fresh-lib': {
                        version: '9.9.9',
                        resolved: `${registry}/fresh-lib/-/fresh-lib-9.9.9.tgz`,
                    },
                },
            }),
        );
        const result = await run(path);
        expect(result.status).toBe(1);
        expect(result.output).toContain('Could not reach http://127.0.0.1:1');
        expect(result.output).toContain('fresh-lib@9.9.9');
        expect(result.output).toContain('published less than 7 day(s) ago');
    });

    it('says when each refused release clears the window', async () => {
        const published = new Date(Date.now() - 2 * DAY_MS);
        publishTimes['clearing-lib'] = { '1.0.0': published.toISOString() };
        const result = await run(lockfileWith([['clearing-lib', '1.0.0']]));
        const clears = new Date(published.getTime() + 7 * DAY_MS).toISOString();
        expect(result.status).toBe(1);
        expect(result.output).toContain(`clears ${clears}`);
    });

    it('fails once the overall bound passes instead of waiting on a stalled registry', async () => {
        publishTimes['quick-lib'] = { '1.0.0': isoDaysAgo(30) };
        const started = Date.now();
        const result = await run(
            lockfileWith([
                ['stalled-lib', '1.0.0'],
                ['quick-lib', '1.0.0'],
            ]),
            { EZCLASSIFY_DEPENDENCY_AGE_OVERALL_TIMEOUT_MS: '500' },
        );
        expect(result.status).toBe(1);
        expect(result.output).toContain('stalled-lib@1.0.0');
        expect(Date.now() - started).toBeLessThan(10_000);
    });
});
