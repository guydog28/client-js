// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import semver from 'semver';
import { load } from 'js-yaml';
// @ts-expect-error - plain ESM script, no type declarations
import { auditMirrorPublish } from './check-mirror-publish.mjs';

/**
 * The guard that stands between this package and an unusable mirror publish.
 *
 * The failure it exists for is quiet: a first-party dependency written "^1.0.0"
 * resolves to a workspace link here and matches nothing on the mirror, because
 * npm will not match 1.0.0-mirror.N against a range that names no prerelease.
 * The publish succeeds, the tarball looks correct, and the next repository that
 * installs it fails with ETARGET on a dependency it never edited.
 */
const ROOT = path.resolve(__dirname, '..');

interface Manifest {
    name: string;
    version: string;
    private?: boolean;
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
}

/**
 * Writes a manifest into a throwaway directory and audits it.
 *
 * @param manifest - The package.json contents under test.
 * @returns The audit result for that manifest.
 */
function audit(manifest: Manifest): {
    problems: string[];
    name: string;
    version: string;
} {
    const root = mkdtempSync(path.join(tmpdir(), 'mirror-publish-'));
    writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
    );
    return auditMirrorPublish({ root }) as {
        problems: string[];
        name: string;
        version: string;
    };
}

const base: Manifest = {
    name: '@ezclassify/rest-client',
    version: '1.0.0-mirror.12',
    dependencies: { '@ezclassify/types': '^1.0.0-0' },
    devDependencies: { typescript: '5.9.3' },
};

describe('the mirror publish guard', () => {
    it('passes the manifest this repository actually ships', () => {
        const { problems, name } = auditMirrorPublish({ root: ROOT }) as {
            problems: string[];
            name: string;
        };
        expect(problems).toEqual([]);
        expect(name).toBe('@ezclassify/rest-client');
    });

    it('accepts a stamped manifest whose first-party ranges name a prerelease', () => {
        expect(audit(base).problems).toEqual([]);
    });

    it('rejects a first-party range that excludes every mirror version', () => {
        const { problems } = audit({
            ...base,
            dependencies: { '@ezclassify/types': '^1.0.0' },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('@ezclassify/types');
        expect(problems[0]).toContain('^1.0.0-0');
    });

    it('rejects the exact prerelease floor, which does not match a mirror build', () => {
        expect(semver.satisfies('1.0.0-mirror.12', '1.0.0-0')).toBe(false);
        expect(semver.satisfies('1.0.0-mirror.12', '^1.0.0-0')).toBe(true);

        const { problems } = audit({
            ...base,
            dependencies: { '@ezclassify/types': '1.0.0-0' },
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('dependencies.@ezclassify/types');
    });

    it('checks every dependency field, not just runtime dependencies', () => {
        const { problems } = audit({
            ...base,
            devDependencies: { '@ezclassify/conformance': '1.0.0' },
            peerDependencies: { '@ezclassify/tsconfig': '^1.0.0' },
            optionalDependencies: { '@ezclassify/openapi': '~1.0.0-0' },
        });
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toContain(
            'devDependencies.@ezclassify/conformance',
        );
        expect(problems.join('\n')).toContain(
            'peerDependencies.@ezclassify/tsconfig',
        );
        expect(problems.join('\n')).toContain(
            'optionalDependencies.@ezclassify/openapi',
        );
    });

    it('leaves third-party ranges alone', () => {
        const { problems } = audit({
            ...base,
            devDependencies: { vitest: '^4.1.1', typescript: '5.9.3' },
        });
        expect(problems).toEqual([]);
    });

    it('fails when the version stamp did not reach the manifest', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'mirror-publish-'));
        writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ ...base, version: '1.0.0-dev.0' }, null, 2),
            'utf8',
        );
        const { problems } = auditMirrorPublish({
            root,
            expectVersion: '1.0.0-mirror.12',
        }) as { problems: string[] };
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('1.0.0-dev.0');
        expect(problems[0]).toContain('1.0.0-mirror.12');
    });

    it('accepts the manifest once the stamp has landed', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'mirror-publish-'));
        writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify(base, null, 2),
            'utf8',
        );
        const { problems } = auditMirrorPublish({
            root,
            expectVersion: '1.0.0-mirror.12',
        }) as { problems: string[] };
        expect(problems).toEqual([]);
    });

    it('refuses a repository that grew workspaces the workflow cannot see', () => {
        const { problems } = audit({ ...base, workspaces: ['libs/*'] });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('publish-mirror.yml');
    });

    it('refuses a private package', () => {
        const { problems } = audit({ ...base, private: true });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('private');
    });
});

describe('the workflow that runs the guard', () => {
    const workflow = readFileSync(
        path.join(ROOT, '.github/workflows/publish-mirror.yml'),
        'utf8',
    );

    it('checks the stamped version, not the committed one', () => {
        const check = workflow.indexOf('scripts/check-mirror-publish.mjs');
        const stamp = workflow.indexOf('Stamp mirror version');
        const publish = workflow.indexOf('Publish to GitHub Packages');
        expect(stamp).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(stamp);
        expect(publish).toBeGreaterThan(check);
        expect(workflow).toContain('--expect-version');
    });

    it('publishes only the prerelease stream the mirror is allowed to carry', () => {
        expect(workflow).toContain('1.0.0-mirror.${{ github.run_number }}');
        expect(workflow).toContain('npm publish --tag dev --access restricted');
    });

    it('runs after the contracts mirror it installs from', () => {
        // contracts publishes at 05:45 UTC, so this slot comes after it.
        expect(workflow).toContain("cron: '10 6 * * *'");
    });
});

/**
 * The consuming half of the same arrangement.
 *
 * This repository publishes to the mirror and installs from it, and the second
 * half is the one that breaks quietly. The mirror is where prerelease builds of
 * the five contracts packages live, so an install that is not routed at it ends
 * in a 404 on a package nobody here can fix.
 */
describe('the CI install lane', () => {
    const ci = readFileSync(
        path.join(ROOT, '.github/workflows/ci.yml'),
        'utf8',
    );

    it('routes @ezclassify at the mirror before anything is installed', () => {
        const document = load(ci) as {
            jobs: {
                'build-and-test': {
                    steps: Array<{
                        run?: string;
                        uses?: string;
                        with?: Record<string, string>;
                    }>;
                };
            };
        };
        const steps = document.jobs['build-and-test'].steps;
        const route = steps.findIndex((step) =>
            step.run?.includes(
                '@ezclassify:registry=https://npm.pkg.github.com',
            ),
        );
        const install = steps.findIndex((step) =>
            /^ezclassify\/\.github\/actions\/install-node-dependencies@[a-f0-9]{40}$/.test(
                step.uses ?? '',
            ),
        );
        expect(route).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(route);
        expect(steps[install].with).toMatchObject({
            'mode': 'generated',
            'relock-installs': 'false',
        });
        expect(ci).toContain('NPM_CONFIG_USERCONFIG=$RUNNER_TEMP/ci-npmrc');
    });

    it('gives the install a token, because the mirror refuses anonymous reads', () => {
        expect(ci).toContain('NODE_AUTH_TOKEN:');
        expect(ci).toContain('secrets.EZ_GHPKG_TOKEN');
        expect(ci).toContain('packages: read');
    });

    it('leaves the committed .npmrc carrying the project settings and no registry', () => {
        // The routing is a throwaway user config on the runner. If it ever
        // moves into the tracked .npmrc it takes ignore-scripts with it and
        // every developer inherits a registry they cannot reach.
        const npmrc = readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
        expect(npmrc).toContain('ignore-scripts=true');
        expect(npmrc).not.toContain('npm.pkg.github.com');
    });
});

describe('qualified native mirror publication', () => {
    const workflow = readFileSync(
        path.join(ROOT, '.github/workflows/publish-mirror.yml'),
        'utf8',
    );
    it('requires full source qualification before installation and rechecks before publishing', () => {
        const document = load(workflow) as {
            jobs: {
                publish: { steps: Array<{ name?: string; run?: string }> };
            };
        };
        const steps = document.jobs.publish.steps;
        const first = steps.findIndex(
            (step) =>
                step.run?.includes('require-mirror-qualification.mjs') &&
                !step.run.includes('--recheck'),
        );
        const install = steps.findIndex((step) => step.name === 'Install');
        const recheck = steps.findIndex((step) =>
            step.run?.includes('require-mirror-qualification.mjs --recheck'),
        );
        const publish = steps.findIndex(
            (step) => step.name === 'Publish to GitHub Packages',
        );
        expect(first).toBeGreaterThan(-1);
        expect(install).toBeGreaterThan(first);
        expect(recheck).toBeGreaterThan(install);
        expect(publish).toBe(recheck + 1);
    });
    it('audits the freshly installed public graph before stamp, build, and registry writes', () => {
        const document = load(workflow) as {
            jobs: {
                publish: {
                    steps: Array<{ name?: string; run?: string; if?: string }>;
                };
            };
        };
        const steps = document.jobs.publish.steps;
        const install = steps.findIndex((step) => step.name === 'Install');
        const guards = steps.flatMap((step, index) =>
            step.run === 'node scripts/check-installed-public-deps.mjs'
                ? [index]
                : [],
        );
        expect(guards).toEqual([install + 1]);
        expect(steps[guards[0]].if).toBe("steps.gate.outputs.run == 'yes'");
        for (const name of [
            'Stamp mirror version',
            'Build',
            'Publish to GitHub Packages',
        ]) {
            expect(
                steps.findIndex((step) => step.name === name),
            ).toBeGreaterThan(guards[0]);
        }
    });
    it('uses ephemeral native identity at all three registry boundaries and never relies on an absent PAT', () => {
        const document = load(workflow) as {
            permissions: Record<string, string>;
            jobs: {
                publish: {
                    if: string;
                    steps: Array<{ env?: Record<string, string> }>;
                };
            };
        };
        expect(document.permissions).toMatchObject({
            actions: 'read',
            contents: 'read',
            packages: 'write',
        });
        expect(document.jobs.publish.if).toContain(
            "github.repository == 'ezclassify/sdk-js'",
        );
        expect(document.jobs.publish.if).toContain(
            "github.ref == 'refs/heads/main'",
        );
        const tokens = document.jobs.publish.steps.flatMap((step) =>
            step.env?.NODE_AUTH_TOKEN ? [step.env.NODE_AUTH_TOKEN] : [],
        );
        expect(tokens).toEqual(Array(3).fill('${{ github.token }}'));
        expect(workflow).not.toContain('secrets.EZ_GHPKG_TOKEN');
    });
    it('proves both connection exports in installed CJS, ESM, and declarations', () => {
        expect(workflow).toContain('clientFromConnection');
        expect(workflow).toContain('readClientConnection');
        expect(workflow).toContain(
            'for (const name of ["EzClassifyClient", "clientFromConnection", "readClientConnection"])',
        );
    });
});
