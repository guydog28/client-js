// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

/**
 * What the published tarball promises a consumer, checked against what this
 * repository actually declares.
 *
 * Every emitted `.d.ts` re-exports types from `@ezclassify/types`. A type-only
 * import is still a real dependency when the types are re-exported across the
 * package boundary. TypeScript resolves it from the consumer's tree, so it has
 * to be installed there.
 */
const ROOT = path.resolve(__dirname, '..');

interface PackageManifest {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    files?: string[];
    exports?: Record<string, Record<string, string>>;
    repository?: { url?: string };
}

const pkg = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as PackageManifest;

/**
 * Collect every `.ts` file under a directory, recursively.
 *
 * @param dir - Directory to walk.
 * @returns Absolute paths of every TypeScript file found.
 */
function typeScriptFilesIn(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...typeScriptFilesIn(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

/**
 * Every distinct `@ezclassify/*` package name imported anywhere under `src/`,
 * whether the import is type-only or not.
 *
 * Comments are stripped first: the JSDoc on `connectContext` contains a usage
 * example that imports this package by its own name, and a naive scan reads
 * that as a self-dependency.
 *
 * @returns Sorted package names.
 */
function ezclassifyImportsInSrc(): string[] {
    const found = new Set<string>();
    for (const file of typeScriptFilesIn(path.join(ROOT, 'src'))) {
        const source = readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const match of source.matchAll(/from\s+'(@ezclassify\/[^'/]+)/g)) {
            found.add(match[1]);
        }
    }
    return [...found].sort();
}

describe('published package manifest', () => {
    const imported = ezclassifyImportsInSrc();

    it('imports at least one @ezclassify package from src (the check has something to check)', () => {
        // Without this the loop below would pass over an empty set and this
        // whole file would be a control that inspects nothing.
        expect(imported.length).toBeGreaterThan(0);
    });

    it.each(imported)(
        'declares %s as an installed dependency, not a devDependency',
        (name) => {
            const runtime =
                pkg.dependencies?.[name] ?? pkg.peerDependencies?.[name];
            expect(
                runtime,
                `${name} is imported by src/ and therefore appears in the ` +
                    `emitted .d.ts files. It must be in "dependencies" or ` +
                    `"peerDependencies" so a consumer installs it; a ` +
                    `devDependency resolves here and nowhere else.`,
            ).toBeTypeOf('string');
        },
    );

    it('never declares the same @ezclassify package twice', () => {
        for (const name of imported) {
            const inDev = pkg.devDependencies?.[name];
            expect(
                inDev,
                `${name} is declared in both dependencies and devDependencies`,
            ).toBeUndefined();
        }
    });

    it('ships build output, the runnable onboarding example and legal files', () => {
        expect(pkg.files).toEqual([
            'dist/',
            'examples/first-app/',
            'README.md',
            'LICENSE',
            '!dist/**/*.map',
        ]);
    });

    it('points every export condition inside dist/, which files/ ships', () => {
        const root = pkg.exports?.['.'];
        expect(root, 'exports["."]').toBeTypeOf('object');
        for (const [condition, target] of Object.entries(root ?? {})) {
            expect(target, `exports["."].${condition}`).toMatch(/^\.\/dist\//);
        }
    });

    it('names itself in every warning it prints, by the name a consumer installed', () => {
        const warnings: string[] = [];
        for (const file of typeScriptFilesIn(path.join(ROOT, 'src'))) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(
                /console\.warn\(\s*`([^`]*)/g,
            )) {
                warnings.push(match[1]);
            }
        }
        // A consumer greps its logs for the package it installed, so the one
        // identifier every warning carries has to be that name.
        expect(warnings.length).toBeGreaterThanOrEqual(4);
        for (const warning of warnings) {
            expect(warning.startsWith(`${pkg.name}: `), warning).toBe(true);
        }
    });

    it('names its own repository, not the one it was extracted from', () => {
        expect(pkg.repository?.url).toBe(
            'git+https://github.com/ezclassify/sdk-js.git',
        );
    });
});
