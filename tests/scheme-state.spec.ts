/* eslint-disable @typescript-eslint/no-explicit-any -- these specs inject a
profile straight onto the client to isolate the query logic from the HTTP
layer. */
/**
 * Tests for SchemeState base class profile query methods.
 *
 * SchemeState is abstract: we exercise it through SchemeProfileState, which
 * extends it and provides the concrete _loadProfile() implementation. All tests
 * inject a profile directly via `(c as any)._profile` to isolate the profile
 * query logic from the HTTP layer.
 */
import { describe, it, expect } from 'vitest';
import { SchemeProfileState } from '../src/client-ops';
import { EzClassifyError } from '../src/errors';

/** The formats a scheme profile carries: the wire's format views. */
const FORMATS = [
    {
        id: 'default',
        surface: 'marking',
        mode: 'inline' as const,
        categoryOrder: ['level', 'caveat'],
        separator: '//',
        view: 'default',
        prefix: '[',
        suffix: ']',
        categorySeparators: { caveat: '/' },
        separatorBefore: { caveat: '//' },
        categoryViews: { caveat: 'short' },
        categoryTiers: {
            caveat: [{ tier: 'detail', attachedBy: '-', view: 'short' }],
        },
        categoryEach: { caveat: { prefix: '(', suffix: ')' } },
        headers: [
            {
                concept: 'REL',
                headerCategory: 'caveat',
                category: 'level',
                position: 'prefix' as const,
            },
        ],
        syntax: { type: 'xml-attributes' as const },
    },
];

/**
 * A minimal but realistic profile fixture. Includes two categories with
 * concepts, one category is flat (union rollup), the other is rank-ordered (max
 * rollup) so uncoveredAssertions rank logic gets exercised.
 */
const PROFILE = {
    id: 'test-scheme',
    version: '1.0.0',
    name: 'Test Scheme',
    description: 'Used in scheme-state tests',
    referenceSurfaceLabel: { singular: 'Handbook', plural: 'Handbooks' },
    concepts: [
        {
            id: 'U',
            name: 'Unclassified',
            views: { default: 'U', banner: 'UNCLASSIFIED' },
            aliases: ['unclassified', 'unc'],
            categories: ['level'],
            parents: [],
            position: 0,
            rank: 0,
        },
        {
            id: 'C',
            name: 'Confidential',
            views: { default: 'C', banner: 'CONFIDENTIAL' },
            aliases: ['conf'],
            categories: ['level'],
            parents: ['U'],
            position: 1,
            rank: 1,
        },
        {
            id: 'S',
            name: 'Secret',
            views: { default: 'S', banner: 'SECRET' },
            aliases: [],
            categories: ['level'],
            parents: ['C'],
            position: 2,
            rank: 2,
        },
        {
            id: 'NF',
            name: 'NOFORN',
            views: { default: 'NF' },
            aliases: ['noforn'],
            categories: ['caveat'],
            parents: [],
            position: 0,
            rank: undefined,
        },
        {
            id: 'REL',
            name: 'REL TO',
            views: { default: 'REL' },
            aliases: [],
            categories: ['caveat'],
            parents: [],
            position: 1,
            rank: undefined,
        },
    ],
    categories: [
        {
            id: 'level',
            label: 'Classification Level',
            required: true,
            single: true,
            rollup: 'max' as const,
            position: 0,
            sort: 'position' as const,
        },
        {
            id: 'caveat',
            label: 'Caveats',
            required: false,
            single: false,
            rollup: 'union' as const,
            position: 1,
        },
    ],
    tokens: [],
    normalize: [],
    rollupPipelines: [],
    formats: FORMATS,
    labelPresets: [] as unknown[],
    defaultRenderFormat: 'default',
    parse: { separator: '//', caseSensitive: false, stripWhitespace: true },
};

/** Install a profile the way a fetch does. */
function installProfile(c: SchemeProfileState, view: unknown): void {
    (c as any)._setActiveProfile({ view });
}

/**
 * Build a client with the fixture profile pre-loaded. `overrides` merges extra
 * profile fields for tests that need a shape the base fixture omits (scopes,
 * context formats, label presets).
 */
function clientWithProfile(
    overrides?: Record<string, unknown>,
): SchemeProfileState {
    const c = new SchemeProfileState();
    installProfile(c, { ...PROFILE, ...(overrides ?? {}) });
    return c;
}

// -----------------------------------------------------------------------
// Load / unload state transitions (bookkeeping via _profile / _schemeId)
// -----------------------------------------------------------------------
describe('SchemeState: load/unload bookkeeping', () => {
    it('_profile is null on a fresh client', () => {
        const c = new SchemeProfileState();
        expect((c as any)._profile).toBeNull();
    });

    it('_setActiveProfile stores the profile and invalidates the concept map cache', () => {
        const c = new SchemeProfileState();
        installProfile(c, PROFILE);
        expect((c as any)._profile).toBe(PROFILE);
        // Cache should be cleared after a profile swap
        expect((c as any)._conceptMapCache).toBeNull();
    });

    it('_setActiveProfile(null) clears the profile', () => {
        const c = clientWithProfile();
        (c as any)._setActiveProfile(null);
        expect((c as any)._profile).toBeNull();
        expect(() => c.getScheme()).toThrow(EzClassifyError);
    });

    it('findConcept lazily builds the concept map cache', () => {
        const c = clientWithProfile();
        expect((c as any)._conceptMapCache).toBeNull();
        c.findConcept('U');
        // Cache is populated after the first findConcept call
        expect((c as any)._conceptMapCache).not.toBeNull();
    });

    it('concept map cache is reused on subsequent findConcept calls', () => {
        const c = clientWithProfile();
        c.findConcept('U');
        const cacheAfterFirst = (c as any)._conceptMapCache;
        c.findConcept('C');
        expect((c as any)._conceptMapCache).toBe(cacheAfterFirst);
    });

    it('getConceptsInCategory warms the concept-id map cache', () => {
        const c = clientWithProfile();
        expect((c as any)._conceptMapCache).toBeNull();
        c.getConceptsInCategory('level');
        const cacheAfterCategory = (c as any)._conceptMapCache;
        expect(cacheAfterCategory).not.toBeNull();
        // findConcept must reuse the same map object, no rebuild
        c.findConcept('U');
        expect((c as any)._conceptMapCache).toBe(cacheAfterCategory);
    });

    it('getSchemeMeta throws when no profile is loaded', () => {
        const c = new SchemeProfileState();
        expect(() => c.getSchemeMeta()).toThrow(EzClassifyError);
        expect(() => c.getSchemeMeta()).toThrow(/No profile cached/);
    });
});

// -----------------------------------------------------------------------
// getSchemeMeta
// -----------------------------------------------------------------------
describe('SchemeState.getSchemeMeta()', () => {
    it('returns the correct id, version, name and description', () => {
        const c = clientWithProfile();
        const meta = c.getSchemeMeta();
        expect(meta.id).toBe('test-scheme');
        expect(meta.version).toBe('1.0.0');
        expect(meta.name).toBe('Test Scheme');
        expect(meta.description).toBe('Used in scheme-state tests');
        expect(meta).not.toHaveProperty('mode');
    });

    it('returns the full render configuration, not just format ids', () => {
        // UI layers read `conceptProperty` to choose which concept view to
        // display and `categorySeparator` to split a typed marking. Projecting
        // ids alone left both undefined and sent every REST-backed field to its
        // 'default' / '//' fallback while a local engine rendered correctly.
        const c = clientWithProfile();
        const meta = c.getSchemeMeta();
        expect(meta.formats).toEqual([
            {
                id: 'default',
                surface: 'marking',
                mode: 'inline',
                view: 'default',
                prefix: '[',
                suffix: ']',
                separator: '//',
                categoryOrder: ['level', 'caveat'],
                categorySeparators: { caveat: '/' },
                separatorBefore: { caveat: '//' },
                categoryViews: { caveat: 'short' },
                categoryTiers: {
                    caveat: [
                        { tier: 'detail', attachedBy: '-', view: 'short' },
                    ],
                },
                categoryEach: { caveat: { prefix: '(', suffix: ')' } },
                headers: [
                    {
                        concept: 'REL',
                        headerCategory: 'caveat',
                        category: 'level',
                        position: 'prefix',
                    },
                ],
            },
        ]);
    });

    it('returns detached nested format layouts', () => {
        const c = clientWithProfile();
        const format = c.getSchemeMeta().formats?.[0];
        expect(format).toBeDefined();
        format!.categoryOrder.push('mutated');
        format!.categorySeparators!.caveat = 'mutated';
        format!.categoryTiers!.caveat[0].attachedBy = 'mutated';
        format!.categoryEach!.caveat.prefix = 'mutated';
        format!.headers![0].concept = 'mutated';

        expect(c.getSchemeMeta().formats).toEqual(
            FORMATS.map(({ syntax: _syntax, ...layout }) => layout),
        );
    });

    it('returns defaultRenderFormat', () => {
        const c = clientWithProfile();
        const meta = c.getSchemeMeta();
        expect(meta.defaultRenderFormat).toBe('default');
    });

    it('names the default scope once, in defaultScope, and on no scope', () => {
        const c = clientWithProfile({
            defaultScope: 'office_record',
            scopes: [
                { id: 'marking', label: 'Marking' },
                { id: 'office_record', label: 'Office Record' },
            ],
        });
        const meta = c.getSchemeMeta();
        expect(meta.defaultScope).toBe('office_record');
        // Strict, so a scope that carries any member besides its id and
        // label, even one left undefined, fails here.
        expect(meta.scopes).toStrictEqual([
            { id: 'marking', label: 'Marking' },
            { id: 'office_record', label: 'Office Record' },
        ]);
    });

    it('derives the part and whole render formats from contextFormats', () => {
        const c = clientWithProfile({
            contextFormats: { whole: ['banner'], part: ['portion'] },
        });
        const meta = c.getSchemeMeta();
        expect(meta.defaultPartRenderFormat).toBe('portion');
        expect(meta.defaultWholeRenderFormat).toBe('banner');
    });

    it('falls back to defaultRenderFormat when the scheme declares no contextFormats', () => {
        const meta = clientWithProfile().getSchemeMeta();
        expect(meta.defaultPartRenderFormat).toBe('default');
        expect(meta.defaultWholeRenderFormat).toBe('default');
    });

    it('maps label presets to id, label, and description', () => {
        const c = clientWithProfile({
            labelPresets: [
                {
                    id: 'quick',
                    label: 'Quick',
                    description: 'A shortcut',
                    scope: 'marking',
                },
            ],
        });
        expect(c.getSchemeMeta().labelPresets).toEqual([
            { id: 'quick', label: 'Quick', description: 'A shortcut' },
        ]);
    });

    it('reports no label presets as undefined, not an empty array', () => {
        // The label-presets sub-resource answers `[]` for a scheme that
        // declares none, where a scheme document omits the key entirely. Both
        // mean "no presets", but `[]` and `undefined` behave differently at a
        // call site, so the empty case collapses to the absent one.
        expect(
            clientWithProfile({ labelPresets: [] }).getSchemeMeta()
                .labelPresets,
        ).toBeUndefined();
    });
});

// -----------------------------------------------------------------------
// listCategories
// -----------------------------------------------------------------------
describe('SchemeState.listCategories()', () => {
    it.each([
        'ORIGIN',
        {
            concept: 'ORIGIN',
            when: { all: [{ category: 'level', is: 'has_content' }] },
        },
    ])(
        'retains the declared default concept expression %j',
        (defaultConcept) => {
            const c = clientWithProfile({
                categories: [{ ...PROFILE.categories[0], defaultConcept }],
            });

            expect(c.listCategories()[0].defaultConcept).toEqual(
                defaultConcept,
            );
        },
    );

    it('retains category-specific positions in category views', () => {
        const c = clientWithProfile({
            categories: [
                { ...PROFILE.categories[0], positionOverrides: { S: 0 } },
            ],
        });
        expect(c.listCategories()[0].positionOverrides).toEqual({ S: 0 });
    });
    it('returns one view per category', () => {
        const c = clientWithProfile();
        const cats = c.listCategories();
        expect(cats).toHaveLength(2);
    });

    it('maps id and label correctly', () => {
        const c = clientWithProfile();
        const cats = c.listCategories();
        const level = cats.find((cat) => cat.id === 'level');
        expect(level).toBeDefined();
        expect(level!.label).toBe('Classification Level');
    });

    it('maps required and single flags', () => {
        const c = clientWithProfile();
        const cats = c.listCategories();
        const level = cats.find((cat) => cat.id === 'level')!;
        expect(level.required).toBe(true);
        expect(level.single).toBe(true);
    });

    it('throws when no profile is loaded', () => {
        const c = new SchemeProfileState();
        expect(() => c.listCategories()).toThrow(EzClassifyError);
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: flat
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): flat', () => {
    it('returns concepts belonging to the requested category', () => {
        const c = clientWithProfile();
        const concepts = c.getConceptsInCategory('level');
        const ids = concepts.map((cv: any) => cv.id);
        expect(ids).toContain('U');
        expect(ids).toContain('C');
        expect(ids).toContain('S');
        expect(ids).not.toContain('NF');
    });

    it('returns concepts for the caveat category separately', () => {
        const c = clientWithProfile();
        const concepts = c.getConceptsInCategory('caveat');
        const ids = concepts.map((cv: any) => cv.id);
        expect(ids).toContain('NF');
        expect(ids).toContain('REL');
        expect(ids).not.toContain('U');
    });

    it('returns empty array for an unknown category', () => {
        const c = clientWithProfile();
        const concepts = c.getConceptsInCategory('does-not-exist');
        expect(concepts).toEqual([]);
    });

    it('sorts by position when sort = "position"', () => {
        const c = clientWithProfile();
        const concepts = c.getConceptsInCategory('level');
        const ids = concepts.map((cv: any) => cv.id);
        // position: U=0, C=1, S=2
        expect(ids).toEqual(['U', 'C', 'S']);
    });

    it('applies category-specific positions and then the declared alphabetical tie-breaker', () => {
        const concepts = [
            {
                ...PROFILE.concepts[0],
                id: 'anchor',
                name: 'Zulu',
                position: -100,
                categories: ['first', 'second'],
            },
            {
                ...PROFILE.concepts[0],
                id: 'early',
                name: 'Alpha',
                position: 0,
                categories: ['first', 'second'],
            },
            {
                ...PROFILE.concepts[0],
                id: 'group',
                name: 'Group',
                position: 1000,
                categories: ['first', 'second'],
            },
        ];
        const c = clientWithProfile({
            concepts,
            categories: [
                {
                    ...PROFILE.categories[0],
                    id: 'first',
                    sort: ['position', 'alphabetical'],
                    positionOverrides: { anchor: 0 },
                },
                {
                    ...PROFILE.categories[0],
                    id: 'second',
                    sort: ['position', 'alphabetical'],
                },
            ],
        });
        expect(c.getConceptsInCategory('first').map((one) => one.id)).toEqual([
            'early',
            'anchor',
            'group',
        ]);
        expect(c.getConceptsInCategory('second').map((one) => one.id)).toEqual([
            'anchor',
            'early',
            'group',
        ]);
        expect(concepts[0].position).toBe(-100);
    });

    it('returned views include id, name, views, aliases', () => {
        const c = clientWithProfile();
        const concepts = c.getConceptsInCategory('level');
        const u = concepts.find((cv: any) => cv.id === 'U');
        expect(u).toBeDefined();
        expect(u!.name).toBe('Unclassified');
        expect((u as any).views).toEqual({
            default: 'U',
            banner: 'UNCLASSIFIED',
        });
        expect((u as any).aliases).toContain('unclassified');
    });

    it('carries color and textInput through to the concept view', () => {
        // Both arrive on the wire and both drive rendering: `color` paints the
        // badge, `textInput` labels a capture-value field. The view is carried
        // as sent, so a REST-backed UI renders what a locally backed one does.
        const c = clientWithProfile({
            concepts: [
                {
                    id: 'DATE',
                    name: 'Declassify On',
                    views: { default: '{value}' },
                    aliases: [],
                    categories: ['level'],
                    parents: [],
                    position: 0,
                    color: { background: '#123456', text: '#ffffff' },
                    textInput: {
                        placeholder: 'YYYYMMDD',
                        label: 'Declassify On',
                        required: true,
                    },
                },
            ],
        });
        const view = c.getConceptsInCategory('level')[0]!;
        expect(view.color).toEqual({ background: '#123456', text: '#ffffff' });
        expect(view.textInput).toEqual({
            placeholder: 'YYYYMMDD',
            label: 'Declassify On',
            required: true,
        });
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: nested
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): nested', () => {
    it('returns concept + depth pairs', () => {
        const c = clientWithProfile();
        const nested = c.getConceptsInCategory('level', { nested: true });
        expect(Array.isArray(nested)).toBe(true);
        const first = nested[0] as { concept: { id: string }; depth: number };
        expect(first).toHaveProperty('concept');
        expect(first).toHaveProperty('depth');
    });

    it('assigns depth 0 to root concepts', () => {
        const c = clientWithProfile();
        const nested = c.getConceptsInCategory('level', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        const u = nested.find((n) => n.concept.id === 'U');
        expect(u).toBeDefined();
        expect(u!.depth).toBe(0);
    });

    it('assigns depth 1 to direct children', () => {
        const c = clientWithProfile();
        const nested = c.getConceptsInCategory('level', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        const cNode = nested.find((n) => n.concept.id === 'C');
        expect(cNode).toBeDefined();
        expect(cNode!.depth).toBe(1);
    });

    it('assigns depth 2 to grandchildren', () => {
        const c = clientWithProfile();
        const nested = c.getConceptsInCategory('level', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        const s = nested.find((n) => n.concept.id === 'S');
        expect(s).toBeDefined();
        expect(s!.depth).toBe(2);
    });
});

// -----------------------------------------------------------------------
// findConcept
// -----------------------------------------------------------------------
describe('SchemeState.findConcept()', () => {
    it('finds a concept by id', () => {
        const c = clientWithProfile();
        const concept = c.findConcept('U');
        expect(concept).toBeDefined();
        expect(concept!.name).toBe('Unclassified');
    });

    it('finds a concept by view string', () => {
        const c = clientWithProfile();
        const concept = c.findConcept('UNCLASSIFIED');
        expect(concept).toBeDefined();
        expect(concept!.id).toBe('U');
    });

    it('finds a concept by alias', () => {
        const c = clientWithProfile();
        const concept = c.findConcept('conf');
        expect(concept).toBeDefined();
        expect(concept!.id).toBe('C');
    });

    it('returns undefined for an unknown query string', () => {
        const c = clientWithProfile();
        expect(c.findConcept('ZZZZZZ')).toBeUndefined();
    });

    it('id lookup takes priority over view string lookup', () => {
        // The concept map is keyed by id, so an id match short-circuits view search
        const c = clientWithProfile();
        const concept = c.findConcept('S');
        expect(concept!.id).toBe('S');
    });

    it('view lookup takes priority over alias lookup', () => {
        const c = clientWithProfile();
        installProfile(c, {
            ...PROFILE,
            concepts: [
                {
                    ...PROFILE.concepts[0],
                    id: 'VIEWER',
                    views: { default: 'shared' },
                    aliases: [],
                },
                {
                    ...PROFILE.concepts[1],
                    id: 'ALIASER',
                    views: { default: 'other' },
                    aliases: ['shared'],
                },
            ],
        });
        expect(c.findConcept('shared')!.id).toBe('VIEWER');
    });

    it('resolves a duplicated view value to the first concept that declares it', () => {
        const c = clientWithProfile();
        installProfile(c, {
            ...PROFILE,
            concepts: [
                {
                    ...PROFILE.concepts[0],
                    id: 'FIRST',
                    views: { default: 'dup' },
                    aliases: [],
                },
                {
                    ...PROFILE.concepts[1],
                    id: 'SECOND',
                    views: { default: 'dup' },
                    aliases: [],
                },
            ],
        });
        expect(c.findConcept('dup')!.id).toBe('FIRST');
    });

    it('answers from the new profile after a swap, not the old index', () => {
        const c = clientWithProfile();
        expect(c.findConcept('UNCLASSIFIED')!.id).toBe('U');
        installProfile(c, {
            ...PROFILE,
            concepts: [
                {
                    ...PROFILE.concepts[0],
                    id: 'OPEN',
                    views: { default: 'O', banner: 'OPEN' },
                    aliases: ['open'],
                },
            ],
        });
        expect(c.findConcept('UNCLASSIFIED')).toBeUndefined();
        expect(c.findConcept('OPEN')!.id).toBe('OPEN');
        expect(c.findConcept('open')!.id).toBe('OPEN');
    });
});

// -----------------------------------------------------------------------
// getCategory
// -----------------------------------------------------------------------
describe('SchemeState.getCategory()', () => {
    it('returns the category for a known id', () => {
        const c = clientWithProfile();
        const cat = c.getCategory('level');
        expect(cat).toBeDefined();
        expect(cat!.label).toBe('Classification Level');
    });

    it('returns undefined for an unknown id', () => {
        const c = clientWithProfile();
        expect(c.getCategory('nonexistent')).toBeUndefined();
    });
});

// -----------------------------------------------------------------------
// uncoveredAssertions
// -----------------------------------------------------------------------
describe('SchemeState.uncoveredAssertions()', () => {
    it('returns an empty array when all candidates are in the parent', () => {
        const c = clientWithProfile();
        const candidates = [{ conceptId: 'NF', categoryId: 'caveat' }];
        const parent = [{ conceptId: 'NF', categoryId: 'caveat' }];
        const uncovered = c.uncoveredAssertions(candidates, parent);
        expect(uncovered).toEqual([]);
    });

    it('returns candidates not present in the parent', () => {
        const c = clientWithProfile();
        const candidates = [
            { conceptId: 'NF', categoryId: 'caveat' },
            { conceptId: 'REL', categoryId: 'caveat' },
        ];
        const parent = [{ conceptId: 'NF', categoryId: 'caveat' }];
        const uncovered = c.uncoveredAssertions(candidates, parent);
        expect(uncovered).toEqual([{ conceptId: 'REL', categoryId: 'caveat' }]);
    });

    it('covers a lower-rank candidate when parent has a higher-rank concept (max rollup)', () => {
        // Category 'level' has rollup: 'max'. If parent has S (rank 2) and
        // candidate has U (rank 0), the candidate is covered.
        const c = clientWithProfile();
        const candidates = [{ conceptId: 'U', categoryId: 'level' }];
        const parent = [{ conceptId: 'S', categoryId: 'level' }];
        const uncovered = c.uncoveredAssertions(candidates, parent);
        expect(uncovered).toEqual([]);
    });

    it('does not cover a higher-rank candidate when parent has a lower-rank concept', () => {
        const c = clientWithProfile();
        const candidates = [{ conceptId: 'S', categoryId: 'level' }];
        const parent = [{ conceptId: 'U', categoryId: 'level' }];
        const uncovered = c.uncoveredAssertions(candidates, parent);
        expect(uncovered).toEqual([{ conceptId: 'S', categoryId: 'level' }]);
    });

    it('returns all candidates when parent is empty', () => {
        const c = clientWithProfile();
        const candidates = [
            { conceptId: 'NF', categoryId: 'caveat' },
            { conceptId: 'REL', categoryId: 'caveat' },
        ];
        const uncovered = c.uncoveredAssertions(candidates, []);
        expect(uncovered).toHaveLength(2);
    });

    it('returns empty array when candidates is empty', () => {
        const c = clientWithProfile();
        const uncovered = c.uncoveredAssertions(
            [],
            [{ conceptId: 'NF', categoryId: 'caveat' }],
        );
        expect(uncovered).toEqual([]);
    });

    it('treats hierarchyRoot:true category as rank-ordered', () => {
        // hierarchyRoot is the other flag (besides rollup:max) that enables rank coverage
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'L',
                    name: 'Low',
                    views: {},
                    aliases: [],
                    categories: ['hr-cat'],
                    parents: [],
                    position: 0,
                    rank: 0,
                },
                {
                    id: 'H',
                    name: 'High',
                    views: {},
                    aliases: [],
                    categories: ['hr-cat'],
                    parents: [],
                    position: 1,
                    rank: 1,
                },
            ],
            categories: [
                {
                    id: 'hr-cat',
                    label: 'HR',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    hierarchyRoot: true,
                },
            ],
        };
        // H (rank 1) in parent should cover L (rank 0) in candidates
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'L', categoryId: 'hr-cat' }],
            [{ conceptId: 'H', categoryId: 'hr-cat' }],
        );
        expect(uncovered).toEqual([]);
    });

    it('unknown category in candidate is not rank-ordered: strict key match required', () => {
        const c = clientWithProfile();
        // 'unknown-cat' is not in the profile → isRankOrdered returns false
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'X', categoryId: 'unknown-cat' }],
            [{ conceptId: 'Y', categoryId: 'unknown-cat' }],
        );
        // Y does not match X by key, and category is not rank-ordered, so X is uncovered
        expect(uncovered).toEqual([
            { conceptId: 'X', categoryId: 'unknown-cat' },
        ]);
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: sort variants
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): sort variants', () => {
    it('sorts alphabetically when sort = "alphabetical"', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'Z',
                    name: 'Zebra',
                    views: {},
                    aliases: [],
                    categories: ['alpha-cat'],
                    parents: [],
                    position: 2,
                },
                {
                    id: 'A',
                    name: 'Apple',
                    views: {},
                    aliases: [],
                    categories: ['alpha-cat'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'M',
                    name: 'Mango',
                    views: {},
                    aliases: [],
                    categories: ['alpha-cat'],
                    parents: [],
                    position: 1,
                },
            ],
            categories: [
                {
                    id: 'alpha-cat',
                    label: 'Alpha',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: 'alphabetical' as const,
                },
            ],
        };
        const concepts = c.getConceptsInCategory('alpha-cat');
        const names = concepts.map((cv: any) => cv.name);
        expect(names).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('sorts numerically when sort = "numeric" using views.default', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'T30',
                    name: 'Thirty',
                    views: { default: '30' },
                    aliases: [],
                    categories: ['num-cat'],
                    parents: [],
                },
                {
                    id: 'T5',
                    name: 'Five',
                    views: { default: '5' },
                    aliases: [],
                    categories: ['num-cat'],
                    parents: [],
                },
                {
                    id: 'T10',
                    name: 'Ten',
                    views: { default: '10' },
                    aliases: [],
                    categories: ['num-cat'],
                    parents: [],
                },
            ],
            categories: [
                {
                    id: 'num-cat',
                    label: 'Numeric',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: 'numeric' as const,
                },
            ],
        };
        const concepts = c.getConceptsInCategory('num-cat');
        const names = concepts.map((cv: any) => cv.name);
        expect(names).toEqual(['Five', 'Ten', 'Thirty']);
    });

    it('sort as an array (["position"]) applies position sorting', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'B',
                    name: 'B',
                    views: {},
                    aliases: [],
                    categories: ['arr-cat'],
                    parents: [],
                    position: 2,
                },
                {
                    id: 'A',
                    name: 'A',
                    views: {},
                    aliases: [],
                    categories: ['arr-cat'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'C',
                    name: 'C',
                    views: {},
                    aliases: [],
                    categories: ['arr-cat'],
                    parents: [],
                    position: 1,
                },
            ],
            categories: [
                {
                    id: 'arr-cat',
                    label: 'Arr',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: ['position'] as any,
                },
            ],
        };
        const concepts = c.getConceptsInCategory('arr-cat');
        const ids = concepts.map((cv: any) => cv.id);
        expect(ids).toEqual(['A', 'C', 'B']);
    });

    it('returns unsorted (insertion order) when category has no sort config', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'X3',
                    name: 'X3',
                    views: {},
                    aliases: [],
                    categories: ['nosort'],
                    parents: [],
                    position: 2,
                },
                {
                    id: 'X1',
                    name: 'X1',
                    views: {},
                    aliases: [],
                    categories: ['nosort'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'X2',
                    name: 'X2',
                    views: {},
                    aliases: [],
                    categories: ['nosort'],
                    parents: [],
                    position: 1,
                },
            ],
            categories: [
                {
                    id: 'nosort',
                    label: 'No Sort',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                },
            ],
        };
        const concepts = c.getConceptsInCategory('nosort');
        const ids = concepts.map((cv: any) => cv.id);
        // No sort config → filter preserves original array order: X3, X1, X2
        expect(ids).toEqual(['X3', 'X1', 'X2']);
    });
});

// -----------------------------------------------------------------------
// getSchemeMeta: scopes and optional fields
// -----------------------------------------------------------------------
describe('SchemeState.getSchemeMeta(): optional fields', () => {
    it('maps scopes to {id, label} pairs', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            scopes: [
                { id: 'ts', label: 'TOP SECRET' },
                { id: 's', label: 'SECRET' },
            ],
        };
        const meta = c.getSchemeMeta();
        expect(meta.scopes).toEqual([
            { id: 'ts', label: 'TOP SECRET' },
            { id: 's', label: 'SECRET' },
        ]);
    });

    it('scopes is undefined when not present', () => {
        const c = clientWithProfile();
        const meta = c.getSchemeMeta();
        expect(meta.scopes).toBeUndefined();
    });

    it('description is undefined when not set on the profile', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = { ...PROFILE, description: undefined };
        const meta = c.getSchemeMeta();
        expect(meta.description).toBeUndefined();
    });
});

// -----------------------------------------------------------------------
// Concept views are carried as the wire sends them
// -----------------------------------------------------------------------
describe('SchemeState: concept views as sent', () => {
    it('returns definition, guidance, citation and notices exactly as the view carries them', () => {
        const notice = {
            type: 'handling',
            required: true,
            text: 'Handle with care.',
        };
        const documented = {
            id: 'D',
            name: 'Documented',
            views: { default: 'D' },
            aliases: [],
            categories: ['level'],
            parents: [],
            position: 0,
            definition: 'A definition',
            guidance: 'Some guidance',
            citation: 'Source section 3',
            notices: [notice],
        };
        const c = clientWithProfile({ concepts: [documented] });
        expect(c.getConceptsInCategory('level')).toEqual([documented]);
        expect(c.findConcept('D')).toEqual(documented);
    });

    it('leaves definition and guidance undefined when the view sends none', () => {
        const u = clientWithProfile()
            .getConceptsInCategory('level')
            .find((cv) => cv.id === 'U');
        expect(u?.definition).toBeUndefined();
        expect(u?.guidance).toBeUndefined();
    });

    it('lists categories as the view sends them, position included', () => {
        expect(clientWithProfile().listCategories()).toEqual(
            PROFILE.categories,
        );
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: nested, orphan handling
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): nested, edge cases', () => {
    it('orphan concept (parent outside category) lands at depth 0', () => {
        // Child refers to parent 'EXT' which is not in the same category.
        // isRoot(child) should be true → child gets depth 0.
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'ROOT',
                    name: 'Root',
                    views: {},
                    aliases: [],
                    categories: ['oc'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'CHILD',
                    name: 'Child',
                    views: {},
                    aliases: [],
                    categories: ['oc'],
                    parents: ['EXT'],
                    position: 1,
                },
            ],
            categories: [
                {
                    id: 'oc',
                    label: 'OC',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                },
            ],
        };
        const nested = c.getConceptsInCategory('oc', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        const child = nested.find((n) => n.concept.id === 'CHILD');
        expect(child).toBeDefined();
        expect(child!.depth).toBe(0);
    });

    it('DFS visits all concepts even with a multi-child root', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'R',
                    name: 'Root',
                    views: {},
                    aliases: [],
                    categories: ['mc'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'C1',
                    name: 'Child1',
                    views: {},
                    aliases: [],
                    categories: ['mc'],
                    parents: ['R'],
                    position: 1,
                },
                {
                    id: 'C2',
                    name: 'Child2',
                    views: {},
                    aliases: [],
                    categories: ['mc'],
                    parents: ['R'],
                    position: 2,
                },
            ],
            categories: [
                {
                    id: 'mc',
                    label: 'MC',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                },
            ],
        };
        const nested = c.getConceptsInCategory('mc', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        expect(nested).toHaveLength(3);
        const root = nested.find((n) => n.concept.id === 'R');
        const c1 = nested.find((n) => n.concept.id === 'C1');
        const c2 = nested.find((n) => n.concept.id === 'C2');
        expect(root!.depth).toBe(0);
        expect(c1!.depth).toBe(1);
        expect(c2!.depth).toBe(1);
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: sort fallbacks
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): sort fallbacks', () => {
    it('unknown sort type leaves insertion order unchanged', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'B',
                    name: 'B',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                    position: 1,
                },
                {
                    id: 'A',
                    name: 'A',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                    position: 0,
                },
            ],
            categories: [
                {
                    id: 'cat',
                    label: 'C',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: 'unknown-sort' as any,
                },
            ],
        };
        expect(c.getConceptsInCategory('cat').map((v: any) => v.id)).toEqual([
            'B',
            'A',
        ]);
    });

    it('position sort treats a missing position as 0', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'MID',
                    name: 'Mid',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                    position: 3,
                },
                {
                    id: 'Z',
                    name: 'Z',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                },
                {
                    id: 'HI',
                    name: 'High',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                    position: 5,
                },
            ],
            categories: [
                {
                    id: 'cat',
                    label: 'C',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: 'position' as const,
                },
            ],
        };
        // Z has no position → sorts as 0, before MID (3) and HI (5)
        expect(c.getConceptsInCategory('cat').map((v: any) => v.id)).toEqual([
            'Z',
            'MID',
            'HI',
        ]);
    });

    it('numeric sort treats missing and non-numeric default views as 0', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'TEN',
                    name: 'Ten',
                    views: { default: '10' },
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                },
                {
                    id: 'ND',
                    name: 'NoDefault',
                    views: {},
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                },
                {
                    id: 'BAD',
                    name: 'BadNum',
                    views: { default: 'x' },
                    aliases: [],
                    categories: ['cat'],
                    parents: [],
                },
            ],
            categories: [
                {
                    id: 'cat',
                    label: 'C',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                    sort: 'numeric' as const,
                },
            ],
        };
        // ND (no default view) and BAD (non-numeric) both sort as 0, before TEN
        const ids = c.getConceptsInCategory('cat').map((v: any) => v.id);
        expect(ids.indexOf('TEN')).toBeGreaterThan(ids.indexOf('ND'));
        expect(ids.indexOf('TEN')).toBeGreaterThan(ids.indexOf('BAD'));
    });
});

// -----------------------------------------------------------------------
// getConceptsInCategory: nested, parent cycles
// -----------------------------------------------------------------------
describe('SchemeState.getConceptsInCategory(): nested, parent cycles', () => {
    /** A profile with a single union category and the given concepts. */
    function cycleClient(concepts: unknown[]): SchemeProfileState {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts,
            categories: [
                {
                    id: 'cat',
                    label: 'C',
                    required: false,
                    single: false,
                    rollup: 'union' as const,
                },
            ],
        };
        return c;
    }

    it('mutual cycle (A→B, B→A) does not hang; each concept appears once', () => {
        const c = cycleClient([
            {
                id: 'A',
                name: 'A',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['B'],
                position: 0,
            },
            {
                id: 'B',
                name: 'B',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['A'],
                position: 1,
            },
        ]);
        const nested = c.getConceptsInCategory('cat', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        expect(nested).toHaveLength(2);
        expect(nested.find((n) => n.concept.id === 'A')).toBeDefined();
        expect(nested.find((n) => n.concept.id === 'B')).toBeDefined();
    });

    it('self-referencing concept (A→A) does not infinite-loop', () => {
        const c = cycleClient([
            {
                id: 'A',
                name: 'A',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['A'],
                position: 0,
            },
        ]);
        const nested = c.getConceptsInCategory('cat', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        expect(nested).toHaveLength(1);
    });

    it('three-node cycle (A→B→C→A) visits every concept exactly once', () => {
        const c = cycleClient([
            {
                id: 'A',
                name: 'A',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['C'],
                position: 0,
            },
            {
                id: 'B',
                name: 'B',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['A'],
                position: 1,
            },
            {
                id: 'C',
                name: 'C',
                views: {},
                aliases: [],
                categories: ['cat'],
                parents: ['B'],
                position: 2,
            },
        ]);
        const nested = c.getConceptsInCategory('cat', {
            nested: true,
        }) as Array<{ concept: { id: string }; depth: number }>;
        expect(nested).toHaveLength(3);
        const ids = nested.map((n) => n.concept.id);
        expect(ids).toContain('A');
        expect(ids).toContain('B');
        expect(ids).toContain('C');
    });
});

// -----------------------------------------------------------------------
// uncoveredAssertions: only a declared rank decides coverage
// -----------------------------------------------------------------------
describe('SchemeState.uncoveredAssertions(): rank resolution', () => {
    const MAX_CATEGORY = {
        id: 'ord',
        label: 'Ord',
        required: false,
        single: true,
        rollup: 'max' as const,
    };

    it('a concept with no declared rank is not covered by display position', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'LOW',
                    name: 'Low',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    position: 0,
                },
                {
                    id: 'HIGH',
                    name: 'High',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    position: 1,
                },
            ],
            categories: [MAX_CATEGORY],
        };
        // Position is display order, not severity. Neither concept declares a
        // rank, so nothing here says HIGH covers LOW.
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'LOW', categoryId: 'ord' }],
            [{ conceptId: 'HIGH', categoryId: 'ord' }],
        );
        expect(uncovered).toEqual([{ conceptId: 'LOW', categoryId: 'ord' }]);
    });

    it('a candidate whose concept the profile does not carry stays uncovered', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'H',
                    name: 'High',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    rank: 5,
                    position: 1,
                },
            ],
            categories: [MAX_CATEGORY],
        };
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'UNKNOWN', categoryId: 'ord' }],
            [{ conceptId: 'H', categoryId: 'ord' }],
        );
        expect(uncovered).toEqual([
            { conceptId: 'UNKNOWN', categoryId: 'ord' },
        ]);
    });

    it('a parent with no declared rank covers nothing', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'LOW',
                    name: 'Low',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    rank: 1,
                    position: 0,
                },
                {
                    id: 'UNRANKED',
                    name: 'Unranked',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    position: 9,
                },
            ],
            categories: [MAX_CATEGORY],
        };
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'LOW', categoryId: 'ord' }],
            [{ conceptId: 'UNRANKED', categoryId: 'ord' }],
        );
        expect(uncovered).toEqual([{ conceptId: 'LOW', categoryId: 'ord' }]);
    });

    it('a parent in a different category never covers a candidate', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            concepts: [
                {
                    id: 'X',
                    name: 'X',
                    views: {},
                    aliases: [],
                    categories: ['ord'],
                    parents: [],
                    rank: 2,
                    position: 1,
                },
                {
                    id: 'Y',
                    name: 'Y',
                    views: {},
                    aliases: [],
                    categories: ['other'],
                    parents: [],
                    rank: 5,
                    position: 0,
                },
            ],
            categories: [
                MAX_CATEGORY,
                {
                    id: 'other',
                    label: 'Other',
                    required: false,
                    single: true,
                    rollup: 'max' as const,
                },
            ],
        };
        // Y outranks X but sits in a different category, so X stays uncovered
        const uncovered = c.uncoveredAssertions(
            [{ conceptId: 'X', categoryId: 'ord' }],
            [{ conceptId: 'Y', categoryId: 'other' }],
        );
        expect(uncovered).toEqual([{ conceptId: 'X', categoryId: 'ord' }]);
    });
});

// -----------------------------------------------------------------------
// uncoveredAssertions: degenerate profile shapes
// -----------------------------------------------------------------------
describe('SchemeState.uncoveredAssertions(): degenerate profile shapes', () => {
    it('tolerates a profile with null concepts and categories', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = { concepts: null, categories: null };
        expect(c.uncoveredAssertions([], [])).toEqual([]);
    });

    it('returns all candidates as uncovered when no categories exist to establish rank order', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = { concepts: null, categories: null };

        const candidates = [
            {
                conceptId: 'A',
                categoryId: 'level',
                confidence: 'certain' as const,
                source: 'parse' as const,
            },
        ];
        expect(c.uncoveredAssertions(candidates, [])).toEqual(candidates);
    });
});

// -----------------------------------------------------------------------
// getScheme: Context-selected cached profile
// -----------------------------------------------------------------------
describe('SchemeState.getScheme()', () => {
    it('returns the cached Context profile', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = { ...PROFILE, id: 'my-id' };
        expect(c.getScheme().id).toBe('my-id');
    });
});

// -----------------------------------------------------------------------
// getSchemeMeta: absent formats and reference label
// -----------------------------------------------------------------------
describe('SchemeState.getSchemeMeta(): absent formats and label', () => {
    it('forwards referenceSurfaceLabel when present on the profile', () => {
        const c = new SchemeProfileState();
        (c as any)._profile = {
            ...PROFILE,
            referenceSurfaceLabel: {
                singular: 'CAPCO Manual',
                plural: 'CAPCO Manuals',
            },
        };
        expect(c.getSchemeMeta().referenceSurfaceLabel).toEqual({
            singular: 'CAPCO Manual',
            plural: 'CAPCO Manuals',
        });
    });

    it('formats is empty when the scheme declares no formats', () => {
        const c = clientWithProfile({ formats: [] });
        expect(c.getSchemeMeta().formats).toEqual([]);
    });
});
