import { afterEach, describe, expect, it } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditInstalledPublicDeps } from './check-installed-public-deps.mjs';

const roots: string[] = [];

function fixture(...packagePaths: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'sdk-js-public-deps-'));
    roots.push(root);
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const packagePath of packagePaths) {
        const parts = packagePath.split('/');
        let parent = join(root, 'node_modules');
        for (let index = 0; index < parts.length;) {
            if (parts[index] === 'node_modules') {
                parent = join(parent, 'node_modules');
                index++;
                continue;
            }
            const name = parts[index].startsWith('@')
                ? `${parts[index]}/${parts[index + 1]}`
                : parts[index];
            parent = join(parent, name);
            mkdirSync(parent, { recursive: true });
            writeFileSync(
                join(parent, 'package.json'),
                JSON.stringify({ name }),
            );
            index += name.startsWith('@') ? 2 : 1;
        }
    }
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('installed public dependency gate', () => {
    it('accepts the five public contracts packages at root and nested locations', () => {
        const root = fixture(
            '@ezclassify/types',
            '@ezclassify/tsconfig',
            'some-package/node_modules/@ezclassify/conformance',
            'some-package/node_modules/@ezclassify/conformance-server',
            'some-package/node_modules/@ezclassify/openapi',
        );
        expect(auditInstalledPublicDeps(root)).toEqual([]);
    });

    it('rejects a private package at the root of node_modules', () => {
        const root = fixture('@ezclassify/engine');
        expect(auditInstalledPublicDeps(root)).toEqual([
            'node_modules/@ezclassify/engine',
        ]);
    });

    it('rejects a private transitive package nested under an allowed package', () => {
        const root = fixture(
            '@ezclassify/conformance-server/node_modules/@ezclassify/engine',
        );
        expect(auditInstalledPublicDeps(root)).toEqual([
            'node_modules/@ezclassify/conformance-server/node_modules/@ezclassify/engine',
        ]);

        const script = fileURLToPath(
            new URL('./check-installed-public-deps.mjs', import.meta.url),
        );
        const cli = spawnSync(process.execPath, [script], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(cli.status).toBe(1);
        expect(cli.stderr).toContain(
            'node_modules/@ezclassify/conformance-server/node_modules/@ezclassify/engine',
        );
    });

    it('does not mistake a different npm scope for @ezclassify', () => {
        const root = fixture('@ezclassify-test/engine');
        expect(auditInstalledPublicDeps(root)).toEqual([]);
    });

    it('rejects an aliased private package under an unscoped directory', () => {
        const root = fixture('safe-name');
        writeFileSync(
            join(root, 'node_modules/safe-name/package.json'),
            JSON.stringify({ name: '@ezclassify/engine' }),
        );
        expect(auditInstalledPublicDeps(root)).toEqual([
            'node_modules/safe-name (package name @ezclassify/engine)',
        ]);
    });

    it('fails closed on a missing installed package manifest', () => {
        const root = fixture('ordinary');
        rmSync(join(root, 'node_modules/ordinary/package.json'));
        expect(() => auditInstalledPublicDeps(root)).toThrow(/package\.json/);
    });

    it('fails closed when no installed tree exists', () => {
        const root = mkdtempSync(join(tmpdir(), 'sdk-js-public-deps-'));
        roots.push(root);
        expect(() => auditInstalledPublicDeps(root)).toThrow(/node_modules/);
    });

    it('is called by the CI installed-dependency gate', () => {
        const workflow = readFileSync(
            new URL('../.github/workflows/ci.yml', import.meta.url),
            'utf8',
        );
        expect(workflow).toContain(
            'run: node scripts/check-installed-public-deps.mjs',
        );
    });
});
