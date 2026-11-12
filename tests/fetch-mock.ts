/* eslint-disable @typescript-eslint/no-explicit-any -- a fetch stub stands in
for a platform global and is typed loosely on purpose. */
import { vi } from 'vitest';

/** Build a mock Response object compatible with the fetch API. */
export function mockResponse(
    status: number,
    body: string | null,
    headers?: Record<string, string>,
): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: statusText(status),
        headers: new Headers(headers),
        text: () => Promise.resolve(body ?? ''),
        json: () => {
            if (!body)
                return Promise.reject(
                    new SyntaxError('Unexpected end of JSON input'),
                );
            try {
                return Promise.resolve(JSON.parse(body));
            } catch (e) {
                return Promise.reject(e);
            }
        },
    } as unknown as Response;
}

function statusText(code: number): string {
    const map: Record<number, string> = {
        200: 'OK',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        500: 'Internal Server Error',
    };
    return map[code] ?? 'Unknown';
}

/**
 * The six ctx-scoped scheme sub-resources a context-bound connect reads to warm
 * its profile, and the bodies a server answers them with.
 *
 * Every context-bound connect fetches all six, so a fetch stub that does not
 * answer them assembles a profile out of whatever it did answer. Keeping the
 * shapes in one place means a test that only cares about guides does not have
 * to invent a scheme.
 */
const CTX_SCHEME_RESOURCES: ReadonlyArray<[suffix: string, body: unknown]> = [
    ['/scheme/concepts', [] as unknown[]],
    ['/scheme/categories', [] as unknown[]],
    [
        '/scheme/formats',
        [
            {
                id: 'default',
                surface: 'marking',
                mode: 'inline',
                view: 'default',
                categoryOrder: [],
                separator: ' ',
                syntax: { type: 'text' },
            },
        ],
    ],
    ['/scheme/scopes', [] as unknown[]],
    ['/scheme/label-presets', [] as unknown[]],
];

/**
 * Body for one of the ctx-scoped scheme sub-resources, or `undefined` when the
 * URL names something else. `schemeId` is the id the summary reports, which is
 * what the assembled profile is keyed by.
 */
export function ctxSchemeResourceBody(
    url: string,
    schemeId = 'levels',
): unknown | undefined {
    const path = url.split('?', 1)[0] ?? '';
    for (const [suffix, body] of CTX_SCHEME_RESOURCES) {
        if (path.endsWith(suffix)) return body;
    }
    if (path.endsWith('/scheme')) {
        return {
            id: schemeId,
            version: '1.0.0',
            name: schemeId,
            description: '',
            referenceSurfaceLabel: { singular: 'Guide', plural: 'Guides' },
            defaultRenderFormat: 'default',
        };
    }
    return undefined;
}

/** Stub globalThis.fetch with a vi.fn() and return the stub. */
export function stubFetch(): ReturnType<typeof vi.fn> {
    const fn = vi.fn();
    globalThis.fetch = fn as any;
    return fn;
}
