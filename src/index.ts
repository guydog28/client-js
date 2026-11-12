/**
 * @ezclassify/rest-client: thin TypeScript client for EzClassify REST
 * deployments.
 *
 * Exposes the shared adapter contract over native fetch, with LRU caching. It
 * has no dependency on the embedded engine.
 */

export { EzClassifyClient } from './ezclassify-client';
export type {
    AccessTokenSupplier,
    ClientAuth,
    ContextComponentRef,
    ContextDescription,
    ContextTokenSupplier,
    EzClassifyClientOptions,
    PingResult,
    TokenRequest,
} from './ezclassify-client';
export { EzClassifyError, ErrorCodes } from './errors';
export type { ErrorCode } from './errors';
export { connectContext } from './connect';
export type { ConnectContextArgs } from './connect';
export type {
    AggregateResult,
    ExplanationTrace,
    ProcessResult,
    ScanLimits,
    ScanOutcome,
    ScanResult,
    SuggestResult,
    SuggestResultsByCategory,
    ValidateResult,
} from '@ezclassify/types';
