import type {
    Assertion,
    SchemePublicView,
    ConceptView,
    CategoryView,
    FormatView,
    SchemeMetaView,
} from '@ezclassify/types';

/** The two arrays of the cached profile the query utilities read. */
type ProfileLike = Pick<SchemePublicView, 'concepts' | 'categories'>;

/**
 * Copy a format with every nested member detached from the cached profile, so a
 * caller that edits what it was handed cannot change the profile.
 */
function cloneFormat(format: FormatView): FormatView {
    return {
        ...format,
        ...(format.defaultFor ? { defaultFor: [...format.defaultFor] } : {}),
        categoryOrder: [...format.categoryOrder],
        ...(format.categorySeparators
            ? { categorySeparators: { ...format.categorySeparators } }
            : {}),
        ...(format.separatorBefore
            ? { separatorBefore: { ...format.separatorBefore } }
            : {}),
        ...(format.categoryViews
            ? { categoryViews: { ...format.categoryViews } }
            : {}),
        ...(format.categoryTiers
            ? {
                  categoryTiers: Object.fromEntries(
                      Object.entries(format.categoryTiers).map(
                          ([category, tiers]) => [
                              category,
                              tiers.map((tier) => ({ ...tier })),
                          ],
                      ),
                  ),
              }
            : {}),
        ...(format.categoryEach
            ? {
                  categoryEach: Object.fromEntries(
                      Object.entries(format.categoryEach).map(
                          ([category, each]) => [category, { ...each }],
                      ),
                  ),
              }
            : {}),
        ...(format.headers
            ? { headers: format.headers.map((header) => ({ ...header })) }
            : {}),
        ...(format.syntax ? { syntax: { ...format.syntax } } : {}),
    };
}

/**
 * Freeze a decoded JSON value and everything inside it.
 *
 * The cached profile is shared by every caller of the synchronous accessors, so
 * what they hand out has to be immutable: one component editing a concept it
 * was given would otherwise change the answer for every other. Freezing once
 * when the profile is installed costs nothing per call, where copying on every
 * read would copy the whole concept list for each `getScheme()`.
 *
 * @param value - A decoded JSON value, which has no cycles
 * @returns The same value, frozen
 * @internal
 */
export function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const member of Object.values(value)) deepFreeze(member);
    return Object.freeze(value);
}

/** Build a concept-id → concept lookup map for fast access. */
function buildConceptMap(profile: ProfileLike): Map<string, ConceptView> {
    return new Map(profile.concepts.map((c) => [c.id, c]));
}

/**
 * Build the secondary lookup a concept search falls back to: every view value
 * and every alias, pointing at the concept that declares it.
 *
 * First declaration wins: a value declared twice resolves to the earlier
 * concept.
 */
function buildConceptLookupIndex(profile: ProfileLike): {
    byView: Map<string, ConceptView>;
    byAlias: Map<string, ConceptView>;
} {
    const byView = new Map<string, ConceptView>();
    const byAlias = new Map<string, ConceptView>();
    for (const concept of profile.concepts) {
        for (const value of Object.values(concept.views ?? {})) {
            if (typeof value === 'string' && !byView.has(value)) {
                byView.set(value, concept);
            }
        }
        for (const alias of concept.aliases ?? []) {
            if (!byAlias.has(alias)) byAlias.set(alias, concept);
        }
    }
    return { byView, byAlias };
}

/**
 * Get all concepts belonging to a category, sorted by the category's sort
 * config.
 */
function getConceptsInCategory(
    profile: ProfileLike,
    categoryId: string,
): ConceptView[] {
    const category = profile.categories.find((f) => f.id === categoryId);
    const concepts = profile.concepts.filter((c) =>
        c.categories.includes(categoryId),
    );
    if (category?.sort) {
        const sortTypes = Array.isArray(category.sort)
            ? category.sort
            : [category.sort];
        const positions = new Map(
            Object.entries(category.positionOverrides ?? {}),
        );
        concepts.sort((a, b) => {
            for (const sort of sortTypes) {
                let by = 0;
                if (sort === 'position') {
                    by =
                        (positions.get(a.id) ?? a.position ?? 0) -
                        (positions.get(b.id) ?? b.position ?? 0);
                } else if (sort === 'alphabetical') {
                    by = a.name.localeCompare(b.name);
                } else if (sort === 'numeric') {
                    by =
                        (parseFloat(a.views['default'] ?? '0') || 0) -
                        (parseFloat(b.views['default'] ?? '0') || 0);
                }
                if (by !== 0) return by;
            }
            return 0;
        });
    }
    return concepts;
}

/**
 * Walk the in-category parent chain and return each concept with its depth (0 =
 * root, 1 = child, ...). DFS order; cycles traversed at most once; orphans land
 * at depth 0.
 */
function getConceptsInCategoryNested(
    profile: ProfileLike,
    categoryId: string,
): Array<{ concept: ConceptView; depth: number }> {
    const concepts = getConceptsInCategory(profile, categoryId);
    const byId = new Map(concepts.map((c) => [c.id, c]));
    const childrenByParent = new Map<string, ConceptView[]>();
    for (const c of concepts) {
        for (const pid of c.parents) {
            if (!byId.has(pid)) continue;
            const list = childrenByParent.get(pid) ?? [];
            list.push(c);
            childrenByParent.set(pid, list);
        }
    }
    const isRoot = (c: ConceptView): boolean =>
        !c.parents.some((pid) => byId.has(pid));
    const result: Array<{ concept: ConceptView; depth: number }> = [];
    const visited = new Set<string>();
    const walk = (c: ConceptView, depth: number): void => {
        if (visited.has(c.id)) return;
        visited.add(c.id);
        result.push({ concept: c, depth });
        const children = childrenByParent.get(c.id) ?? [];
        for (const child of children) walk(child, depth + 1);
    };
    for (const c of concepts) {
        if (isRoot(c)) walk(c, 0);
    }
    for (const c of concepts) {
        if (!visited.has(c.id)) walk(c, 0);
    }
    return result;
}

/**
 * Return the assertions in candidates that are not covered by parent. For
 * hierarchical categories (hierarchyRoot or max rollup), a parent concept whose
 * declared rank meets or exceeds a candidate's counts as covering it. Falls
 * back to strict concept-id inclusion for non-hierarchical categories.
 *
 * Only a declared rank takes part in the comparison. Display position is a
 * different ordering and answering from it would report coverage the scheme
 * never stated, so a concept the profile does not carry, or one that declares
 * no rank, leaves its candidate uncovered. A caller sees an item it has to
 * resolve rather than an item quietly dropped from the list.
 */
function uncoveredAssertions<
    A extends { conceptId: string; categoryId: string },
>(
    candidates: A[],
    parent: { conceptId: string; categoryId: string }[],
    profile: ProfileLike,
): A[] {
    const parentKey = (a: { conceptId: string; categoryId: string }) =>
        `${a.conceptId}::${a.categoryId}`;
    const parentKeys = new Set(parent.map(parentKey));
    // Built once per call: the filter below is nested, and rebuilding these by
    // scan would make the work candidates x parents x concepts.
    const rankById = new Map<string, number | undefined>(
        (profile.concepts ?? []).map((c) => [c.id, c.rank]),
    );
    const categoryById = new Map<string, CategoryView>(
        (profile.categories ?? []).map((c) => [c.id, c]),
    );

    const isRankOrdered = (catId: string): boolean => {
        const cat = categoryById.get(catId);
        if (!cat) return false;
        if (cat.hierarchyRoot === true) return true;
        return cat.rollup === 'max';
    };

    return candidates.filter((a) => {
        if (parentKeys.has(parentKey(a))) return false;
        if (!isRankOrdered(a.categoryId)) return true;
        const myRank = rankById.get(a.conceptId);
        if (myRank === undefined) return true;
        const covered = parent.some((p) => {
            if (p.categoryId !== a.categoryId) return false;
            const parentRank = rankById.get(p.conceptId);
            return parentRank !== undefined && parentRank >= myRank;
        });
        return !covered;
    });
}

/** Cached-profile state and the synchronous queries over it. */
export abstract class SchemeState {
    /** @internal */
    protected _profile: SchemePublicView | null = null;
    /** @internal */
    protected _conceptMapCache: Map<string, ConceptView> | null = null;
    /**
     * View values and aliases of the default profile, built with the concept
     * map and dropped with it.
     */
    private _conceptLookupCache: {
        byView: Map<string, ConceptView>;
        byAlias: Map<string, ConceptView>;
    } | null = null;

    /** Get (or lazily build) the cached concept map for the default profile. */
    protected getConceptMap(): Map<string, ConceptView> {
        if (!this._conceptMapCache) {
            const profile = this._loadProfile();
            this._conceptMapCache = buildConceptMap(profile);
        }
        return this._conceptMapCache;
    }

    /**
     * Get (or lazily build) the view/alias index for the default profile.
     *
     * Kept beside the concept map and invalidated with it, so a profile swap
     * cannot leave one of the two answering for the previous scheme.
     */
    private getConceptLookupIndex(): {
        byView: Map<string, ConceptView>;
        byAlias: Map<string, ConceptView>;
    } {
        if (!this._conceptLookupCache) {
            const profile = this._loadProfile();
            this._conceptLookupCache = buildConceptLookupIndex(profile);
        }
        return this._conceptLookupCache;
    }

    /** Invalidate the concept map cache (called on profile swap/reload). */
    protected invalidateConceptMap(): void {
        this._conceptMapCache = null;
        this._conceptLookupCache = null;
    }

    /**
     * Return the cached profile. Implemented by each adapter.
     *
     * @internal
     */
    protected abstract _loadProfile(): SchemePublicView;

    /**
     * Return the cached profile. Delegates to the subclass adapter.
     *
     * The profile and everything in it is frozen. Every caller shares it, so an
     * attempt to change a concept, category or format throws instead of
     * changing what the next caller reads. Copy the part you want to edit.
     */
    getScheme(): SchemePublicView {
        return this._loadProfile();
    }

    /**
     * Find a concept by ID, view string, or alias.
     *
     * Identity first, then a rendered view value, then an alias. All three go
     * through lazily built maps, so a typeahead calling this on every keystroke
     * does not rescan every concept.
     */
    findConcept(query: string): ConceptView | undefined {
        const byId = this.getConceptMap().get(query);
        if (byId) return byId;
        const { byView, byAlias } = this.getConceptLookupIndex();
        return byView.get(query) ?? byAlias.get(query);
    }

    /**
     * Return scheme identity and configuration metadata from the cached
     * profile.
     */
    getSchemeMeta(): SchemeMetaView {
        const p = this._loadProfile();
        return {
            id: p.id,
            version: p.version,
            name: p.name,
            description: p.description ?? undefined,
            definition: p.definition,
            guidance: p.guidance,
            marking: p.marking,
            colorFrom: p.colorFrom,
            colorRules: p.colorRules,
            defaultScope: p.defaultScope,
            scopeLabel: p.scopeLabel,
            roleAware: p.roleAware,
            vocabulary: p.vocabulary,
            referenceSurfaceLabel: p.referenceSurfaceLabel,
            // Which scope is the default is `defaultScope` above; no scope
            // carries a flag for it.
            scopes: p.scopes?.map((s) => ({ id: s.id, label: s.label })),
            // The profile's formats are the wire's format views. The encoding
            // discriminant (`syntax`) stays on FormatView; SchemeMetaView owns
            // display layout only, the same DTO a local adapter returns.
            formats: p.formats?.map((format) => {
                const { syntax: _syntax, ...layout } = cloneFormat(format);
                return layout;
            }),
            defaultRenderFormat: p.defaultRenderFormat,
            // A scheme that declares surfaces has its role defaults resolved
            // on the server from the default scope's surface `default`, and
            // the profile carries them. Only a scheme whose formats are its
            // outputs leaves them out, and the contract resolves those from
            // the first format `contextFormats` lists for the role.
            defaultPartRenderFormat:
                p.defaultPartRenderFormat ??
                p.contextFormats?.part?.[0] ??
                p.defaultRenderFormat,
            defaultWholeRenderFormat:
                p.defaultWholeRenderFormat ??
                p.contextFormats?.whole?.[0] ??
                p.defaultRenderFormat,
            // The profile always carries the list, `[]` for a scheme that
            // declares none. The metadata view keeps "no presets" as the
            // absent key, because `[]` and `undefined` are not interchangeable
            // at a call site (`meta.labelPresets ?? fallback`, `.map(...)`).
            labelPresets: p.labelPresets.length
                ? p.labelPresets.map((lp) => ({
                      id: lp.id,
                      label: lp.label,
                      description: lp.description,
                  }))
                : undefined,
        };
    }

    /**
     * Return resolved category views for every category in the cached profile.
     *
     * The list is the caller's own, so it may be sorted or filtered in place.
     * Each category in it is the profile's, frozen: see {@link getScheme}.
     */
    listCategories(): CategoryView[] {
        return [...this._loadProfile().categories];
    }

    /**
     * Get concepts in a category as resolved views, optionally with nesting
     * depth.
     */
    getConceptsInCategory(categoryId: string): ConceptView[];
    getConceptsInCategory(
        categoryId: string,
        options: { nested: true },
    ): Array<{ concept: ConceptView; depth: number }>;
    getConceptsInCategory(
        categoryId: string,
        options?: { nested?: boolean },
    ): ConceptView[] | Array<{ concept: ConceptView; depth: number }> {
        const nested = options?.nested === true;
        const profile = this._loadProfile();
        // Side-effect: warm the concept-id cache so a subsequent findConcept()
        // can skip the map build even when categories are queried first.
        this.getConceptMap();
        if (nested) {
            return getConceptsInCategoryNested(profile, categoryId);
        }
        return getConceptsInCategory(profile, categoryId);
    }

    /** Get a category by ID. */
    getCategory(categoryId: string): CategoryView | undefined {
        return this._loadProfile().categories.find((f) => f.id === categoryId);
    }

    /** Return assertions in candidates not covered by parent. */
    uncoveredAssertions(
        candidates: Assertion[],
        parent: Assertion[],
    ): Assertion[] {
        return uncoveredAssertions(candidates, parent, this._loadProfile());
    }
}
