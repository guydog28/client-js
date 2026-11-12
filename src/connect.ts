import { EzClassifyClient } from './ezclassify-client';
import type { EzClassifyClientOptions } from './ezclassify-client';
import { ErrorCodes, EzClassifyError } from './errors';

/**
 * Arguments for {@link connectContext}: where the deployment is, which published
 * Context to bind to, and the client options.
 *
 * `contextId` is required. A Context-bound client routes every operation
 * through `/v1/ctx/{contextId}/*`, so an unbound connection would have nothing
 * to answer with; it fails here rather than on its first call. Omit
 * `contextVersion` to let the server choose: the Context token's default, or
 * the newest published.
 */
export type ConnectContextArgs = Omit<EzClassifyClientOptions, 'contextId'> & {
    /** Base URL of the EzClassify REST API (e.g. `https://api.example/`). */
    baseUrl: string;
    /** Id of the published Context to bind to. */
    contextId: string;
};

/**
 * Connect to an EzClassify REST API and return a ready {@link EzClassifyClient}
 * bound to one published Context.
 *
 * The returned client exposes scheme, guide, access, and composed Context
 * operations:
 *
 * ```ts
 * import { connectContext } from '@ezclassify/rest-client';
 *
 * const client = await connectContext({
 *     baseUrl,
 *     contextId,
 *     contextVersion,
 *     applicationId: 'case-intake-portal',
 *     auth: { token: () => session.getAccessToken() },
 * });
 * const result = await client.scheme.process('LOW');
 * ```
 *
 * @param args - Connection arguments, including the Context binding and the
 *   caller credential
 * @returns A connected client bound to the named Context
 * @throws {EzClassifyError} With `INVALID_INPUT` when `contextId` is missing. A
 *   failed connection rejects with the failure's own code.
 */
export async function connectContext(
    args: ConnectContextArgs,
): Promise<EzClassifyClient> {
    const { baseUrl, ...options } = args;
    if (typeof options.contextId !== 'string' || options.contextId === '') {
        throw new EzClassifyError(
            'connectContext: `contextId` is required; a connection binds to one published Context.',
            ErrorCodes.INVALID_INPUT,
        );
    }
    const client = new EzClassifyClient(baseUrl, options);
    await client._open();
    return client;
}
