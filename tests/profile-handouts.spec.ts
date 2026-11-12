/**
 * What the synchronous accessors hand out of the cached profile.
 *
 * Every caller of `getScheme()`, `findConcept()`, `getConceptsInCategory()` and
 * `listCategories()` shares one profile. Anything they return that a caller
 * could edit would let one component change the answer for every other, so the
 * profile is frozen when it is installed and the lists the accessors build are
 * the caller's own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EzClassifyClient } from '../src/ezclassify-client';
import { connectContext } from '../src/connect';
import { mockResponse, stubFetch } from './fetch-mock';
import { corpusBody } from './contract-fixtures';

const RESOURCES: Array<[suffix: string, caseId: string]> = [
    ['/scheme/concepts', 'ctx-scheme-concepts.full'],
    ['/scheme/categories', 'ctx-scheme-categories.full'],
    ['/scheme/formats', 'ctx-scheme-formats.full'],
    ['/scheme/grammar', 'ctx-scheme-grammar.full'],
    ['/scheme/scopes', 'ctx-scheme-scopes.full'],
    ['/scheme/label-presets', 'ctx-scheme-label-presets.full'],
    ['/scheme', 'ctx-scheme-summary.full'],
];

describe('the profile accessors hand out nothing a caller can change', () => {
    let client: EzClassifyClient;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        const fetchMock = stubFetch();
        fetchMock.mockImplementation((url: string) => {
            const path = url.split('?')[0] ?? '';
            const resource = RESOURCES.find(([suffix]) =>
                path.endsWith(suffix),
            );
            const payload = resource
                ? corpusBody(resource[1])
                : path.endsWith('/v1/health')
                  ? { status: 'ok' }
                  : corpusBody('ctx-describe.ok');
            return Promise.resolve(mockResponse(200, JSON.stringify(payload)));
        });
        client = await connectContext({
            baseUrl: 'https://api.example.com',
            contextId: 'ez-full',
            contextVersion: '1.0.0',
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        client.destroy();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('freezes the profile and everything in it', () => {
        const profile = client.scheme.getScheme();
        expect(Object.isFrozen(profile)).toBe(true);
        expect(Object.isFrozen(profile.concepts)).toBe(true);
        expect(Object.isFrozen(profile.concepts[0])).toBe(true);
        expect(() => {
            (profile as { name: string }).name = 'changed';
        }).toThrow(TypeError);
    });

    it('refuses an edit to a concept listed in a category', () => {
        const [first] = client.scheme.getConceptsInCategory('level');
        expect(first).toBeDefined();
        expect(() => {
            (first as { name: string }).name = 'changed';
        }).toThrow(TypeError);
    });

    it('gives each caller its own list of concepts and of categories', () => {
        const concepts = client.scheme.getConceptsInCategory('level');
        concepts.pop();
        expect(client.scheme.getConceptsInCategory('level')).toHaveLength(
            concepts.length + 1,
        );

        const categories = client.scheme.listCategories();
        const before = categories.length;
        categories.pop();
        expect(client.scheme.listCategories()).toHaveLength(before);
        // The caller's list is its own to sort or filter in place.
        expect(() => client.scheme.listCategories().reverse()).not.toThrow();
    });

    it('keeps the metadata view editable without touching the profile', () => {
        const meta = client.scheme.getSchemeMeta();
        meta.name = 'changed';
        expect(client.scheme.getSchemeMeta().name).not.toBe('changed');
        expect(client.scheme.getScheme().name).not.toBe('changed');
    });
});
